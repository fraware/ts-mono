/**
 * The listing data access: source dispatch (database vs cache), retried
 * marking, the instance's internal snapshot cache (dedupe, epoch
 * invalidation, error eviction), and parity with the in-memory engine — the
 * same fixtures through `applyListingQuery` and the seam must agree (the
 * migration safety net). Uses fake-indexeddb (see setupTests) behind a real
 * DatabaseService.
 */

import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Column } from "@tsmono/inspect-common/query";
import type { Condition, OrderByModel } from "@tsmono/inspect-common/query";

import { applyListingQuery } from "../app/log-list/listing/applyListingQuery";
import type { Log, LogPreview } from "../client/api/types";
import { DB_NAME } from "../client/database/schema";
import {
  createDatabaseService,
  type DatabaseService,
} from "../client/database/service";

import { createListingPlan } from "./listing/planner";
import { computeLogsWithRetried, type LogListingRow } from "./logListing";
import { setRows, writeListing } from "./logsContent";
import { bumpLogsListingEpoch } from "./logsListingEpoch";
import {
  createLogsListingData,
  readLogsListing,
  readLogsOverview,
  type LogsListingData,
  type LogsListingPageResult,
  type LogsListingView,
} from "./logsListingRead";

const holder = vi.hoisted(() => {
  const state: { service: DatabaseService | null } = { service: null };
  return state;
});

vi.mock("./databaseServiceInstance", () => ({
  getDatabaseService: () => holder.service,
}));

const preview = (overrides: Partial<LogPreview>): LogPreview => ({
  eval_id: "eval-1",
  run_id: "run-1",
  task: "test-task",
  task_id: "task-1",
  task_version: 1,
  version: 1,
  status: "success",
  error: null,
  model: "gpt-4",
  started_at: "2024-01-01T00:00:00Z",
  completed_at: "2024-01-01T01:00:00Z",
  ...overrides,
});

const getValue = (row: Log, column: string): unknown =>
  row[column as keyof Log];

describe("readLogsListing", () => {
  let databaseService: DatabaseService;

  beforeEach(async () => {
    databaseService = createDatabaseService();
    holder.service = databaseService;
    await databaseService.openDatabase();
  });

  afterEach(async () => {
    try {
      await databaseService.closeDatabase();
    } catch {
      // Already closed in the cache-dispatch test.
    }
    await Dexie.delete(DB_NAME);
  });

  test("matches the in-memory filter, sort, and pagination", async () => {
    await databaseService.writeLogPreviews({
      "/test/logs/a.json": preview({
        model: "gpt-4",
        status: "success",
        task_id: "t-a",
      }),
      "/test/logs/b.json": preview({
        model: "claude",
        status: "success",
        task_id: "t-b",
      }),
      "/test/logs/c.json": preview({
        model: "gpt-4o",
        status: "error",
        task_id: "t-c",
      }),
      "/test/logs/d.json": preview({
        model: "gpt-5",
        status: "success",
        task_id: "t-d",
      }),
      "/other/e.json": preview({ model: "gpt-5", status: "success" }),
    });
    const source = (await databaseService.readLogs({
      prefix: "/test/logs",
    })) as Log[];
    const query = {
      filter: new Column("model")
        .ilike("gpt%")
        .and(new Column("status").ne("error")),
      orderBy: [{ column: "name", direction: "DESC" as const }],
      pagination: { limit: 1, cursor: null, direction: "forward" as const },
      getValue,
      getComparator: () => undefined,
    };

    // The seam marks retried runs over its scan; mirror that on the
    // in-memory side so the parity compare sees identical rows.
    const expected = applyListingQuery(computeLogsWithRetried(source), query);
    const actual = await readLogsListing(
      "/test/logs",
      "/test/logs",
      (log: LogListingRow) => log as Log,
      createListingPlan(query)
    );

    expect(actual).toEqual(expected);
    expect(actual.items.map((row) => row.name)).toEqual(["/test/logs/d.json"]);
    expect(actual.total_count).toBe(2);
    expect(actual.next_cursor).toEqual({ offset: 1 });
  });

  test("marks retried runs across the scan and lets toRow drop them", async () => {
    // Same parent dir + task_id: the newest successful run wins, the other
    // is retried.
    await databaseService.writeLogPreviews({
      "/test/logs/2024-01-01_task.json": preview({ task_id: "shared" }),
      "/test/logs/2024-01-02_task.json": preview({ task_id: "shared" }),
    });

    const rows = await readLogsListing(
      "/test/logs",
      "/test/logs",
      (log: LogListingRow) => (log.retried ? undefined : log),
      createListingPlan({ getValue, getComparator: () => undefined })
    );
    expect(rows.total_count).toBe(1);
    expect(rows.items[0]?.name).toBe("/test/logs/2024-01-02_task.json");

    const all = await readLogsListing(
      "/test/logs",
      "/test/logs",
      (log: LogListingRow) => log,
      createListingPlan({ getValue, getComparator: () => undefined })
    );
    expect(all.total_count).toBe(2);
  });

  test("serves from the react-query cache when the database is not open", async () => {
    setRows("/cache/logs", [
      { name: "/cache/logs/a.json", task: "t" } as Log,
      { name: "/cache/logs-other/b.json", task: "t" } as Log,
    ]);
    await databaseService.closeDatabase();

    const result = await readLogsListing(
      "/cache/logs",
      "/cache/logs",
      (log: LogListingRow) => log,
      createListingPlan({ getValue, getComparator: () => undefined })
    );
    // Scoped by boundary-safe prefix: the sibling dir's row is excluded.
    expect(result.items.map((row) => row.name)).toEqual(["/cache/logs/a.json"]);
  });

  test("serves every cache row for an out-of-namespace (cache-only) scope", async () => {
    // An older view server can report an aliased local path as log_dir while
    // the listing names are file:// URIs; writeListing degrades the scope to
    // cache-only. Those names never match the scope prefix, so the cache
    // read must not prefix-filter them away.
    await writeListing(databaseService, "/alias/logs", [
      { name: "file:///real/logs/a.json" },
      { name: "file:///real/logs/b.json" },
    ]);

    const result = await readLogsListing(
      "/alias/logs",
      "/alias/logs",
      (log: LogListingRow) => log,
      createListingPlan({ getValue, getComparator: () => undefined })
    );
    expect(result.items.map((row) => row.name).sort()).toEqual([
      "file:///real/logs/a.json",
      "file:///real/logs/b.json",
    ]);
  });
});

