import { useStore } from "../../state/store";

import { combineColumnFilters } from "./combineColumnFilters";

/**
 * Build a combined filter condition from scans column filters.
 * @param excludeColumnId - Optional column ID to exclude from the condition
 */
export const useScanFilterConditions = (excludeColumnId?: string) => {
  const columnFilters =
    useStore((state) => state.scansTableState.columnFilters) ?? {};
  return combineColumnFilters(columnFilters, excludeColumnId);
};
