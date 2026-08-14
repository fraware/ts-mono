import {
  specToCondition,
  type ColumnFilter,
} from "@tsmono/inspect-components/columnFilter";

import type { Condition } from "../../query";

/** Compile the active per-column specs and AND them at the query boundary. */
export const combineColumnFilters = (
  filters: Record<string, ColumnFilter>,
  excludeColumnId?: string
): Condition | undefined =>
  Object.values(filters).reduce<Condition | undefined>((combined, filter) => {
    if (filter.columnId === excludeColumnId) {
      return combined;
    }
    const condition = specToCondition(
      filter.columnId,
      filter.filterType,
      filter.spec
    );
    if (!condition) {
      return combined;
    }
    return combined ? combined.and(condition) : condition;
  }, undefined);
