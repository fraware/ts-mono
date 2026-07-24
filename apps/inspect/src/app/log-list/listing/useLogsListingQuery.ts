import { hashKey, useQueries, useQuery } from "@tanstack/react-query";
import type { SortingState } from "@tanstack/react-table";
import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  Condition,
  OrderByModel,
  Pagination,
} from "@tsmono/inspect-common/query";
import { useDebouncedCallback } from "@tsmono/react/hooks";
import { loading, type AsyncData } from "@tsmono/util";

import type {
  LogListingRow,
  LogsListingMatch,
  LogsListingPageResult,
} from "../../../log_data";
import {
  databaseLogsListingKey,
  listingKeyUniverse,
  logsListingSource,
  readLogsListingMatches,
  readLogsListingOverlayOffsets,
  readLogsListingPage,
} from "../../../log_data";

import { applyListingQuery } from "./applyListingQuery";
import { createListingPlan } from "./planner";
import type {
  FilterTypeAccessor,
  LogsListingResult,
  ValueAccessor,
  ValueComparator,
} from "./types";

/** TanStack `SortingState` → API `OrderBy[]`. Mirrors scout's helper. */
export const sortingStateToOrderBy = (sorting: SortingState): OrderByModel[] =>
  sorting.map((s) => ({ column: s.id, direction: s.desc ? "DESC" : "ASC" }));

interface UseLogsListingParams<TRow> {
  /** Shaped rows (the panel owns shaping; sourced from the logs-content cache). */
  rows: TRow[];
  filter?: Condition;
  orderBy?: OrderByModel[];
  pagination?: Pagination;
  getValue: ValueAccessor<TRow>;
  getComparator: (columnId: string) => ValueComparator | undefined;
  getFilterType?: FilterTypeAccessor;
}

/**
 * The generic in-memory listing query: filter + sort + paginate over the
 * rows. Mirrors scout's `getTranscripts(filter, orderBy, pagination)` tail
 * and response shape. Retained for samples listings, which don't have a
 * database-backed path yet — the log list uses
 * {@link useDatabaseLogsListingQuery}.
 */
export function useLogsListingQuery<TRow>({
  rows,
  filter,
  orderBy,
  pagination,
  getValue,
  getComparator,
  getFilterType,
}: UseLogsListingParams<TRow>): LogsListingResult<TRow> {
  return useMemo(
    () =>
      applyListingQuery(rows, {
        filter,
        orderBy,
        pagination,
        getValue,
        getComparator,
        getFilterType,
      }),
    [rows, filter, orderBy, pagination, getValue, getComparator, getFilterType]
  );
}

/** The listing source a view queries — shared by the row query, the find
 *  band's match query, and (eventually) the offset lookup, so they can
 *  never disagree about the row universe. */
export interface LogsListingDescriptor<TRow> {
  /** The synced directory whose rows are the source (see `readLogsListing`
   *  for where they're read from). */
  logDir: string;
  /** Row-universe scan prefix (folder mode lists a subdirectory). */
  prefix: string;
  /** Cache identity of the row universe: everything `toRow` reads beyond
   *  the record itself (view mode, directory, display toggles).
   *  `undefined` while the scope is still hydrating — disables queries. */
  universe: string | undefined;
  /** Shape a source record into the view's row, or `undefined` when the
   *  view has no row for it (row-universe membership). */
  toRow: (log: LogListingRow) => TRow | undefined;
}

interface UseDatabaseLogsListingParams<TRow> {
  filter?: Condition;
  orderBy?: OrderByModel[];
  getValue: ValueAccessor<TRow>;
  getComparator: (columnId: string) => ValueComparator | undefined;
  getFilterType?: FilterTypeAccessor;
  /** Cache identity of the accessors above (see `useLogListColumns`) — the
   *  score-column schema lands asynchronously and changes what the plan
   *  computes, so it must key the query alongside filter/orderBy. */
  accessorsKey: string;
  listing: LogsListingDescriptor<TRow>;
}

/**
 * Rows per page. Scout's tuning (see `apps/scout/src/app/transcripts/
 * constants.ts` for the full derivation): page-fetch duration is mostly
 * fixed overhead, so large pages mean fewer fetches and fewer stall
 * opportunities — 500 rows ≈ 14,500px ≈ 10s of fast scrolling per page,
 * against the grid's 2,000px fetch threshold.
 */
const kLogsListingPageSize = 500;

/** A rendered row range in file-universe offsets (inclusive bounds). */
export interface ListingVisibleRange {
  start: number;
  end: number;
}