describe("LogsListingData.getPage", () => {
  let databaseService: DatabaseService;

  const identityRow = (log: LogListingRow): Log => log;

  const createData = (
    overrides?: Partial<LogsListingView<Log>>
  ): LogsListingData<Log> =>
    createLogsListingData<Log>({
      logDir: "/test/logs",
      prefix: "/test/logs",
      toRow: identityRow,
      getValue,
      getComparator: () => undefined,
      ...overrides,
    });

  /** Walk every page of the paged path (the grid's fetchNextPage loop). */
  const collectPages = async (
    data: LogsListingData<Log>,
    query: { filter?: Condition; orderBy?: OrderByModel[] },
    limit: number
  ): Promise<LogsListingPageResult<Log>[]> => {
    const pages: LogsListingPageResult<Log>[] = [];
    let cursor: LogsListingPageResult<Log>["next_cursor"] = null;
    do {
      const page: LogsListingPageResult<Log> = await data.getPage(
        query.filter,
        query.orderBy,
        { cursor, direction: "forward", limit }
      );
      pages.push(page);
      cursor = page.next_cursor;
    } while (cursor !== null);
    return pages;
  };

  beforeEach(async () => {
    databaseService = createDatabaseService();
    holder.service = databaseService;
    await databaseService.openDatabase();
  });

  afterEach(async () => {
    try {
      await databaseService.closeDatabase();
    } catch {
      // Already closed in the cache-dispatch test.
    }
    await Dexie.delete(DB_NAME);
  });

  test("pages agree with the in-memory engine page-by-page and on total_count", async () => {
    await databaseService.writeLogPreviews({
      "/test/logs/a.json": preview({ model: "gpt-4", task_id: "t-a" }),
      "/test/logs/b.json": preview({ model: "claude", task_id: "t-b" }),
      "/test/logs/c.json": preview({
        model: "gpt-4o",
        status: "error",
        task_id: "t-c",
      }),
      "/test/logs/d.json": preview({ model: "gpt-5", task_id: "t-d" }),
      "/test/logs/e.json": preview({ model: "gpt-4.1", task_id: "t-e" }),
      "/other/f.json": preview({ model: "gpt-5", task_id: "t-f" }),
    });
    const source = (await databaseService.readLogs({
      prefix: "/test/logs",
    })) as Log[];
    const filter = new Column("model")
      .ilike("gpt%")
      .and(new Column("status").ne("error"));
    const orderBy = [{ column: "name", direction: "DESC" as const }];
    const listingQuery = {
      filter,
      orderBy,
      getValue,
      getComparator: () => undefined,
    };

    const limit = 2;
    const pages = await collectPages(createData(), { filter, orderBy }, limit);

    // The same fixtures through the in-memory engine, page-by-page — the
    // migration safety net (mirror the seam's retried marking first).
    const marked = computeLogsWithRetried(source);
    pages.forEach((page, index) => {
      const expected = applyListingQuery(marked, {
        ...listingQuery,
        pagination: {
          limit,
          cursor: index === 0 ? null : { offset: index * limit },
          direction: "forward" as const,
        },
      });
      // The snapshot-scoped aggregate rides beside the parity fields.
      const { universe_task_ids, ...parityFields } = page;
      expect(parityFields).toEqual(expected);
      expect([...(universe_task_ids ?? [])].sort()).toEqual([
        "t-a",
        "t-d",
        "t-e",
      ]);
    });
    expect(pages).toHaveLength(2);
    expect(pages.map((page) => page.total_count)).toEqual([3, 3]);
  });

  test("a failed store read during the snapshot build rejects instead of caching an empty listing", async () => {
    // `readLogs` swallows Dexie errors to null. Degrading to the react-query
    // mirror (which can be GC'd empty) would cache keys: [] as a fresh
    // successful snapshot — "No matching items" over a populated database,
    // with no error surfaced. The failure must reject so the listing query
    // settles in error (same rationale as readLogRows' deliberate no-catch),
    // and the internal cache must evict the rejected build.
    await databaseService.writeLogPreviews({
      "/test/logs/a.json": preview({ task_id: "t-a" }),
    });
    vi.spyOn(databaseService, "readLogs").mockResolvedValue(null);

    const data = createData();
    await expect(
      data.getPage(undefined, undefined, {
        cursor: null,
        direction: "forward",
        limit: 10,
      })
    ).rejects.toThrow(/listing/i);

    // The failure must not have been cached: with the store healthy again,
    // the same instance serves the real rows.
    vi.restoreAllMocks();
    const recovered = await data.getPage(undefined, undefined, {
      cursor: null,
      direction: "forward",
      limit: 10,
    });
    expect(recovered.items.map((row) => row.name)).toEqual([
      "/test/logs/a.json",
    ]);
  });

  test("pages re-attach the scan's retried marks to bulkGot records", async () => {
    // Same parent dir + task_id: the newer run wins, the older is retried.
    await databaseService.writeLogPreviews({
      "/test/logs/2024-01-01_task.json": preview({ task_id: "shared" }),
      "/test/logs/2024-01-02_task.json": preview({ task_id: "shared" }),
    });
    const orderBy = [{ column: "name", direction: "ASC" as const }];

    const [first, second] = await collectPages(createData(), { orderBy }, 1);
    // Page one is served inline from the build; page two goes through the
    // bulkGet path — both must carry the cross-row retried derivation.
    expect(first?.items[0]).toMatchObject({
      name: "/test/logs/2024-01-01_task.json",
      retried: true,
    });
    expect(second?.items[0]).toMatchObject({
      name: "/test/logs/2024-01-02_task.json",
      retried: false,
    });
  });

  test("serves the first page from the snapshot build without a second read", async () => {
    await databaseService.writeLogPreviews({
      "/test/logs/a.json": preview({ task_id: "t-a" }),
      "/test/logs/b.json": preview({ task_id: "t-b" }),
      "/test/logs/c.json": preview({ task_id: "t-c" }),
    });
    const readLogRowsSpy = vi.spyOn(databaseService, "readLogRows");

    const data = createData();
    const first = await data.getPage(undefined, undefined, {
      cursor: null,
      direction: "forward",
      limit: 2,
    });
    expect(first.items).toHaveLength(2);
    expect(readLogRowsSpy).not.toHaveBeenCalled();

    const second = await data.getPage(undefined, undefined, {
      cursor: first.next_cursor,
      direction: "forward",
      limit: 2,
    });
    expect(second.items).toHaveLength(1);
    expect(readLogRowsSpy).toHaveBeenCalledTimes(1);
  });

  test("concurrent page reads of one query share one snapshot scan", async () => {
    await databaseService.writeLogPreviews({
      "/test/logs/a.json": preview({ task_id: "t-a" }),
      "/test/logs/b.json": preview({ task_id: "t-b" }),
    });
    const readLogsSpy = vi.spyOn(databaseService, "readLogs");

    const data = createData();
    const [first, second] = await Promise.all([
      data.getPage(undefined, undefined, {
        cursor: null,
        direction: "forward",
        limit: 1,
      }),
      data.getPage(undefined, undefined, {
        cursor: { offset: 1 },
        direction: "forward",
        limit: 1,
      }),
    ]);
    // The promise-valued cache dedupes: both pages await the same build.
    expect(readLogsSpy).toHaveBeenCalledTimes(1);
    expect(first.items).toHaveLength(1);
    expect(second.items).toHaveLength(1);
  });

  test("a single page holding the whole universe matches the unpaged read", async () => {
    await databaseService.writeLogPreviews({
      "/test/logs/a.json": preview({ task_id: "t-a" }),
      "/test/logs/b.json": preview({ task_id: "t-b" }),
    });

    const data = createData();
    const paged = await data.getPage(undefined, undefined, {
      cursor: null,
      direction: "forward",
      limit: 100,
    });
    const unpaged = await readLogsListing(
      "/test/logs",
      "/test/logs",
      identityRow,
      createListingPlan({ getValue, getComparator: () => undefined })
    );
    // The snapshot-scoped aggregate rides beside the parity fields.
    const { universe_task_ids, ...parityFields } = paged;
    expect(parityFields).toEqual(unpaged);
    expect([...(universe_task_ids ?? [])].sort()).toEqual(["t-a", "t-b"]);
    expect(paged.next_cursor).toBeNull();
  });

  test("serves a backward page as the slice before the cursor", async () => {
    await databaseService.writeLogPreviews({
      "/test/logs/a.json": preview({ task_id: "t-a" }),
      "/test/logs/b.json": preview({ task_id: "t-b" }),
      "/test/logs/c.json": preview({ task_id: "t-c" }),
    });
    const orderBy = [{ column: "name", direction: "ASC" as const }];

    const data = createData();
    // Null backward cursor: from the end of the result.
    const tail = await data.getPage(undefined, orderBy, {
      cursor: null,
      direction: "backward",
      limit: 2,
    });
    expect(tail.items.map((row) => row.name)).toEqual([
      "/test/logs/b.json",
      "/test/logs/c.json",
    ]);
    expect(tail.next_cursor).toEqual({ offset: 1 });

    const head = await data.getPage(undefined, orderBy, {
      cursor: tail.next_cursor,
      direction: "backward",
      limit: 2,
    });
    expect(head.items.map((row) => row.name)).toEqual(["/test/logs/a.json"]);
    expect(head.next_cursor).toBeNull();
  });

  test("drops holes for keys deleted between snapshot and page read", async () => {
    await databaseService.writeLogPreviews({
      "/test/logs/a.json": preview({ task_id: "t-a" }),
      "/test/logs/b.json": preview({ task_id: "t-b" }),
      "/test/logs/c.json": preview({ task_id: "t-c" }),
      "/test/logs/d.json": preview({ task_id: "t-d" }),
    });
    const orderBy = [{ column: "name", direction: "ASC" as const }];

    // Prime the snapshot, then delete a row from a later page's slice.
    const data = createData();
    const first = await data.getPage(undefined, orderBy, {
      cursor: null,
      direction: "forward",
      limit: 2,
    });
    await databaseService.clearCacheForFile("/test/logs/c.json");

    const second = await data.getPage(undefined, orderBy, {
      cursor: first.next_cursor,
      direction: "forward",
      limit: 2,
    });
    expect(second.items.map((row) => row.name)).toEqual(["/test/logs/d.json"]);
    // The cursor indexes the (stale-until-invalidated) key list, not served
    // rows — total_count updates on the next snapshot rebuild.
    expect(second.total_count).toBe(4);
    expect(second.next_cursor).toBeNull();
  });

  test("drops holes for records mutated out of the filter between snapshot and page read", async () => {
    await databaseService.writeLogPreviews({
      "/test/logs/a.json": preview({ model: "gpt-4", task_id: "t-a" }),
      "/test/logs/b.json": preview({ model: "gpt-4o", task_id: "t-b" }),
      "/test/logs/c.json": preview({ model: "gpt-5", task_id: "t-c" }),
      "/test/logs/d.json": preview({ model: "gpt-4.1", task_id: "t-d" }),
    });
    const filter = new Column("model").ilike("gpt%");
    const orderBy = [{ column: "name", direction: "ASC" as const }];

    // Prime the snapshot, then a replication write flips a later-page row
    // out of the filter before its page is read.
    const data = createData();
    const first = await data.getPage(filter, orderBy, {
      cursor: null,
      direction: "forward",
      limit: 2,
    });
    await databaseService.writeLogPreviews({
      "/test/logs/c.json": preview({ model: "claude", task_id: "t-c" }),
    });

    // The page must not serve a row the active filter excludes — it runs
    // short (like a deleted key) until the next invalidation rebuilds the
    // key list.
    const second = await data.getPage(filter, orderBy, {
      cursor: first.next_cursor,
      direction: "forward",
      limit: 2,
    });
    expect(second.items.map((row) => row.name)).toEqual(["/test/logs/d.json"]);
    expect(second.total_count).toBe(4);
    expect(second.next_cursor).toBeNull();
  });

  test("pages carry the filtered universe's distinct task ids for the pending anti-join", async () => {
    await databaseService.writeLogPreviews({
      "/test/logs/a.json": preview({ model: "gpt-4", task_id: "t-a" }),
      "/test/logs/b.json": preview({ model: "gpt-4o", task_id: "t-b" }),
      "/test/logs/c.json": preview({ model: "claude", task_id: "t-c" }),
    });
    const filter = new Column("model").ilike("gpt%");

    // Every page reports the whole filtered universe's task ids (parity with
    // the pre-pagination anti-join, which saw the full filtered row set) —
    // a pending task whose file sits on an unloaded page must still settle.
    const data = createData();
    const first = await data.getPage(filter, undefined, {
      cursor: null,
      direction: "forward",
      limit: 1,
    });
    expect([...(first.universe_task_ids ?? [])].sort()).toEqual(["t-a", "t-b"]);
    const second = await data.getPage(filter, undefined, {
      cursor: first.next_cursor,
      direction: "forward",
      limit: 1,
    });
    expect([...(second.universe_task_ids ?? [])].sort()).toEqual([
      "t-a",
      "t-b",
    ]);
  });

  test("a failed bulk read rejects the page instead of serving deleted-key holes", async () => {
    await databaseService.writeLogPreviews({
      "/test/logs/a.json": preview({ task_id: "t-a" }),
      "/test/logs/b.json": preview({ task_id: "t-b" }),
      "/test/logs/c.json": preview({ task_id: "t-c" }),
    });
    const data = createData();
    const first = await data.getPage(undefined, undefined, {
      cursor: null,
      direction: "forward",
      limit: 2,
    });

    // A transient store failure must surface as a page error (React Query
    // error state → banner, paused auto-fetch) — an empty page would be
    // indistinguishable from mass deletion and silently truncate the list.
    vi.spyOn(databaseService, "readLogRows").mockRejectedValue(
      new Error("InvalidStateError: database is closing")
    );
    await expect(
      data.getPage(undefined, undefined, {
        cursor: first.next_cursor,
        direction: "forward",
        limit: 2,
      })
    ).rejects.toThrow("database is closing");
  });

  test("an epoch bump rebuilds the snapshot and streams new rows in", async () => {
    await databaseService.writeLogPreviews({
      "/test/logs/a.json": preview({ task_id: "t-a" }),
    });
    const data = createData();
    const before = await data.getPage(undefined, undefined, {
      cursor: null,
      direction: "forward",
      limit: 5,
    });
    expect(before.total_count).toBe(1);

    // A replication write lands and the write path bumps the listing epoch:
    // the cached snapshot must rebuild on the next page read, not serve its
    // stale keys.
    await databaseService.writeLogPreviews({
      "/test/logs/b.json": preview({ task_id: "t-b" }),
    });
    bumpLogsListingEpoch();

    const after = await data.getPage(undefined, undefined, {
      cursor: null,
      direction: "forward",
      limit: 5,
    });
    expect(after.total_count).toBe(2);
    expect(after.items.map((row) => row.name).sort()).toEqual([
      "/test/logs/a.json",
      "/test/logs/b.json",
    ]);
  });

  test("cache-only scopes fall back to the scan path as one full page", async () => {
    setRows("/cache/logs", [
      { name: "/cache/logs/a.json", task: "t" } as Log,
      { name: "/cache/logs/b.json", task: "t" } as Log,
    ]);
    await databaseService.closeDatabase();

    const data = createData({ logDir: "/cache/logs", prefix: "/cache/logs" });
    const page = await data.getPage(undefined, undefined, {
      cursor: null,
      direction: "forward",
      limit: 1,
    });
    // The whole listing in one page: cache-only scopes don't paginate.
    expect(page.items.map((row) => row.name)).toEqual([
      "/cache/logs/a.json",
      "/cache/logs/b.json",
    ]);
    expect(page.total_count).toBe(2);
    expect(page.next_cursor).toBeNull();
  });
});

