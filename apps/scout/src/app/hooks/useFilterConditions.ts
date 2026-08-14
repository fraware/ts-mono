import { useStore } from "../../state/store";

import { combineColumnFilters } from "./combineColumnFilters";

/**
 * Build a combined filter condition from column filters.
 * @param excludeColumnId - Optional column ID to exclude from the condition
 */
export const useFilterConditions = (excludeColumnId?: string) => {
  const columnFilters =
    useStore((state) => state.transcriptsTableState.columnFilters) ?? {};
  return combineColumnFilters(columnFilters, excludeColumnId);
};
