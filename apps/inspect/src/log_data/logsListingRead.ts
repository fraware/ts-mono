import type {
  Condition,
  OrderByModel,
  Pagination,
} from "@tsmono/inspect-common/query";
import { ensureTrailingSlash, isInDirectory } from "@tsmono/util";

import type { Log } from "../client/api/types";
import { scopePrefix } from "../client/database";
import {
  pageRows,
  type DatabaseListingPlan,
  type DatabaseListingResult,
} from "../client/database/listing";
import { directoryRelativeUrl, rootName } from "../utils/uri";

import { getDatabaseService } from "./databaseServiceInstance";
import { createListingPlan } from "./listing/planner";
import type {
  FilterTypeAccessor,
  ValueAccessor,
  ValueComparator,
} from "./listing/types";
import { computeLogsWithRetried, type LogListingRow } from "./logListing";
import { getLogRows, isCacheOnlyListingScope } from "./logsContent";
import { logsListingEpoch } from "./logsListingEpoch";

/**
 * Where listing queries for `logDir` read their rows — an explicit,
 * scope-level decision rather than a per-query fallback:
 *
 * - "database": the normal dir-mode path; IndexedDB holds the replicated
 *   rows and is the row source.
 * - "cache": the react-query logs cache is the row source. This serves the
 *   out-of-namespace degrade (listing persistence skipped — see
 *   `namesInScope` in logsContent) and db-less sessions (the database
 *   failed to open; single-file mode renders no log list at all).
 */
const logsListingSource = (logDir: string): "database" | "cache" =>
  getDatabaseService().opened() && !isCacheOnlyListingScope(logDir)
    ? "database"
    : "cache";

const scanRows = async (logDir: string, prefix: string): Promise<Log[]> => {
  if (logsListingSource(logDir) === "database") {
    const logs = await getDatabaseService().readLogs({ prefix });
    if (logs !== null) return logs;
    // `readLogs` swallows store errors to null. Don't degrade to the cache
    // mirror: it can be GC'd empty, and the snapshot cache would then serve
    // "no items" as a durable success over a populated database —
    // indistinguishable from mass deletion (the same rationale as
    // readLogRows' no-catch). Reject so the listing query settles in error
    // and the retry/banner path owns recovery.
    throw new Error("Reading the log listing from the local database failed");
  }
  // An out-of-namespace scope's names never start with the scope prefix —
  // that mismatch is what degraded it (see `namesInScope`) — so filtering
  // would drop every row. Serve the whole listing; `toRow` owns membership.
  if (isCacheOnlyListingScope(logDir)) return getLogRows(logDir);
  const scope = scopePrefix(prefix);
  return getLogRows(logDir).filter((row) => row.name.startsWith(scope));
};

/**
 * Run a listing plan over `logDir`'s rows: scan the source, mark retried
 * runs (a cross-row derivation, so it runs over the scan, before `toRow`),
 * shape each record through `toRow` (which owns row-universe membership —
 * it drops records the view has no row for), then filter and sort. Each
 * surviving row is returned beside its source record: the snapshot build
 * needs the record's key and retried mark, the row readers just the rows.
 *
 * Deliberately NOT gated on the scope's sync state: results reflect
 * whatever has replicated so far — a warm cache from a prior session, or a
 * partially-landed sync — and the write path's invalidation refreshes
 * observers as further writes land. Callers surface sync progress
 * separately rather than hiding rows behind it.
 *
 * `prefix` narrows the scan (folder mode lists a subdirectory). Retried
 * grouping keys on a row's exact parent directory, so a boundary-safe
 * prefix scan never splits a group and the marking matches a whole-dir
 * scan's.
 *
 * `sorted: false` skips the plan's ordering, for callers that impose their
 * own (the match projection orders by snapshot key position).
 */
const scanListingEntries = async <TRow>(
  logDir: string,
  prefix: string,
  toRow: (log: LogListingRow) => TRow | undefined,
  plan: DatabaseListingPlan<TRow>,
  options?: { sorted: boolean }
): Promise<{ log: LogListingRow; row: TRow }[]> => {
  const scanned = await scanRows(logDir, prefix);
  const entries: { log: LogListingRow; row: TRow }[] = [];
  for (const log of computeLogsWithRetried(scanned)) {
    const row = toRow(log);
    if (row !== undefined && plan.matches(row)) entries.push({ log, row });
  }
  // Stable sort over the scan's listing order (mtime-descending), so ties —
  // and the unsorted listing — keep that order without a position tiebreak.
  if (plan.compare && options?.sorted !== false) {
    const compare = plan.compare;
    entries.sort((a, b) => compare(a.row, b.row));
  }
  return entries;
};

