import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { Column } from "@tsmono/inspect-common/query";
import type { Condition } from "@tsmono/inspect-common/query";

import type { Cursor } from "../../../client/database/listing";
import type {
  LogListingRow,
  LogsListingMatch,
  LogsListingPageQuery,
} from "../../../log_data";

import {
  useDatabaseLogsListingQuery,
  useLogsListingMatches,
  useLogsListingOverlayOffsets,
} from "./useLogsListingQuery";

interface Row {
  name: string;
  model: string;
  [k: string]: unknown;
}

type ReadListingPage = <TRow>(
  query: LogsListingPageQuery<TRow>,
  page: { cursor?: Cursor | null; limit: number }
) => Promise<{
  items: TRow[];
  total_count: number;
  next_cursor: Cursor | null;
}>;

const holder = vi.hoisted(() => ({
  records: [] as { name: string; model?: string }[],
  read: vi.fn(),
  readMatches: vi.fn(),
  readOverlayOffsets: vi.fn(),
}));

vi.mock("../../../log_data", () => ({
  databaseLogsListingKeyRoot: ["log_data", "dexie-listing", "logs"],
  databaseLogsListingKey: (...parts: unknown[]) => [
    "log_data",
    "dexie-listing",
    "logs",
    ...parts.map((part) => part ?? null),
  ],
  listingKeyUniverse: (queryKey: readonly unknown[]) => queryKey[3],
  logsListingSource: () => "database",
  readLogsListingPage: (
    ...args: Parameters<ReadListingPage>
  ): ReturnType<ReadListingPage> =>
    holder.read(...args) as ReturnType<ReadListingPage>,
  readLogsListingMatches: (...args: unknown[]): Promise<LogsListingMatch[]> =>
    holder.readMatches(...args) as Promise<LogsListingMatch[]>,
  readLogsListingOverlayOffsets: (...args: unknown[]): Promise<number[]> =>
    holder.readOverlayOffsets(...args) as Promise<number[]>,
}));

const records = [
  { name: "/logs/b.eval", model: "claude" },
  { name: "/logs/a.eval", model: "gpt-4" },
];

const getValue = (row: Row, column: string): unknown => row[column];
const toRow = (log: LogListingRow): Row | undefined =>
  log.model === undefined
    ? undefined
    : { name: log.name, model: log.model ?? "" };

const listingParams = (overrides?: {
  filter?: Condition;
  orderBy?: { column: string; direction: "ASC" | "DESC" }[];
  universe?: string | undefined;
  accessorsKey?: string;
}) => ({
  filter: overrides?.filter,
  orderBy: overrides?.orderBy,
  getValue,
  getComparator: () => undefined,
  accessorsKey: overrides?.accessorsKey ?? "",
  listing: {
    logDir: "/logs",
    prefix: "/logs",
    universe:
      overrides && "universe" in overrides ? overrides.universe : "logs::/logs",
    toRow,
  },
});

