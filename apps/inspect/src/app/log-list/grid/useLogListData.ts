import type { SortingState } from "@tanstack/react-table";
import { useCallback, useMemo } from "react";

import type { Condition, OrderByModel } from "@tsmono/inspect-common/query";
import type { ColumnFilter } from "@tsmono/inspect-components/columnFilter";

import { useLogsListing } from "../../../state/hooks";
import { useKeyedMemo } from "../../shared/useKeyedMemo";
import { applyListingQuery } from "../listing/applyListingQuery";
import { combineFilters } from "../listing/combineFilters";
import { buildMergedListingIndex } from "../listing/mergedListingIndex";
import type {
  FilterTypeAccessor,
  ValueAccessor,
  ValueComparator,
} from "../listing/types";
import {
  sortingStateToOrderBy,
  useDatabaseLogsListingQuery,
  useLogsListingOverlayOffsets,
  type ListingVisibleRange,
  type LogsListingDescriptor,
} from "../listing/useLogsListingQuery";
import { FolderLogItem, PendingTaskItem } from "../LogItem";

import { LogListRow } from "./columns/types";
import { buildLogListRow } from "./logListRow";

const kNoRows: LogListRow[] = [];
const kNoOffsets: number[] = [];

/** Pending rows minus the tasks that already have a file row (pending row
 *  ids are task ids; file rows carry their record's task_id). `fileRows` is
 *  only the observed page window under pagination, so the snapshot-scoped
 *  `universeTaskIds` carries the tasks whose files sit on unloaded pages;
 *  the window rows still count too — their bulkGot records can be fresher
 *  than the snapshot (e.g. a preview landing task_id after the scan). */
export const dropSettledPendingRows = (
  pendingRows: LogListRow[],
  fileRows: LogListRow[],
  universeTaskIds?: string[]
): LogListRow[] => {
  if (pendingRows.length === 0) return pendingRows;
  const fileTaskIds = new Set<string>(universeTaskIds);
  for (const row of fileRows) {
    const taskId = row.log?.task_id;
    if (taskId) fileTaskIds.add(taskId);
  }
  if (fileTaskIds.size === 0) return pendingRows;
  return pendingRows.filter((row) => !fileTaskIds.has(row.id));
};

interface UseLogListDataParams {
  /** Presentation rows with no database record: folders (pinned) and
   *  pending tasks (inserted into the file universe at their snapshot
   *  offsets). File rows come from the listing query below. */
  overlayItems: Array<FolderLogItem | PendingTaskItem>;
  /** Per-scope sorting/filters are read under this key (`undefined` while
   *  logDir is still hydrating — defaults apply, nothing is written). */
  scopeKey?: string;
  getValue: ValueAccessor<LogListRow>;
  getComparator: (columnId: string) => ValueComparator | undefined;
  getFilterType?: FilterTypeAccessor;
  /** Cache identity of the accessors (see `useLogListColumns`). */
  accessorsKey: string;
  listing: LogsListingDescriptor<LogListRow>;
}

export interface LogListData {
  /** Total rows the grid virtualizes: folders pinned on top, then the whole
   *  filtered file universe (loaded or not) with pending rows inserted at
   *  their universe offsets. */
  rowCount: number;
  /** Resolve a merged row index to its display row; `undefined` while the
   *  index's page is unloaded (the grid renders a skeleton). */
  rowAt: (index: number) => LogListRow | undefined;
  /** Merged row index of a file's snapshot offset (find-match jumps). */
  fileOffsetToRowIndex: (offset: number) => number;
  /** Merged row index of an overlay (folder / pending) row id, if any —
   *  overlay rows have no snapshot offset, so jumps address them by id. */
  rowIndexById: (id: string) => number | undefined;
  /** Overlay rows (folders + visible pendings) for the find band's local
   *  matching — they have no listing record to match against. */
  overlayRows: LogListRow[];
  /** Feed the grid's rendered row range back to the page queries. */
  onVisibleRangeChange: (range: ListingVisibleRange) => void;
  /** Folders + matching files + pendings (reflects any active filter) —
   *  the footer count. */
  filteredCount: number;
  /** The sorting/filters the query ran under — the grid's controlled state,
   *  passed through so grid and query can't diverge. */
  sorting: SortingState;
  columnFilters?: Record<string, ColumnFilter>;
  /** The compiled query inputs derived from them — passed through for the
   *  find band's match query, so its membership can't drift from the rows
   *  via a second derivation. */
  filter?: Condition;
  orderBy: OrderByModel[];
  /** The listing query has no result to show yet (first read in flight). */
  pending: boolean;
  /** The listing read failed. Warm — the observed pages (or the held
   *  previous window) still render — so keep the grid mounted and surface
   *  this beside it; only when `rowCount` is 0 is there nothing to show. */
  error: Error | undefined;
}