const scanListingRows = async <TRow>(
  logDir: string,
  prefix: string,
  toRow: (log: LogListingRow) => TRow | undefined,
  plan: DatabaseListingPlan<TRow>
): Promise<TRow[]> => {
  const entries = await scanListingEntries(logDir, prefix, toRow, plan);
  return entries.map((entry) => entry.row);
};

export const readLogsListing = async <TRow>(
  logDir: string,
  prefix: string,
  toRow: (log: LogListingRow) => TRow | undefined,
  plan: DatabaseListingPlan<TRow>
): Promise<DatabaseListingResult<TRow>> => {
  const rows = await scanListingRows(logDir, prefix, toRow, plan);
  const total_count = rows.length;
  return { ...pageRows(rows, plan.pagination), total_count };
};

/**
 * The tier-1 snapshot (keys-first pagination): one scan's ordered result as
 * primary keys, so the count comes free and each page is a cheap `bulkGet`
 * of a key slice — pages are mutually consistent under concurrent
 * replication writes because they all slice the same frozen ordering.
 */
export interface LogsListingSnapshot<TRow> {
  /** Ordered record keys (`file_path`) of the filtered+sorted row universe. */
  keys: string[];
  /** `keys.length` — the scan that orders also counts. */
  total_count: number;
  /** Distinct task_ids across the whole filtered universe — the scan
   *  touches every row anyway. Pages report these so the pending-task
   *  anti-join can settle a task whose file sits on an unloaded page
   *  (the loaded window alone can't prove a file exists). */
  task_ids: string[];
  /** The scan's retried marks by key. A cross-row derivation
   *  (`computeLogsWithRetried`): a page's key-slice `bulkGet` cannot
   *  re-derive it, so pages re-attach these to their records. */
  retried: Record<string, boolean>;
  /** Shaped rows for the first page, seeded by the build (decision 3): the
   *  scan shaped them anyway, so serving page one adds no second read over
   *  today's one-read flow. Sized by the build's `firstPageSize`. */
  firstPage: TRow[];
}

/** Build a {@link LogsListingSnapshot} with today's scan pipeline (the
 *  transitional form — see the retried-marking constraint in the plan doc;
 *  an index-backed walk can replace the internals later without changing
 *  the snapshot shape). */
export const readLogsListingSnapshot = async <TRow>(
  logDir: string,
  prefix: string,
  toRow: (log: LogListingRow) => TRow | undefined,
  plan: DatabaseListingPlan<TRow>,
  firstPageSize: number
): Promise<LogsListingSnapshot<TRow>> => {
  const entries = await scanListingEntries(logDir, prefix, toRow, plan);
  const keys: string[] = [];
  const retried: Record<string, boolean> = {};
  const taskIds = new Set<string>();
  for (const { log } of entries) {
    keys.push(log.name);
    if (log.retried !== undefined) retried[log.name] = log.retried;
    if (log.task_id) taskIds.add(log.task_id);
  }
  const firstPage = entries.slice(0, firstPageSize).map((entry) => entry.row);
  return {
    keys,
    total_count: keys.length,
    task_ids: [...taskIds],
    retried,
    firstPage,
  };
};

/** One page of records by key slice: `bulkGet`, re-attach the snapshot's
 *  retried marks, shape via `toRow`, re-check the plan's filter. A key
 *  deleted, reshaped out of the universe, or mutated out of the filter
 *  between snapshot and read is a dropped hole — the page runs short
 *  rather than erroring (or serving a row the active filter excludes);
 *  the next invalidation rebuilds the keys. A record mutated in its *sort*
 *  field still serves at its snapshot position — one page can't re-sort
 *  the universe. */