/** Rows fetched beyond the rendered range on each side, so a steady scroll
 *  reaches pages already in flight instead of lingering on skeletons
 *  (~3,000px at the default row height — of the order of scout's 2,000px
 *  near-end threshold). */
const kVisibleRangeOverscanRows = 100;

/** The published listing window: the whole universe's shape plus the
 *  observed pages' rows. */
export interface LogsListingWindow<TRow> {
  /** Total rows in the filtered universe (the snapshot's key count). */
  total_count: number;
  /** Distinct task_ids across the whole filtered universe (the pending
   *  anti-join input). */
  universe_task_ids?: string[];
  /** The row at a universe offset, or `undefined` while its page is
   *  unloaded — the grid renders those as skeletons. A page holding
   *  dropped holes (keys deleted between snapshot and read) leaves its
   *  tail offsets unloaded until the next snapshot rebuild. */
  rowAt: (offset: number) => TRow | undefined;
  /** The observed pages' rows in offset order — for window-scoped
   *  derivations (e.g. re-deriving the pending anti-join against what is
   *  actually rendered). */
  loadedRows: TRow[];
}

/** {@link useDatabaseLogsListingQuery}'s result: the assembled listing
 *  window plus the range input that drives which pages are observed. */
export interface DatabaseLogsListing<TRow> {
  /** What to render. A settled failure reports here only when there is
   *  nothing to show (cold — typically the universe's first read failing):
   *  react-query retains observed pages across a failed refetch, and the
   *  listing-level hold carries the previous window across a re-filter, so
   *  those keep serving as `data` (warm) with the failure surfaced through
   *  `error` beside them. */
  result: AsyncData<LogsListingWindow<TRow>>;
  /** The last read failed — the first settled error among the observed page
   *  queries (a failed snapshot build rejects every observed page, so one
   *  broken build still surfaces). Sticky once settled (focus/reconnect
   *  refetches are off); recovery is an invalidation
   *  (`invalidateDatabaseLogsListings`) or a filter/sort/range change. */
  error: Error | undefined;
  /** Report the grid's rendered row range (file-universe offsets); the
   *  observed page queries follow it. Stable identity; cheap to call per
   *  range change. */
  setVisibleRange: (range: ListingVisibleRange) => void;
}

/** `useMemo` with an explicit, variable-length dependency list — the page
 *  window's deps are one data reference per observed page, and the page
 *  count changes with the visible range. Caches via the derive-and-adjust-
 *  during-render state pattern (react.dev), so it stays within the React
 *  compiler's rules (no ref reads during render). */
function useStableValue<T>(deps: readonly unknown[], build: () => T): T {
  const [cache, setCache] = useState<
    { deps: readonly unknown[]; value: T } | undefined
  >(undefined);
  if (
    cache !== undefined &&
    cache.deps.length === deps.length &&
    deps.every((dep, index) => dep === cache.deps[index])
  ) {
    return cache.value;
  }
  const value = build();
  setCache({ deps, value });
  return value;
}

/**
 * The log listing query: offset-addressed page queries driven by the grid's
 * visible range. Each observed page is its own react-query entry over
 * `readLogsListingPage`, composing over the tier-1 key-list snapshot (built
 * once per (universe, accessors, filter, orderBy), shared by every page,
 * invalidated by the write path's throttled root-key invalidation) — so an
 * invalidation refetches only the observed pages, pages leaving observation
 * drop via plain `gcTime` (no `maxPages` semantics; scroll-back refetching
 * is emergent), and jumping anywhere in the universe is just a range change.
 * Rows are read from the listing source (IndexedDB in dir mode; db-less and
 * cache-only scopes fall back to the react-query cache inside the same
 * queryFn) and shaped per view inside the queryFn, so the full row list
 * never has to live in memory for the grid's sake. Results are asynchronous
 * by design: the first read shows whatever has replicated so far, and the
 * write path's throttled invalidation streams further rows in as they land.
 * `loading` covers hydration and the universe's first read; within one
 * universe a re-filter/sort keeps publishing the previous key's window
 * (rows and total) until the new key's needed pages all land, then swaps
 * atomically — the listing-level no-blank-flash hold (see the plan doc's
 * range-driven amendment).
 */