describe("readLogsOverview", () => {
  let databaseService: DatabaseService;

  beforeEach(async () => {
    databaseService = createDatabaseService();
    holder.service = databaseService;
    await databaseService.openDatabase();
  });

  afterEach(async () => {
    await databaseService.closeDatabase();
    await Dexie.delete(DB_NAME);
  });

  const directChildOf =
    (dir: string) =>
    (log: LogListingRow): boolean =>
      new RegExp(`^${dir}/[^/]+$`).test(log.name);

  test("aggregates folders, counts, and task ids in one scan", async () => {
    await databaseService.writeLogPreviews({
      "/test/logs/a.json": preview({ task_id: "t-a", status: "started" }),
      "/test/logs/b.json": preview({ task_id: "t-b" }),
      "/test/logs/sub/c.json": preview({ task_id: "t-c" }),
      "/test/logs/sub/d.json": preview({ task_id: "t-d" }),
    });

    const overview = await readLogsOverview("/test/logs", {
      folderDir: "/test/logs",
      showRetriedLogs: false,
      isCandidate: directChildOf("/test/logs"),
    });

    expect(overview.taskIds.sort()).toEqual(["t-a", "t-b", "t-c", "t-d"]);
    expect(overview.fileCount).toBe(2);
    expect(overview.startedCount).toBe(1);
    expect(overview.retriedCount).toBe(0);
    expect(overview.soleFileName).toBeUndefined();
    expect(overview.folders).toEqual([{ name: "sub", itemCount: 2 }]);
  });

  test("folder counts don't bleed into prefix-sharing siblings or clip to a nested subtree", async () => {
    await databaseService.writeLogPreviews({
      // "sub" is a name-prefix of "sub2": each must count only its own logs.
      "/test/logs/sub/nested/a.json": preview({ task_id: "t-a" }),
      "/test/logs/sub/b.json": preview({ task_id: "t-b" }),
      "/test/logs/sub2/c.json": preview({ task_id: "t-c" }),
      "/test/logs/sub2/d.json": preview({ task_id: "t-d" }),
      "/test/logs/sub2/e.json": preview({ task_id: "t-e" }),
    });

    const overview = await readLogsOverview("/test/logs", {
      folderDir: "/test/logs",
      showRetriedLogs: false,
      isCandidate: directChildOf("/test/logs"),
    });

    // "sub" counts its whole subtree even when first seen via the nested
    // file; "sub2" isn't inflated by "sub" rows (nor vice versa).
    const folders = [...overview.folders].sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    expect(folders).toEqual([
      { name: "sub", itemCount: 2 },
      { name: "sub2", itemCount: 3 },
    ]);
  });

  test("counts retried runs and applies retried-hiding to file facts", async () => {
    await databaseService.writeLogPreviews({
      "/test/logs/2024-01-01_task.json": preview({ task_id: "shared" }),
      "/test/logs/2024-01-02_task.json": preview({ task_id: "shared" }),
    });
    const view = {
      showRetriedLogs: false,
      isCandidate: directChildOf("/test/logs"),
    };

    const hidden = await readLogsOverview("/test/logs", view);
    expect(hidden.fileCount).toBe(1);
    expect(hidden.retriedCount).toBe(1);
    expect(hidden.soleFileName).toBe("/test/logs/2024-01-02_task.json");
    expect(hidden.folders).toEqual([]);

    const shown = await readLogsOverview("/test/logs", {
      ...view,
      showRetriedLogs: true,
    });
    expect(shown.fileCount).toBe(2);
    expect(shown.retriedCount).toBe(1);
    expect(shown.soleFileName).toBeUndefined();
  });
});