const readSnapshotPageRows = async <TRow>(
  snapshot: LogsListingSnapshot<TRow>,
  toRow: (log: LogListingRow) => TRow | undefined,
  plan: DatabaseListingPlan<TRow>,
  offset: number,
  limit: number
): Promise<TRow[]> => {
  const keys = snapshot.keys.slice(offset, offset + limit);
  if (keys.length === 0) return [];
  const records = await getDatabaseService().readLogRows(keys);
  const rows: TRow[] = [];
  for (const key of keys) {
    const record = records[key];
    if (record === undefined) continue;
    const row = toRow({ ...record, retried: snapshot.retried[key] });
    if (row !== undefined && plan.matches(row)) rows.push(row);
  }
  return rows;
};

/** One page of the listing plus the snapshot-scoped aggregates every page
 *  reports (like `total_count`, they come free with the snapshot scan). */
export interface LogsListingPageResult<
  TRow,
> extends DatabaseListingResult<TRow> {
  /** Distinct task_ids across the whole filtered universe (see
   *  {@link LogsListingSnapshot.task_ids}); unset on the cache path, whose
   *  single page is the whole universe. */
  universe_task_ids?: string[];
}

/** View inputs for {@link readLogsOverview}. */
export interface LogsOverviewView {
  /** Folder-mode current directory; unset in the flat tasks view (which
   *  lists the whole dir and derives no folders). */
  folderDir?: string;
  showRetriedLogs: boolean;
  /** Pre-hide row-universe membership for the view (`fileLogIdentity`
   *  presence — path logic only; the overview applies retried-hiding
   *  itself so it can also count what hiding removed). */
  isCandidate: (log: LogListingRow) => boolean;
}

/** Aggregate facts about a scope that the log-list page needs beyond the
 *  queried rows themselves. See {@link readLogsOverview}. */
export interface LogsOverview {
  /** Distinct task_ids with a log anywhere under the dir — the pending-task
   *  anti-join input. */
  taskIds: string[];
  /** File rows in the view universe (retried-hidden excluded). */
  fileCount: number;
  /** Among `fileCount`, logs still running (status "started"). */
  startedCount: number;
  /** Retried runs in the view universe pre-hiding — drives the
   *  "Show Retried Logs" toggle's visibility. */
  retriedCount: number;
  /** Set when exactly one file row exists (single-log workspace redirect). */
  soleFileName: string | undefined;
  /** Folder-mode: the current directory's immediate subdirectories. */
  folders: { name: string; itemCount: number }[];
}

