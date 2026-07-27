import { describe, expect, test, vi } from "vitest";

import { createLogsSlice } from "./logsSlice";
import {
  migratePersistedState,
  StoreState,
  type PersistedState,
} from "./store";

const createHarness = () => {
  const state = {} as StoreState;
  const set = vi.fn((fn: (state: StoreState) => void) => {
    fn(state);
  });
  const get = () => state;

  const slice = createLogsSlice(set, get, {});
  // Deep-clone: the slice's initial state is a module-level object and
  // `set` mutates in place — a shallow copy would leak across harnesses.
  state.logs = structuredClone(slice.logs);
  state.logsActions = slice.logsActions;

  return { state };
};

describe("logsSlice.patchLogsGridState", () => {
  test("creates a missing scope entry with an empty sort", () => {
    const { state } = createHarness();

    state.logsActions.patchLogsGridState("logs::/dir", {
      columnSizing: { task: 200 },
    });

    expect(state.logs.listing.gridStateByScope["logs::/dir"]).toEqual({
      sorting: [],
      columnSizing: { task: 200 },
    });
  });

  test("merges without clobbering fields the patch omits", () => {
    const { state } = createHarness();

    state.logsActions.patchLogsGridState("logs::/dir", {
      selectedRowId: "row-7",
      sorting: [{ id: "task", desc: false }],
    });
    // Reset Filters writes only columnFilters — the selection and sort
    // must survive (regression: the old whole-entry setter dropped them).
    state.logsActions.patchLogsGridState("logs::/dir", { columnFilters: {} });

    const entry = state.logs.listing.gridStateByScope["logs::/dir"];
    expect(entry?.selectedRowId).toBe("row-7");
    expect(entry?.sorting).toEqual([{ id: "task", desc: false }]);
    expect(entry?.columnFilters).toEqual({});
  });

  test("scopes stay independent", () => {
    const { state } = createHarness();

    state.logsActions.patchLogsGridState("logs::/a", {
      selectedRowId: "row-1",
    });
    state.logsActions.patchLogsGridState("logs::/b", {
      selectedRowId: "row-2",
    });

    expect(state.logs.listing.gridStateByScope["logs::/a"]?.selectedRowId).toBe(
      "row-1"
    );
    expect(state.logs.listing.gridStateByScope["logs::/b"]?.selectedRowId).toBe(
      "row-2"
    );
  });
});

describe("migratePersistedState", () => {
  const filter = (columnId: string, value: string) => ({
    columnId,
    filterType: "string" as const,
    spec: { operator: "=" as const, value },
  });

  test("v4 → v5 drops persisted path filters in every scope, keeping the rest", () => {
    // v5 changed the Path column's value from the view-relative name to the
    // record's full path: an old-form path filter can never match again.
    const persisted = {
      logs: {
        listing: {
          columnVisibility: {},
          gridStateByScope: {
            "logs::/a": {
              sorting: [{ id: "completedAt", desc: true }],
              columnFilters: {
                path: filter("path", "2024_task.eval"),
                model: filter("model", "gpt-4"),
              },
            },
            "tasks::/a": {
              sorting: [],
              columnFilters: { path: filter("path", "sub/2024_task.eval") },
            },
            "logs::/b": { sorting: [] },
          },
        },
      },
    } as unknown as PersistedState;

    const migrated = migratePersistedState(persisted, 4);

    const byScope = migrated?.logs.listing.gridStateByScope ?? {};
    expect(byScope["logs::/a"]?.columnFilters).toEqual({
      model: filter("model", "gpt-4"),
    });
    expect(byScope["logs::/a"]?.sorting).toEqual([
      { id: "completedAt", desc: true },
    ]);
    expect(byScope["tasks::/a"]?.columnFilters).toEqual({});
    expect(byScope["logs::/b"]).toEqual({ sorting: [] });
  });

  test("pre-v4 states are discarded, like the no-migrate mismatch before them", () => {
    expect(migratePersistedState({ logs: {} }, 3)).toBeUndefined();
  });
});

describe("logsSlice.patchSamplesGridState", () => {
  test("merges partial updates without clobbering other fields", () => {
    const { state } = createHarness();
    const filters = {
      score: {
        columnId: "score",
        filterType: "number" as const,
        spec: { operator: ">" as const, value: "0.5" },
      },
    };

    state.logsActions.patchSamplesGridState("samplesPanel", {
      columnFilters: filters,
    });
    state.logsActions.patchSamplesGridState("samplesPanel", {
      sorting: [{ id: "task", desc: true }],
    });
    state.logsActions.patchSamplesGridState("samplesPanel", {
      columnSizing: { task: 240 },
    });

    const scope = state.logs.samplesListState.byScope.samplesPanel;
    expect(scope.columnFilters).toEqual(filters);
    expect(scope.sorting).toEqual([{ id: "task", desc: true }]);
    expect(scope.columnSizing).toEqual({ task: 240 });
  });

  test("preserves columnVisibility alongside grid-state patches", () => {
    const { state } = createHarness();

    state.logsActions.setSamplesColumnVisibility("samplesPanel", {
      created: false,
    });
    state.logsActions.patchSamplesGridState("samplesPanel", {
      sorting: [{ id: "model", desc: false }],
    });

    const scope = state.logs.samplesListState.byScope.samplesPanel;
    expect(scope.columnVisibility).toEqual({ created: false });
    expect(scope.sorting).toEqual([{ id: "model", desc: false }]);
  });

  test("a patch can clear a field back to empty", () => {
    const { state } = createHarness();

    state.logsActions.patchSamplesGridState("samplesPanel", {
      columnFilters: {
        task: {
          columnId: "task",
          filterType: "string" as const,
          spec: { operator: "contains" as const, value: "x" },
        },
      },
    });
    state.logsActions.patchSamplesGridState("samplesPanel", {
      columnFilters: {},
    });

    expect(
      state.logs.samplesListState.byScope.samplesPanel.columnFilters
    ).toEqual({});
  });
});