describe("LogsListingData.getMatches", () => {
  let databaseService: DatabaseService;

  const createData = (): LogsListingData<Log> =>
    createLogsListingData<Log>({
      logDir: "/test/logs",
      prefix: "/test/logs",
      toRow: (log: LogListingRow) => log,
      getValue,
      getComparator: () => undefined,
    });

  beforeEach(async () => {
    databaseService = createDatabaseService();
    holder.service = databaseService;
    await databaseService.openDatabase();
  });

  afterEach(async () => {
    await databaseService.closeDatabase();
    await Dexie.delete(DB_NAME);
  });

  test("overlaps the snapshot build with the match scan (no serialized table reads)", async () => {
    await databaseService.writeLogPreviews({
      "/test/logs/a.json": preview({ task: "alpha", task_id: "t-a" }),
      "/test/logs/b.json": preview({ task: "beta", task_id: "t-b" }),
    });
    // Gate every store read: with a cold snapshot both the snapshot build
    // and the match scan need a full table read, and neither depends on the
    // other's result — serializing them doubles per-keystroke match latency.
    const original = databaseService.readLogs.bind(databaseService);
    const release: Array<() => void> = [];
    const readLogsSpy = vi
      .spyOn(databaseService, "readLogs")
      .mockImplementation(
        (...args) =>
          new Promise((resolve) => {
            release.push(() => resolve(original(...args)));
          })
      );

    const pending = createData().getMatches(undefined, undefined, {
      pageSize: 2,
      term: "alpha",
      getRowId: (row) => row.name,
      rowText: (row) => `${row.name}\n${row.task ?? ""}`.toLowerCase(),
    });

    // Both reads must be in flight before either resolves.
    await vi.waitFor(() => expect(readLogsSpy).toHaveBeenCalledTimes(2));
    release.forEach((releaseRead) => releaseRead());

    const matches = await pending;
    expect(matches.map((match) => match.id)).toEqual(["/test/logs/a.json"]);
  });

  test("returns matching row ids and snapshot offsets under the active filter", async () => {
    await databaseService.writeLogPreviews({
      "/test/logs/a.json": preview({ task: "alpha", task_id: "t-a" }),
      "/test/logs/b.json": preview({
        task: "beta",
        task_id: "t-b",
        model: "gpt-4o",
      }),
      "/test/logs/c.json": preview({ task: "alphabet", task_id: "t-c" }),
      // Text matches the term but the filter excludes it: matches must
      // respect the same filter as the row query.
      "/test/logs/d.json": preview({
        task: "alpha",
        task_id: "t-d",
        model: "claude",
      }),
    });

    const filter = new Column("model").ilike("gpt%");
    const orderBy = [{ column: "name", direction: "DESC" as const }];
    const matches = await createData().getMatches(filter, orderBy, {
      pageSize: 2,
      // Lowercased per rowText's contract; the term may be any case.
      term: "ALPHA",
      getRowId: (row) => row.name,
      rowText: (row) => `${row.name}\n${row.task ?? ""}`.toLowerCase(),
    });

    expect(matches).toEqual([
      {
        id: "/test/logs/c.json",
        offset: 0,
        orderValues: { name: "/test/logs/c.json" },
      },
      {
        id: "/test/logs/a.json",
        offset: 2,
        orderValues: { name: "/test/logs/a.json" },
      },
    ]);
  });

  test("keeps match offsets tied to the cached page snapshot", async () => {
    await databaseService.writeLogPreviews({
      "/test/logs/b.json": preview({ task: "match", task_id: "t-b" }),
      "/test/logs/c.json": preview({ task: "match", task_id: "t-c" }),
    });
    const orderBy = [{ column: "name", direction: "ASC" as const }];

    const data = createData();
    await data.getPage(undefined, orderBy, {
      cursor: null,
      direction: "forward",
      limit: 1,
    });
    // No invalidation: the new leading row is not part of the page
    // snapshot, so it must not shift or join the match projection.
    await databaseService.writeLogPreviews({
      "/test/logs/a.json": preview({ task: "match", task_id: "t-a" }),
    });

    const matches = await data.getMatches(undefined, orderBy, {
      pageSize: 1,
      term: "match",
      getRowId: (row) => row.name,
      rowText: (row) => row.task ?? "",
    });
    expect(matches).toEqual([
      {
        id: "/test/logs/b.json",
        offset: 0,
        orderValues: { name: "/test/logs/b.json" },
      },
      {
        id: "/test/logs/c.json",
        offset: 1,
        orderValues: { name: "/test/logs/c.json" },
      },
    ]);
  });
});