/** Immediate subdirectories of `currentDir` with per-folder log counts. */
const deriveFolders = (
  rows: LogListingRow[],
  currentDir: string
): { name: string; itemCount: number }[] => {
  const dirWithSlash = ensureTrailingSlash(currentDir);

  // Count logs under a path prefix via binary search rather than a full
  // scan per folder. Names sort into contiguous ranges, so a prefix count
  // is two bound lookups.
  const sortedNames = rows.map((row) => row.name).sort();
  const lowerBound = (target: string): number => {
    let lo = 0;
    let hi = sortedNames.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const name = sortedNames[mid];
      if (name !== undefined && name < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const countWithPrefix = (prefix: string): number =>
    lowerBound(prefix + "￿") - lowerBound(prefix);

  const folders: { name: string; itemCount: number }[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const name = row.name;
    if (isInDirectory(name, currentDir) || !name.startsWith(dirWithSlash)) {
      continue;
    }
    const relativePath = directoryRelativeUrl(name, currentDir);
    // encodeURIComponent/decodeURIComponent round-trip, so this is the raw
    // first path segment under `currentDir` — the folder's own directory.
    const dirName = decodeURIComponent(rootName(relativePath));
    if (seen.has(dirName)) continue;
    seen.add(dirName);
    // Count under the folder's path, slash-terminated: an unterminated
    // prefix would also span sibling folders sharing the name as a prefix
    // (sub vs sub2), and the first-seen file's parent dir would miss logs
    // outside its own subtree when that file is nested deeper.
    folders.push({
      name: dirName,
      itemCount: countWithPrefix(dirWithSlash + dirName + "/"),
    });
  }
  return folders;
};

/**
 * One scan of `logDir`'s rows producing the page-level aggregates: pending
 * anti-join input, progress/footer counts, retried presence, the sole-file
 * redirect target, and folder summaries. These are the derivations that
 * would otherwise force the full row list into memory beside the row query;
 * keeping them behind one read means pagination only changes this module.
 * Like `readLogsListing`, deliberately not gated on sync state.
 */
export const readLogsOverview = async (
  logDir: string,
  view: LogsOverviewView
): Promise<LogsOverview> => {
  const scanned = await scanRows(logDir, logDir);
  const rows = computeLogsWithRetried(scanned);

  const taskIds = new Set<string>();
  let fileCount = 0;
  let startedCount = 0;
  let retriedCount = 0;
  let soleFileName: string | undefined;
  for (const log of rows) {
    if (log.task_id) taskIds.add(log.task_id);
    if (!view.isCandidate(log)) continue;
    if (log.retried) {
      retriedCount += 1;
      if (!view.showRetriedLogs) continue;
    }
    fileCount += 1;
    soleFileName = fileCount === 1 ? log.name : undefined;
    if (log.status === "started") startedCount += 1;
  }

  return {
    taskIds: [...taskIds],
    fileCount,
    startedCount,
    retriedCount,
    soleFileName,
    folders:
      view.folderDir === undefined ? [] : deriveFolders(rows, view.folderDir),
  };
};

export interface LogsListingMatch {
  id: string;
  /** Zero-based position in the filtered + sorted snapshot key list. */
  offset: number;
  /** Values needed to merge transient matching rows into file-match order. */
  orderValues?: Record<string, unknown>;
}

/** The find-only query inputs of {@link LogsListingData.getMatches}. */
export interface LogsListingFindQuery<TRow> {
  /** Sizes the snapshot build's inline first page when the match query is
   *  the one that builds it. */
  pageSize: number;
  term: string;
  getRowId: (row: TRow) => string;
  /** A row's searchable text, already lowercased (`rowSearchText`'s
   *  contract) — the scan must not pay a second per-row lowering. This is
   *  view code crossing the interface transitionally: matching runs against
   *  formatted on-screen text, which stored fields can't reproduce yet
   *  (design/listing-data-interface.md, `getMatches`). */
  rowText: (row: TRow) => string;
}

/**
 * Everything the view supplies to construct a {@link LogsListingData}:
 * where rows are read from (`logDir`/`prefix`), how records shape into view
 * rows (`toRow`, which also owns row-universe membership until the
 * membership rules move into filter conditions), and the view-level column
 * accessors that conditions and sorts are transitionally evaluated through
 * (see design/listing-data-interface.md for both exit paths).
 */
export interface LogsListingView<TRow> {
  logDir: string;
  /** Row-universe scan prefix (folder mode lists a subdirectory). Must stay
   *  consistent with what `toRow` accepts — a narrower prefix would
   *  silently drop matching rows. Deleted when membership moves into the
   *  filter condition (the prefix derives from it). */
  prefix: string;
  /** Shape a source record into the view's row, or `undefined` when the
   *  view has no row for it (row-universe membership). */
  toRow: (log: LogListingRow) => TRow | undefined;
  /** Reads a row's raw value for a column id. */
  getValue: ValueAccessor<TRow>;
  /** Per-column value comparator (falls back to a default compare). */
  getComparator: (columnId: string) => ValueComparator | undefined;
  /** Per-column filter type (type-aware filter coercion). */
  getFilterType?: FilterTypeAccessor;
}

/**
 * Data access for the log listing page — the seam between view code and
 * storage (design/listing-data-interface.md). Methods take a filter, a sort
 * order, and pagination, and return one page plus whole-result facts; what
 * sits behind them (today an IndexedDB scan, later a better local engine or
 * a server) is invisible above the interface, so nothing above it may be
 * tuned around the current implementation's cost profile.
 */
export interface LogsListingData<TRow> {
  /**
   * One page of the listing plus facts about the whole result set (the
   * footer's `total_count`, the pending anti-join's `universe_task_ids`).
   * All pages of one (filter, orderBy) slice a shared frozen snapshot, so
   * concurrent replication writes can't cause duplicates or gaps
   * mid-scroll; the write path's invalidation is what advances reads to
   * fresher data. Cursors are opaque positions in the filtered+sorted
   * result and work in both directions (a backward page is the slice
   * before the cursor; a null backward cursor starts from the end).
   */
  getPage(
    filter: Condition | undefined,
    orderBy: OrderByModel[] | undefined,
    pagination: Pagination
  ): Promise<LogsListingPageResult<TRow>>;

  /**
   * Rows whose searchable text contains the term across the WHOLE filtered
   * result — loaded and unloaded pages alike — in result order, with the
   * same offsets page cursors use (so "jump to this match" is "load pages
   * through this position"). Conceptually `getPage` with a different
   * projection; only the data layer can answer it, while all find
   * *behavior* (debounce, current match, loading through an offset) stays
   * above the interface.
   */
  getMatches(
    filter: Condition | undefined,
    orderBy: OrderByModel[] | undefined,
    find: LogsListingFindQuery<TRow>
  ): Promise<LogsListingMatch[]>;

  /**
   * Aggregate facts about the scope beyond the queried rows — one scan
   * produces all of them. Takes named options rather than conditions
   * because its numbers deliberately span *different* membership variants
   * in one answer (see {@link readLogsOverview}).
   */
  getOverview(view: LogsOverviewView): Promise<LogsOverview>;
}

/** The active query's snapshot plus the previous one, which may still be
 *  serving placeholder rows; a changed filter or sort rescans anyway. The
 *  overview doesn't consume snapshots, so it can't thrash these slots. */
const kSnapshotCacheEntries = 2;

/**
 * Create the log listing's data access over today's storage: the two-tier
 * scan (one snapshot scan per (filter, orderBy), cheap key-slice pages —
 * see {@link LogsListingSnapshot}), with cache-only scopes (db-less
 * sessions, out-of-namespace dirs) served as one unpaged in-memory read.
 *
 * Construct one instance per view, memoized on the view inputs: the
 * snapshot cache lives in the instance, so a changed view or accessor
 * schema means a fresh instance and a fresh cache.
 */
export const createLogsListingData = <TRow>(
  view: LogsListingView<TRow>
): LogsListingData<TRow> => {
  const { logDir, prefix, toRow } = view;

  const compilePlan = (
    filter: Condition | undefined,
    orderBy: OrderByModel[] | undefined
  ): DatabaseListingPlan<TRow> =>
    createListingPlan({
      filter,
      orderBy,
      getValue: view.getValue,
      getComparator: view.getComparator,
      getFilterType: view.getFilterType,
    });

  // The snapshot cache. Promise-valued so concurrent page and Find reads of
  // one (filter, orderBy) dedupe into a single scan; keyed by the
  // serialized query values — the filter condition's value IS the cache
  // identity (`toJSON` is deterministic for a given construction; an
  // equivalent condition built differently just misses and rescans).
  // Entries are epoch-stamped (see logsListingEpoch): a bumped epoch means
  // the next read rebuilds and awaits, so an invalidated snapshot is never
  // served stale — the semantics the previous react-query placement needed
  // `fetchQuery` + `staleTime: Infinity` to encode.
  const snapshots = new Map<
    string,
    { epoch: number; promise: Promise<LogsListingSnapshot<TRow>> }
  >();

  const snapshotKey = (
    filter: Condition | undefined,
    orderBy: OrderByModel[] | undefined
  ): string => JSON.stringify([filter ?? null, orderBy ?? null]);

  const fetchSnapshot = (
    filter: Condition | undefined,
    orderBy: OrderByModel[] | undefined,
    plan: DatabaseListingPlan<TRow>,
    firstPageSize: number
  ): Promise<LogsListingSnapshot<TRow>> => {
    const key = snapshotKey(filter, orderBy);
    const epoch = logsListingEpoch();
    const cached = snapshots.get(key);
    if (cached !== undefined && cached.epoch === epoch) {
      // Re-insert so eviction order tracks recency, not first insertion.
      snapshots.delete(key);
      snapshots.set(key, cached);
      return cached.promise;
    }
    const entry = {
      epoch,
      promise: readLogsListingSnapshot(
        logDir,
        prefix,
        toRow,
        plan,
        firstPageSize
      ),
    };
    snapshots.delete(key);
    snapshots.set(key, entry);
    while (snapshots.size > kSnapshotCacheEntries) {
      const oldest = snapshots.keys().next().value;
      if (oldest === undefined) break;
      snapshots.delete(oldest);
    }
    // A failed build must not serve as a durable snapshot ("no items" over
    // a populated database): evict so the next read rebuilds. Callers see
    // the rejection; retry policy stays with the react-query layer above.
    entry.promise.catch(() => {
      if (snapshots.get(key) === entry) snapshots.delete(key);
    });
    return entry.promise;
  };

  const getPage = async (
    filter: Condition | undefined,
    orderBy: OrderByModel[] | undefined,
    pagination: Pagination
  ): Promise<LogsListingPageResult<TRow>> => {
    const plan = compilePlan(filter, orderBy);
    if (logsListingSource(logDir) === "cache") {
      // One unpaged read: cache-only rows already live in memory, so a scan
      // per read stays the simpler, equally-cheap form. No
      // universe_task_ids: the single page IS the whole universe, so the
      // anti-join's loaded-window fallback already covers it.
      return readLogsListing(logDir, prefix, toRow, plan);
    }
    const snapshot = await fetchSnapshot(
      filter,
      orderBy,
      plan,
      pagination.limit
    );
    const total = snapshot.total_count;
    const cursorOffset =
      pagination.cursor && typeof pagination.cursor.offset === "number"
        ? pagination.cursor.offset
        : undefined;
    const backward = pagination.direction === "backward";
    const start = backward
      ? Math.max(0, (cursorOffset ?? total) - pagination.limit)
      : (cursorOffset ?? 0);
    const end = backward ? (cursorOffset ?? total) : start + pagination.limit;
    // The inline first page covers slices from 0 whenever it holds `end`
    // rows — or the whole (shorter) universe. A cached snapshot built under
    // another limit falls through to the bulkGet path.
    const items =
      start === 0 &&
      (snapshot.firstPage.length >= end || snapshot.firstPage.length === total)
        ? snapshot.firstPage.slice(0, end)
        : await readSnapshotPageRows(snapshot, toRow, plan, start, end - start);
    return {
      items,
      total_count: total,
      universe_task_ids: snapshot.task_ids,
      // Cursors index the snapshot's key list (not served-row counts), so a
      // dropped hole never desyncs subsequent pages.
      next_cursor: backward
        ? start > 0
          ? { offset: start }
          : null
        : end < total
          ? { offset: end }
          : null,
    };
  };

  const getMatches = async (
    filter: Condition | undefined,
    orderBy: OrderByModel[] | undefined,
    find: LogsListingFindQuery<TRow>
  ): Promise<LogsListingMatch[]> => {
    const plan = compilePlan(filter, orderBy);
    const term = find.term.toLowerCase();
    const toMatch = (row: TRow, offset: number): LogsListingMatch => {
      const orderValues = orderBy?.length
        ? Object.fromEntries(
            orderBy.map(({ column }) => [column, view.getValue(row, column)])
          )
        : undefined;
      const match = { id: find.getRowId(row), offset };
      return orderValues === undefined ? match : { ...match, orderValues };
    };

    if (logsListingSource(logDir) === "cache") {
      const rows = await scanListingRows(logDir, prefix, toRow, plan);
      const matches: LogsListingMatch[] = [];
      for (let offset = 0; offset < rows.length; offset++) {
        const row = rows[offset]!;
        if (find.rowText(row).includes(term)) {
          matches.push(toMatch(row, offset));
        }
      }
      return matches;
    }

    // The match scan doesn't consume the snapshot until the join below, so
    // overlap the two store reads: on a cold snapshot (first keystroke per
    // (filter, orderBy), post-invalidation rebuild) each is a full table
    // scan, and serializing them doubles per-keystroke match latency.
    // Unsorted scan: order comes from the snapshot's key positions below, so
    // the plan's full-list sort would be paid per keystroke and discarded.
    const [snapshot, entries] = await Promise.all([
      fetchSnapshot(filter, orderBy, plan, find.pageSize),
      scanListingEntries(logDir, prefix, toRow, plan, { sorted: false }),
    ]);
    const offsetByKey = new Map(
      snapshot.keys.map((key, offset) => [key, offset] as const)
    );
    const matches: LogsListingMatch[] = [];
    for (const { log, row } of entries) {
      const offset = offsetByKey.get(log.name);
      if (offset !== undefined && find.rowText(row).includes(term)) {
        matches.push(toMatch(row, offset));
      }
    }
    matches.sort((a, b) => a.offset - b.offset);
    return matches;
  };

  return {
    getPage,
    getMatches,
    getOverview: (overview) => readLogsOverview(logDir, overview),
  };
};
