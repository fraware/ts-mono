import { describe, expect, it } from "vitest";

import { migrateFilterState } from "./filterStateMigration";

describe("migrateFilterState", () => {
  it("drops legacy table filters and preserves the rest of persisted state", () => {
    const legacy = {
      userTranscriptsDir: "transcripts",
      transcriptsTableState: {
        sorting: [{ id: "date", desc: true }],
        columnFilters: {
          model: {
            columnId: "model",
            filterType: "string",
            condition: {
              is_compound: false,
              left: "model",
              operator: "ILIKE",
              right: "%sonnet%",
            },
          },
        },
      },
      scansTableState: {
        columnOrder: ["name", "status"],
        columnFilters: {
          status: {
            columnId: "status",
            filterType: "string",
            condition: {
              is_compound: false,
              left: "status",
              operator: "=",
              right: "success",
            },
          },
        },
      },
    };

    const migrated = migrateFilterState(legacy, 1) as typeof legacy;

    expect(migrated.userTranscriptsDir).toBe("transcripts");
    expect(migrated.transcriptsTableState.sorting).toEqual(
      legacy.transcriptsTableState.sorting
    );
    expect(migrated.scansTableState.columnOrder).toEqual(
      legacy.scansTableState.columnOrder
    );
    expect(migrated.transcriptsTableState.columnFilters).toEqual({});
    expect(migrated.scansTableState.columnFilters).toEqual({});
    expect(legacy.transcriptsTableState.columnFilters).toHaveProperty("model");
  });

  it("leaves current-version state untouched", () => {
    const state = { transcriptsTableState: { columnFilters: { model: {} } } };

    expect(migrateFilterState(state, 2)).toBe(state);
  });
});