/**
 * The log-list data pipeline: run the scope's persisted sorting/filters as a
 * listing query against the listing source (IndexedDB in dir mode), expose
 * the merged universe as index-addressed rows (folders pinned, pending rows
 * inserted at their snapshot offsets, unloaded pages as `undefined`), and
 * feed the grid's rendered range back into the page queries. Called by
 * LogsPanel; the grid just renders the result.
 */
export const useLogListData = ({
  overlayItems,
  scopeKey,
  getValue,
  getComparator,
  getFilterType,
  accessorsKey,
  listing,
}: UseLogListDataParams): LogListData => {
  const { gridStateByScope } = useLogsListing();

  // Folders and pending tasks are presentation-only rows with no database
  // record; shape them here. Reuse the prior row object for any item whose
  // display inputs are unchanged, so only changed rows pay the rebuild.
  const overlayData: LogListRow[] = useKeyedMemo(
    overlayItems,
    (item) => item.id,
    (item) => [
      item.id,
      item.type,
      item.url,
      item.name,
      item.displayIndex,
      item.type === "folder" ? item.itemCount : undefined,
      item.type === "pending-task" ? item.model : undefined,
    ],
    (item) => buildLogListRow(item)
  );
  const { folders, pendingRows } = useMemo(() => {
    const folders: LogListRow[] = [];
    const pendingRows: LogListRow[] = [];
    for (const row of overlayData) {
      (row.type === "folder" ? folders : pendingRows).push(row);
    }
    return { folders, pendingRows };
  }, [overlayData]);

  // Persisted sort for this scope drives the listing query's orderBy.
  const sorting = useMemo<SortingState>(
    () => (scopeKey ? (gridStateByScope[scopeKey]?.sorting ?? []) : []),
    [gridStateByScope, scopeKey]
  );
  const orderBy = useMemo(() => sortingStateToOrderBy(sorting), [sorting]);

  // Per-scope column filters (persisted), AND-combined into one condition.
  const columnFilters = useMemo(
    () => (scopeKey ? gridStateByScope[scopeKey]?.columnFilters : undefined),
    [gridStateByScope, scopeKey]
  );
  const filter = useMemo(() => combineFilters(columnFilters), [columnFilters]);

  const {
    result: { data: listingWindow, loading: pending },
    error,
    setVisibleRange,
  } = useDatabaseLogsListingQuery<LogListRow>({
    filter,
    orderBy,
    getValue,
    getComparator,
    getFilterType,
    accessorsKey,
    listing,
  });

  // The pending anti-join input (overview.taskIds) and the file rows are two
  // independent async reads of the same store, so a settle-order skew can
  // briefly keep a task's pending row while its first log file already
  // renders. Re-derive against the queried pages: a task with a file row is
  // not pending, whatever the overview's snapshot said.
  const visiblePendingRows = useMemo(
    () =>
      dropSettledPendingRows(
        pendingRows,
        listingWindow?.loadedRows ?? kNoRows,
        listingWindow?.universe_task_ids
      ),
    [pendingRows, listingWindow]
  );

  // Pending tasks have no database record: run the same query over them in
  // memory (filter + sort), then insert the survivors into the universe.
  const pendingOverlayRows = useMemo(
    () =>
      visiblePendingRows.length === 0
        ? kNoRows
        : applyListingQuery(visiblePendingRows, {
            filter,
            orderBy,
            getValue,
            getComparator,
            getFilterType,
          }).items,
    [
      visiblePendingRows,
      filter,
      orderBy,
      getValue,
      getComparator,
      getFilterType,
    ]
  );

  // Exact universe insertion offsets under an active sort (positions the
  // overlay against snapshot order, not the loaded window). Unsorted
  // listings append overlays after the whole universe — no read needed.
  const sortedOverlayOffsets = useLogsListingOverlayOffsets({
    filter,
    orderBy,
    getValue,
    getComparator,
    getFilterType,
    accessorsKey,
    listing,
    rows: pendingOverlayRows,
  });

  const totalCount = listingWindow?.total_count ?? 0;
  const overlayOffsets = useMemo(() => {
    if (pendingOverlayRows.length === 0) return kNoOffsets;
    // Append at the end: the unsorted contract, and the interim placement
    // while a sorted read is still in flight (or sized for a stale set).
    if (
      orderBy.length === 0 ||
      sortedOverlayOffsets === undefined ||
      sortedOverlayOffsets.length !== pendingOverlayRows.length
    ) {
      return pendingOverlayRows.map(() => totalCount);
    }
    return sortedOverlayOffsets;
  }, [pendingOverlayRows, orderBy, sortedOverlayOffsets, totalCount]);

  const mergedIndex = useMemo(
    () => buildMergedListingIndex(folders.length, totalCount, overlayOffsets),
    [folders.length, totalCount, overlayOffsets]
  );

  const rowAt = useCallback(
    (index: number): LogListRow | undefined => {
      const slot = mergedIndex.at(index);
      switch (slot.kind) {
        case "folder":
          return folders[slot.position];
        case "overlay":
          return pendingOverlayRows[slot.position];
        case "file":
          return listingWindow?.rowAt(slot.position);
      }
    },
    [mergedIndex, folders, pendingOverlayRows, listingWindow]
  );

  const fileOffsetToRowIndex = useCallback(
    (offset: number) => mergedIndex.indexOfFileOffset(offset),
    [mergedIndex]
  );

  const rowIndexById = useCallback(
    (id: string): number | undefined => {
      const folderIndex = folders.findIndex((row) => row.id === id);
      if (folderIndex !== -1) return folderIndex;
      const overlayIndex = pendingOverlayRows.findIndex((row) => row.id === id);
      if (overlayIndex !== -1) return mergedIndex.indexOfOverlay(overlayIndex);
      return undefined;
    },
    [folders, pendingOverlayRows, mergedIndex]
  );

  const overlayRows = useMemo(
    () =>
      folders.length === 0
        ? pendingOverlayRows
        : [...folders, ...pendingOverlayRows],
    [folders, pendingOverlayRows]
  );

  // Merged row indices → file-universe offsets, conservatively (over-cover
  // by the overlay counts; the page queries add their own overscan anyway).
  const folderCount = folders.length;
  const overlayCount = pendingOverlayRows.length;
  const onVisibleRangeChange = useCallback(
    (range: ListingVisibleRange) => {
      setVisibleRange({
        start: Math.max(0, range.start - folderCount - overlayCount),
        end: Math.max(0, range.end - folderCount),
      });
    },
    [setVisibleRange, folderCount, overlayCount]
  );

  return {
    rowCount: mergedIndex.rowCount,
    rowAt,
    fileOffsetToRowIndex,
    rowIndexById,
    overlayRows,
    onVisibleRangeChange,
    // Footer count over the whole filtered universe, not the loaded pages:
    // total_count comes from the snapshot's key list.
    filteredCount: folderCount + totalCount + overlayCount,
    sorting,
    columnFilters,
    filter,
    orderBy,
    pending,
    error,
  };
};
