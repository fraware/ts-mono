import { describe, expect, it } from "vitest";

import type { ColumnFilter } from "@tsmono/inspect-components/columnFilter";

import { combineColumnFilters } from "./combineColumnFilters";

describe("combineColumnFilters", () => {
  const filters: Record<string, ColumnFilter> = {
    model: {
      columnId: "model",
      filterType: "string",
      spec: { operator: "contains", value: "sonnet" },
    },
    score: {
      columnId: "score",
      filterType: "number",
      spec: { operator: ">", value: "0.5" },
    },
  };

  it("compiles specs and ANDs filters across columns", () => {
    expect(combineColumnFilters(filters)?.toJSON()).toEqual({
      is_compound: true,
      left: {
        is_compound: false,
        left: "model",
        operator: "ILIKE",
        right: "%sonnet%",
      },
      operator: "AND",
      right: {
        is_compound: false,
        left: "score",
        operator: ">",
        right: 0.5,
      },
    });
  });

  it("preserves shared AND/OR pairs at the query boundary", () => {
    const paired: Record<string, ColumnFilter> = {
      epoch: {
        columnId: "epoch",
        filterType: "number",
        spec: {
          operator: "=",
          value: "1",
          join: "or",
          second: { operator: "=", value: "3" },
        },
      },
    };

    expect(combineColumnFilters(paired)?.toJSON()).toEqual({
      is_compound: true,
      left: {
        is_compound: false,
        left: "epoch",
        operator: "=",
        right: 1,
      },
      operator: "OR",
      right: {
        is_compound: false,
        left: "epoch",
        operator: "=",
        right: 3,
      },
    });
  });

  it("can exclude the column being queried for suggestions", () => {
    expect(combineColumnFilters(filters, "model")?.toJSON()).toEqual({
      is_compound: false,
      left: "score",
      operator: ">",
      right: 0.5,
    });
  });
});