export function useDatabaseLogsListingQuery<TRow>({
  filter,
  orderBy,
  getValue,
  getComparator,
  getFilterType,
  accessorsKey,
  listing,
}: UseDatabaseLogsListingParams<TRow>): DatabaseLogsListing<TRow> {
  const { logDir, prefix, universe, toRow } = listing;

  const [range, setRange] = useState<ListingVisibleRange>({
    start: 0,
    end: 0,
  });
  const setVisibleRange = useCallback((next: ListingVisibleRange) => {
    setRange((prev) =>
      prev.start === next.start && prev.end === next.end ? prev : next
    );
  }, []);

  // Where this render's page reads dispatch. Keying pages on it re-keys the
  // window on the render after a mid-session database→cache degrade instead
  // of mixing sources under one key (the read itself is positionally
  // correct either way — its cache path honors the cursor).
  const source = logsListingSource(logDir);
  const listingKey = useMemo(
    () =>
      [
        ...databaseLogsListingKey(universe, accessorsKey, filter, orderBy),
        source,
      ] as const,
    [universe, accessorsKey, filter, orderBy, source]
  );
  const keyHash = useMemo(() => hashKey([...listingKey]), [listingKey]);

  // Pages needed by the reported range plus overscan. The tail extension is
  // clamped by the last *published* total (one render behind by design: the
  // range itself is bounded by the grid's row count, which derives from
  // that same published total — the held one during a hold, so the two stay
  // in one coordinate space). State synced at the end of the render (the
  // adjust-during-render pattern), not a ref — refs aren't readable during
  // render.
  const [publishedTotal, setPublishedTotal] = useState<number | undefined>(
    undefined
  );
  const firstPageIndex = Math.max(
    0,
    Math.floor((range.start - kVisibleRangeOverscanRows) / kLogsListingPageSize)
  );
  const pageCap =
    publishedTotal === undefined
      ? Number.MAX_SAFE_INTEGER
      : Math.max(0, Math.ceil(publishedTotal / kLogsListingPageSize) - 1);
  const lastPageIndex = Math.max(
    firstPageIndex,
    Math.min(
      Math.floor(
        (range.end + kVisibleRangeOverscanRows) / kLogsListingPageSize
      ),
      pageCap
    )
  );
  const pageIndices: number[] = [];
  for (let index = firstPageIndex; index <= lastPageIndex; index++) {
    pageIndices.push(index);
  }

  const results = useQueries({
    queries: pageIndices.map((pageIndex) => ({
      queryKey: [...listingKey, "page", pageIndex] as const,
      queryFn: (): Promise<LogsListingPageResult<TRow>> =>
        readLogsListingPage(
          {
            logDir,
            prefix,
            toRow,
            universe,
            accessorsKey,
            filter,
            orderBy,
            plan: createListingPlan({
              filter,
              orderBy,
              getValue,
              getComparator,
              getFilterType,
            }),
          },
          {
            cursor: { offset: pageIndex * kLogsListingPageSize },
            limit: kLogsListingPageSize,
          }
        ),
      enabled: universe !== undefined,
      staleTime: 0,
      // Pages that leave observation drop via plain gcTime: scroll-back
      // within it is an instant cache hit, beyond it a natural refetch.
      gcTime: 30_000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    })),
  });

  const pageData = results.map((result) => result.data);
  // Every page the current range needs has data — the hold's swap trigger.
  // Stays true through invalidation refetches (react-query retains page
  // data), so streaming updates never re-arm the hold.
  const allSettled =
    universe !== undefined &&
    pageData.length > 0 &&
    pageData.every((data) => data !== undefined);
  const error =
    results.find((result) => result.error !== null)?.error ?? undefined;

  // The live window. Rebuilt only when the key, the needed page set, or an
  // observed page's data actually changes, so the grid doesn't re-render
  // per page fetch (react-query keeps result.data references stable).
  const live = useStableValue(
    [keyHash, pageIndices.join(","), ...pageData],
    (): LogsListingWindow<TRow> | undefined => {
      const pages = new Map<number, LogsListingPageResult<TRow>>();
      pageIndices.forEach((pageIndex, position) => {
        const data = pageData[position];
        if (data !== undefined) pages.set(pageIndex, data);
      });
      if (pages.size === 0) return undefined;
      const ordered = [...pages.entries()].sort((a, b) => a[0] - b[0]);
      const head = ordered[0]![1];
      return {
        total_count: head.total_count,
        universe_task_ids: head.universe_task_ids,
        rowAt: (offset: number): TRow | undefined => {
          if (offset < 0) return undefined;
          const page = pages.get(Math.floor(offset / kLogsListingPageSize));
          return page?.items[offset % kLogsListingPageSize];
        },
        loadedRows: ordered.flatMap(([, page]) => page.items),
      };
    }
  );

  // The listing-level no-blank-flash hold: the last fully-settled key's
  // window keeps publishing across a same-universe key change (re-filter,
  // re-sort, the score schema arriving) until the new key's needed pages
  // all land, then rows + total swap in one commit. Never across universes
  // (another universe's rows must not leak in). Within one key, live data
  // wins as soon as any observed page has it (scrolling into unloaded
  // territory shows skeletons beside loaded rows, not stale rows) — but a
  // jump past every observed page falls back to the held window too, so
  // the total (and with it the scrollbar and the jump target) survives the
  // gap instead of collapsing to a loading state. A render-time ref cache
  // (idempotent write) so the swap decision is synchronous with the data
  // that drives it.
  const [held, setHeld] = useState<
    | { keyHash: string; universe: string; window: LogsListingWindow<TRow> }
    | undefined
  >(undefined);
  if (
    allSettled &&
    live !== undefined &&
    universe !== undefined &&
    (held === undefined || held.keyHash !== keyHash || held.window !== live)
  ) {
    setHeld({ keyHash, universe, window: live });
  }
  const published = allSettled
    ? live
    : held !== undefined && held.universe === universe
      ? held.keyHash === keyHash && live !== undefined
        ? live
        : held.window
      : live;
  if (published?.total_count !== publishedTotal) {
    setPublishedTotal(published?.total_count);
  }

  // Prefer retained/held rows over a settled error (`error` still reports
  // beside them): replacing a rendered list because one refetch failed
  // would lose the user's place over a failure a later invalidation may
  // well heal.
  const result = useMemo<AsyncData<LogsListingWindow<TRow>>>(() => {
    if (published !== undefined) return { data: published, loading: false };
    if (error !== undefined) return { error, loading: false };
    return loading;
  }, [published, error]);

  return useMemo(
    () => ({ result, error, setVisibleRange }),
    [result, error, setVisibleRange]
  );
}