describe("useDatabaseLogsListingQuery", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    holder.records = records;
    holder.read.mockReset();
    // The seam double: run the plan over the fake records and slice the
    // requested page, like readLogsListingPage over the snapshot.
    holder.read.mockImplementation(
      (
        query: LogsListingPageQuery<Row>,
        page: { cursor?: Cursor | null; limit: number }
      ) => {
        const rows = holder.records
          .map((record) => query.toRow(record as LogListingRow))
          .filter((row): row is Row => row !== undefined)
          .filter(query.plan.matches);
        if (query.plan.compare) rows.sort(query.plan.compare);
        const offset =
          typeof page.cursor?.offset === "number" ? page.cursor.offset : 0;
        const end = offset + page.limit;
        return Promise.resolve({
          items: rows.slice(offset, end),
          total_count: rows.length,
          next_cursor: end < rows.length ? { offset: end } : null,
        });
      }
    );
  });

  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  const loadedNames = (data?: { loadedRows: Row[] }) =>
    data?.loadedRows.map((row) => row.name);

  test("shapes and queries source records through the listing seam", async () => {
    const { result } = renderHook(
      () =>
        useDatabaseLogsListingQuery<Row>(
          listingParams({
            filter: new Column("model").eq("gpt-4"),
            orderBy: [{ column: "name", direction: "ASC" }],
          })
        ),
      { wrapper }
    );

    expect(result.current.result.loading).toBe(true);
    await waitFor(() =>
      expect(loadedNames(result.current.result.data)).toEqual(["/logs/a.eval"])
    );
    expect(result.current.result.loading).toBe(false);
    expect(result.current.result.data?.total_count).toBe(1);
    expect(result.current.result.data?.rowAt(0)?.name).toBe("/logs/a.eval");
    expect(result.current.result.data?.rowAt(1)).toBeUndefined();
  });

  test("queries the seam even without an active filter", async () => {
    const { result } = renderHook(
      () => useDatabaseLogsListingQuery<Row>(listingParams()),
      { wrapper }
    );

    // Source (listing) order is preserved when no sort is active.
    await waitFor(() =>
      expect(loadedNames(result.current.result.data)).toEqual([
        "/logs/b.eval",
        "/logs/a.eval",
      ])
    );
  });

  test("passes the page's universe task ids through the window", async () => {
    holder.read.mockImplementation(() =>
      Promise.resolve({
        items: [],
        total_count: 0,
        next_cursor: null,
        universe_task_ids: ["t-1", "t-2"],
      })
    );
    const { result } = renderHook(
      () => useDatabaseLogsListingQuery<Row>(listingParams()),
      { wrapper }
    );

    await waitFor(() =>
      expect(result.current.result.data?.universe_task_ids).toEqual([
        "t-1",
        "t-2",
      ])
    );
  });

  test("stays disabled (pending) while the universe is hydrating", async () => {
    const { result } = renderHook(
      () =>
        useDatabaseLogsListingQuery<Row>(
          listingParams({ universe: undefined })
        ),
      { wrapper }
    );

    await Promise.resolve();
    expect(holder.read).not.toHaveBeenCalled();
    expect(result.current.result.loading).toBe(true);
    expect(result.current.result.data).toBeUndefined();
  });

  test("holds the previous window across re-filters within one universe", async () => {
    const { result, rerender } = renderHook(
      (props) => useDatabaseLogsListingQuery<Row>(props),
      {
        wrapper,
        initialProps: listingParams({
          filter: new Column("model").eq("gpt-4"),
        }),
      }
    );
    await waitFor(() =>
      expect(loadedNames(result.current.result.data)).toEqual(["/logs/a.eval"])
    );

    // Re-filter: the previous key's window — rows AND total — keeps showing
    // (no blank/loading flash) until the new key's pages land, then both
    // swap in one commit.
    rerender(listingParams({ filter: new Column("model").eq("claude") }));
    expect(result.current.result.loading).toBe(false);
    expect(loadedNames(result.current.result.data)).toEqual(["/logs/a.eval"]);
    expect(result.current.result.data?.total_count).toBe(1);
    await waitFor(() =>
      expect(loadedNames(result.current.result.data)).toEqual(["/logs/b.eval"])
    );
    expect(result.current.result.data?.total_count).toBe(1);
  });

  test("re-queries when the accessor schema lands, holding the window", async () => {
    const { result, rerender } = renderHook(
      (props) => useDatabaseLogsListingQuery<Row>(props),
      {
        wrapper,
        initialProps: listingParams({ accessorsKey: "" }),
      }
    );
    await waitFor(() => expect(result.current.result.data).toBeDefined());
    expect(holder.read).toHaveBeenCalledTimes(1);

    // The scorer schema arriving changes what the plan computes without any
    // other query input changing — same universe, so the previous window
    // keeps showing while the re-evaluated read is in flight.
    rerender(listingParams({ accessorsKey: "grader/accuracy:number" }));
    expect(result.current.result.loading).toBe(false);
    expect(result.current.result.data).toBeDefined();
    await waitFor(() => expect(holder.read).toHaveBeenCalledTimes(2));
  });

  test("surfaces a failed read as an error, not an empty listing", async () => {
    holder.read.mockRejectedValue(new Error("scan failed"));
    const { result } = renderHook(
      () => useDatabaseLogsListingQuery<Row>(listingParams()),
      { wrapper }
    );

    await waitFor(() => expect(result.current.result.error).toBeDefined());
    expect(result.current.result.error?.message).toBe("scan failed");
    expect(result.current.result.loading).toBe(false);
    expect(result.current.result.data).toBeUndefined();
    expect(result.current.error).toBeDefined();
  });

  test("fetches the page at a jumped-to offset directly, holding the window across the gap", async () => {
    const { result } = renderHook(
      () => useDatabaseLogsListingQuery<Row>(listingParams()),
      { wrapper }
    );
    await waitFor(() => expect(result.current.result.data).toBeDefined());
    expect(holder.read).toHaveBeenCalledTimes(1);

    // A jump far past every observed page (e.g. Find navigating to a match
    // on an unloaded page): the page at that offset is fetched directly —
    // no sequential walk — and while it loads the published window (and
    // with it the total driving the scrollbar) must not collapse.
    act(() => result.current.setVisibleRange({ start: 750, end: 760 }));
    expect(result.current.result.loading).toBe(false);
    expect(result.current.result.data?.total_count).toBe(2);

    await waitFor(() =>
      expect(holder.read).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ cursor: { offset: 500 } })
      )
    );
    expect(holder.read).toHaveBeenCalledTimes(2);
  });

  test("keeps retained rows through a failed refetch, reporting the error beside them", async () => {
    const { result } = renderHook(
      () => useDatabaseLogsListingQuery<Row>(listingParams()),
      { wrapper }
    );
    await waitFor(() =>
      expect(loadedNames(result.current.result.data)).toEqual([
        "/logs/b.eval",
        "/logs/a.eval",
      ])
    );
    expect(result.current.error).toBeUndefined();

    // An invalidation refetch fails — the loaded rows must keep serving
    // (warm), with the failure reported beside them rather than through
    // the AsyncData.
    holder.read.mockRejectedValue(new Error("scan failed"));
    await act(() => queryClient.invalidateQueries());
    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(loadedNames(result.current.result.data)).toEqual([
      "/logs/b.eval",
      "/logs/a.eval",
    ]);
    expect(result.current.result.error).toBeUndefined();

    // Recovery: an invalidation refetch (retry banner / write path / sync)
    // that succeeds clears the error and keeps the rows.
    holder.read.mockImplementation(() =>
      Promise.resolve({
        items: [{ name: "/logs/b.eval", model: "claude" }],
        total_count: 1,
        next_cursor: null,
      })
    );
    await act(() => queryClient.invalidateQueries());
    await waitFor(() => expect(result.current.error).toBeUndefined());
    expect(result.current.result.data?.total_count).toBe(1);
  });

  test("an invalidation refetches only the observed pages", async () => {
    holder.records = Array.from({ length: 600 }, (_, i) => ({
      name: `/logs/${String(i).padStart(3, "0")}.eval`,
      model: "claude",
    }));

    const { result } = renderHook(
      () => useDatabaseLogsListingQuery<Row>(listingParams()),
      { wrapper }
    );
    await waitFor(() => expect(result.current.result.data).toBeDefined());

    // Observe pages 0 and 1, then scroll back so only page 0 is observed.
    act(() => result.current.setVisibleRange({ start: 450, end: 520 }));
    await waitFor(() =>
      expect(result.current.result.data?.loadedRows.length).toBe(600)
    );
    act(() => result.current.setVisibleRange({ start: 0, end: 10 }));
    await waitFor(() =>
      expect(result.current.result.data?.loadedRows.length).toBe(500)
    );

    // Page 1 left observation: the invalidation must refetch page 0 only
    // (page 1 goes stale and refetches on its next observation).
    holder.read.mockClear();
    await act(() => queryClient.invalidateQueries());
    await waitFor(() => expect(holder.read).toHaveBeenCalled());
    for (const call of holder.read.mock.calls) {
      expect(call[1]).toEqual(
        expect.objectContaining({ cursor: { offset: 0 } })
      );
    }
  });

  test("does not serve one universe's rows to another", async () => {
    const { result, rerender } = renderHook(
      (props) => useDatabaseLogsListingQuery<Row>(props),
      {
        wrapper,
        initialProps: listingParams({ universe: "logs::/logs" }),
      }
    );
    await waitFor(() => expect(result.current.result.data).toBeDefined());

    // A different universe (e.g. the flat tasks view at the same prefix)
    // must not show the folder view's rows while its own read is in flight.
    rerender(listingParams({ universe: "tasks::/logs" }));
    expect(result.current.result.data).toBeUndefined();
    expect(result.current.result.loading).toBe(true);
    await waitFor(() => expect(result.current.result.data).toBeDefined());
  });
});

