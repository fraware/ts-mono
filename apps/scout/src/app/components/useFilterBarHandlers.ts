import { useCallback, useMemo } from "react";

import type {
  ColumnFilter,
  FilterSpec,
} from "@tsmono/inspect-components/columnFilter";

/**
 * Base table state interface that filter bar handlers can work with.
 * Both ScansTableState and TranscriptsTableState conform to this.
 */
interface BaseTableState {
  columnFilters: Record<string, ColumnFilter>;
  visibleColumns?: string[];
  columnOrder: string[];
}

interface FilterBarHandlers {
  /** Update a filter's spec or remove it if the spec is null. */
  handleFilterChange: (columnId: string, spec: FilterSpec | null) => void;
  /** Remove a filter by column ID. */
  removeFilter: (column: string) => void;
  /** Add a new filter, ensuring the column is visible. */
  handleAddFilter: (filter: ColumnFilter) => void;
}

function createFilterBarHandlers<
  TColumnKey extends string,
  TState extends BaseTableState = BaseTableState,
>(
  setTableState: (updater: TState | ((prev: TState) => TState)) => void,
  defaultVisibleColumns: readonly TColumnKey[]
): FilterBarHandlers {
  const handleFilterChange = (columnId: string, spec: FilterSpec | null) => {
    setTableState((prevState) => {
      const newFilters = { ...prevState.columnFilters };
      if (spec === null) {
        delete newFilters[columnId];
      } else {
        const existingFilter = newFilters[columnId];
        if (existingFilter) {
          newFilters[columnId] = {
            ...existingFilter,
            spec,
          };
        }
      }
      return {
        ...prevState,
        columnFilters: newFilters,
      };
    });
  };

  const removeFilter = (column: string) => {
    setTableState((prevState) => {
      const newFilters = { ...prevState.columnFilters };
      delete newFilters[column];
      return {
        ...prevState,
        columnFilters: newFilters,
      };
    });
  };

  const handleAddFilter = (filter: ColumnFilter) => {
    setTableState((prevState) => {
      const columnKey = filter.columnId as TColumnKey;
      const currentVisibleColumns =
        (prevState.visibleColumns as TColumnKey[] | undefined) ??
        ([...defaultVisibleColumns] as TColumnKey[]);
      const needsColumnVisible = !currentVisibleColumns.includes(columnKey);
      const columnOrder = prevState.columnOrder as TColumnKey[];
      const needsColumnOrder =
        columnOrder.length > 0 && !columnOrder.includes(columnKey);

      return {
        ...prevState,
        columnFilters: {
          ...prevState.columnFilters,
          [filter.columnId]: filter,
        },
        ...(needsColumnVisible && {
          visibleColumns: [...currentVisibleColumns, columnKey],
        }),
        ...(needsColumnOrder && {
          columnOrder: [...columnOrder, columnKey],
        }),
      };
    });
  };

  return {
    handleFilterChange,
    removeFilter,
    handleAddFilter,
  };
}

interface UseFilterBarHandlersOptions<
  TColumnKey extends string,
  TState extends BaseTableState = BaseTableState,
> {
  setTableState: (updater: TState | ((prev: TState) => TState)) => void;
  defaultVisibleColumns: readonly TColumnKey[];
}

export function useFilterBarHandlers<
  TColumnKey extends string,
  TState extends BaseTableState = BaseTableState,
>({
  setTableState,
  defaultVisibleColumns,
}: UseFilterBarHandlersOptions<TColumnKey, TState>): FilterBarHandlers {
  const handlers = useMemo(
    () => createFilterBarHandlers(setTableState, defaultVisibleColumns),
    [setTableState, defaultVisibleColumns]
  );

  const handleFilterChange = useCallback(
    (columnId: string, spec: FilterSpec | null) => {
      handlers.handleFilterChange(columnId, spec);
    },
    [handlers]
  );

  const removeFilter = useCallback(
    (column: string) => {
      handlers.removeFilter(column);
    },
    [handlers]
  );

  const handleAddFilter = useCallback(
    (filter: ColumnFilter) => {
      handlers.handleAddFilter(filter);
    },
    [handlers]
  );

  return {
    handleFilterChange,
    removeFilter,
    handleAddFilter,
  };
}