interface UseLogsListingOverlayOffsetsParams<TRow> {
  /** The same query inputs the row query ran under (pass through from
   *  `useLogListData` — offsets must index the same universe ordering). */
  filter?: Condition;
  orderBy?: OrderByModel[];
  getValue: ValueAccessor<TRow>;
  getComparator: (columnId: string) => ValueComparator | undefined;
  getFilterType?: FilterTypeAccessor;
  accessorsKey: string;
  listing: LogsListingDescriptor<TRow>;
  /** Overlay rows, already filtered + sorted under the same query. */
  rows: TRow[];
}

/**
 * Universe insertion offsets for overlay (pending-task) rows — the query
 * layer around `readLogsListingOverlayOffsets`, keyed beside the row query
 * (same root, so the throttled invalidation keeps offsets in sync with
 * snapshot rebuilds) plus the overlay rows' sort values. Only runs under an
 * active sort — with none, callers place overlays after the whole universe
 * without a read. Returns `undefined` while unset/loading; callers fall
 * back to appending at the end until it lands.
 */
export function useLogsListingOverlayOffsets<TRow>({
  filter,
  orderBy,
  getValue,
  getComparator,
  getFilterType,
  accessorsKey,
  listing,
  rows,
}: UseLogsListingOverlayOffsetsParams<TRow>): number[] | undefined {
  const { logDir, prefix, universe, toRow } = listing;
  const sorted = (orderBy?.length ?? 0) > 0;
  // Key by the rows' sort values (not identities): a pending set re-shaped
  // by a poll tick with unchanged values stays one cache entry.
  const valuesKey = useMemo(
    () =>
      sorted
        ? rows.map((row) =>
            (orderBy ?? []).map(({ column }) => getValue(row, column) ?? null)
          )
        : [],
    [sorted, rows, orderBy, getValue]
  );
  const query = useQuery({
    queryKey: [
      ...databaseLogsListingKey(universe, accessorsKey, filter, orderBy),
      "overlay-offsets",
      valuesKey,
    ],
    queryFn: (): Promise<number[]> =>
      readLogsListingOverlayOffsets(
        {
          logDir,
          prefix,
          toRow,
          universe,
          accessorsKey,
          filter,
          orderBy,
          plan: createListingPlan({
            filter,
            orderBy,
            getValue,
            getComparator,
            getFilterType,
          }),
        },
        rows,
        kLogsListingPageSize
      ),
    enabled: sorted && rows.length > 0 && universe !== undefined,
    staleTime: 0,
    gcTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  return query.data;
}

interface UseLogsListingMatchesParams<TRow> {
  /** The same query inputs the row query ran under (pass them through from
   *  `useLogListData` rather than re-deriving — the match membership must
   *  never disagree with the rendered rows). */
  filter?: Condition;
  orderBy?: OrderByModel[];
  getValue: ValueAccessor<TRow>;
  getComparator: (columnId: string) => ValueComparator | undefined;
  getFilterType?: FilterTypeAccessor;
  accessorsKey: string;
  listing: LogsListingDescriptor<TRow>;
  /** The live find term. The query runs under a debounced copy: every
   *  distinct term is a fresh scan of the listing source, so keystrokes
   *  coalesce here while the input (and cheap overlay matching) stay live. */
  term: string;
  /** Whether the find band is open — the query never runs while closed. */
  enabled: boolean;
  getRowId: (row: TRow) => string;
  /** A row's searchable text, already lowercased (see `rowSearchText`). */
  rowText: (row: TRow) => string;
  /** Cache identity of `rowText` — the searchable (visible) column ids. */
  searchKey: readonly string[];
}

export interface LogsListingMatches {
  /** File-row matches in snapshot order, including their page offsets. */
  matches: LogsListingMatch[] | undefined;
  /** `matches` is a real result for the live term under the current universe —
   *  debounce flushed, not pending, not another key's placeholder, not an
   *  error. Only then may the UI claim "no results". */
  settled: boolean;
  /** Cancel the pending debounce and clear the match term (band closed). */
  reset: () => void;
}

/**
 * The find band's data-level match query, beside the row query so the two
 * share key shape and universe semantics: the key is the row query's key
 * (same universe slot, so `listingKeyUniverse` and the root invalidation
 * cover both) extended with the find-only inputs, and the placeholder keeps
 * previous matches only within one universe — folder-mode row ids are
 * basenames, so another directory's ids could otherwise mark unrelated
 * same-named rows as matches while a scope change's refetch is in flight.
 */
export function useLogsListingMatches<TRow>({
  filter,
  orderBy,
  getValue,
  getComparator,
  getFilterType,
  accessorsKey,
  listing,
  term,
  enabled,
  getRowId,
  rowText,
  searchKey,
}: UseLogsListingMatchesParams<TRow>): LogsListingMatches {
  const [matchTerm, setMatchTerm] = useState("");
  // Same 100ms as the shared FindBand's debounce. The debounced callback
  // always runs the latest closure, so the flush reads the current term.
  const syncMatchTerm = useDebouncedCallback(() => setMatchTerm(term), 100);
  useEffect(() => {
    syncMatchTerm();
  }, [term, syncMatchTerm]);
  const reset = useCallback(() => {
    syncMatchTerm.cancel();
    setMatchTerm("");
  }, [syncMatchTerm]);

  const { logDir, prefix, universe, toRow } = listing;
  const query = useQuery({
    queryKey: [
      ...databaseLogsListingKey(universe, accessorsKey, filter, orderBy),
      "find",
      matchTerm,
      searchKey,
    ],
    queryFn: (): Promise<LogsListingMatch[]> =>
      readLogsListingMatches(
        {
          logDir,
          prefix,
          toRow,
          universe,
          accessorsKey,
          filter,
          orderBy,
          plan: createListingPlan({
            filter,
            orderBy,
            getValue,
            getComparator,
            getFilterType,
          }),
        },
        {
          pageSize: kLogsListingPageSize,
          term: matchTerm,
          getRowId,
          getOrderValue: getValue,
          rowText,
        }
      ),
    enabled: enabled && matchTerm !== "" && universe !== undefined,
    // Keep the previous matches while a keystroke's refetch is in flight —
    // within one universe only (see the docstring above).
    placeholderData: (
      previousData: LogsListingMatch[] | undefined,
      previousQuery
    ) =>
      universe !== undefined &&
      previousQuery !== undefined &&
      listingKeyUniverse(previousQuery.queryKey) === universe
        ? previousData
        : undefined,
    staleTime: 0,
    // Transitional (pre-pagination): every distinct term parks a full id
    // list per key; drop unobserved ones fast, like the row query.
    gcTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  return {
    matches: query.data,
    // `isPending` alone can't gate "no results": a key change served from
    // the placeholder reads as success while the new term's scan is still
    // in flight, and an errored query reads as not-pending with no data.
    settled:
      term === matchTerm &&
      !query.isPending &&
      !query.isPlaceholderData &&
      !query.isError,
    reset,
  };
}