describe("useLogsListingOverlayOffsets", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    holder.readOverlayOffsets.mockReset();
    holder.readOverlayOffsets.mockResolvedValue([1]);
  });

  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  const offsetsParams = (overrides?: {
    orderBy?: { column: string; direction: "ASC" | "DESC" }[];
    rows?: Row[];
  }) => ({
    ...listingParams({ orderBy: overrides?.orderBy }),
    rows: overrides?.rows ?? [{ name: "/logs/p.eval", model: "pending" }],
  });

  test("resolves offsets through the seam under an active sort", async () => {
    const { result } = renderHook(
      () =>
        useLogsListingOverlayOffsets<Row>(
          offsetsParams({ orderBy: [{ column: "name", direction: "ASC" }] })
        ),
      { wrapper }
    );
    await waitFor(() => expect(result.current).toEqual([1]));
  });

  test("never runs without an active sort (callers append at the end)", async () => {
    const { result } = renderHook(
      () => useLogsListingOverlayOffsets<Row>(offsetsParams()),
      { wrapper }
    );
    await Promise.resolve();
    expect(holder.readOverlayOffsets).not.toHaveBeenCalled();
    expect(result.current).toBeUndefined();
  });
});

describe("useLogsListingMatches", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    holder.records = records;
    holder.readMatches.mockReset();
    // The seam double: lowercase-contains over the shaped records, like
    // readLogsListingMatches over the scanned rows.
    holder.readMatches.mockImplementation(
      (
        query: LogsListingPageQuery<Row>,
        find: {
          pageSize: number;
          term: string;
          getRowId: (row: Row) => string;
          getOrderValue: (row: Row, columnId: string) => unknown;
          rowText: (row: Row) => string;
        }
      ) => {
        const rows = holder.records
          .map((record) => query.toRow(record as LogListingRow))
          .filter((row): row is Row => row !== undefined)
          .filter(query.plan.matches);
        if (query.plan.compare) rows.sort(query.plan.compare);
        return Promise.resolve(
          rows
            .map((row, offset) => ({ row, offset }))
            .filter(({ row }) =>
              find.rowText(row).includes(find.term.toLowerCase())
            )
            .map(({ row, offset }) => {
              const match = { id: find.getRowId(row), offset };
              return query.orderBy?.length
                ? {
                    ...match,
                    orderValues: Object.fromEntries(
                      query.orderBy.map(({ column }) => [
                        column,
                        find.getOrderValue(row, column),
                      ])
                    ),
                  }
                : match;
            })
        );
      }
    );
  });

  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  const matchesParams = (overrides?: {
    term?: string;
    enabled?: boolean;
    universe?: string;
  }) => ({
    ...listingParams({ universe: overrides?.universe ?? "logs::/logs" }),
    term: overrides?.term ?? "",
    enabled: overrides?.enabled ?? true,
    getRowId: (row: Row) => row.name,
    rowText: (row: Row) => `${row.name}\n${row.model}`.toLowerCase(),
    searchKey: ["name", "model"],
  });

  test("reports ids as settled only after the debounced term's result lands", async () => {
    const { result, rerender } = renderHook(
      (props) => useLogsListingMatches<Row>(props),
      { wrapper, initialProps: matchesParams() }
    );

    rerender(matchesParams({ term: "claude" }));
    // Debounce not flushed: no matches for the live term yet, and no
    // "no results" claim may be made.
    expect(result.current.matches).toBeUndefined();
    expect(result.current.settled).toBe(false);

    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.matches).toEqual([{ id: "/logs/b.eval", offset: 0 }]);
  });

  test("keeps the previous term's matches as a placeholder but reports unsettled", async () => {
    const { result, rerender } = renderHook(
      (props) => useLogsListingMatches<Row>(props),
      { wrapper, initialProps: matchesParams({ term: "claude" }) }
    );
    await waitFor(() => expect(result.current.settled).toBe(true));

    // New term: the previous ids keep showing (no flash to empty), but the
    // result must not read as settled — a "no results" gate on pending
    // alone would fire here while the new term's scan is in flight.
    rerender(matchesParams({ term: "zzz" }));
    expect(result.current.matches).toEqual([{ id: "/logs/b.eval", offset: 0 }]);
    expect(result.current.settled).toBe(false);

    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.matches).toEqual([]);
  });

  test("does not serve one universe's matches to another", async () => {
    const { result, rerender } = renderHook(
      (props) => useLogsListingMatches<Row>(props),
      {
        wrapper,
        initialProps: matchesParams({ term: "claude" }),
      }
    );
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.matches).toEqual([{ id: "/logs/b.eval", offset: 0 }]);

    // Folder-mode ids are basenames, so another scope's matches could mark
    // unrelated same-named rows as matches — they must not carry over.
    rerender(matchesParams({ term: "claude", universe: "tasks::/logs" }));
    expect(result.current.matches).toBeUndefined();
    expect(result.current.settled).toBe(false);
    await waitFor(() => expect(result.current.settled).toBe(true));
  });
});
