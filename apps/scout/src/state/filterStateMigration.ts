const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Version 1 persisted compiled query conditions in the table filter maps.
 * Version 2 persists shared FilterSpecs instead. The old wildcard/operator
 * vocabulary is not losslessly convertible, so drop only those filter maps
 * and preserve every other persisted preference.
 */
export const migrateFilterState = (
  persistedState: unknown,
  version: number
): unknown => {
  if (version >= 2 || !isRecord(persistedState)) {
    return persistedState;
  }

  const next = { ...persistedState };
  for (const key of ["transcriptsTableState", "scansTableState"] as const) {
    const tableState = next[key];
    if (isRecord(tableState)) {
      next[key] = { ...tableState, columnFilters: {} };
    }
  }
  return next;
};
