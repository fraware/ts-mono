/**
 * Index arithmetic for the merged log-list universe: folders pinned on top,
 * then the file universe (`totalCount` rows, loaded or not) with overlay
 * (pending-task) rows inserted at their universe offsets. Overlay row `j`
 * with insertion offset `o_j` (offsets ascending, ties stable by overlay
 * order) occupies merged position `o_j + j` — i.e. immediately before file
 * offset `o_j` — which reproduces `mergeSortedRows` over the whole universe
 * instead of the loaded window.
 */
export interface MergedRowSlot {
  kind: "folder" | "overlay" | "file";
  /** Position within the slot's own list: folder index, overlay index, or
   *  file-universe offset. */
  position: number;
}

export interface MergedListingIndex {
  /** Folders + file universe + overlays. */
  rowCount: number;
  /** Dispatch a merged row index to the list it resolves in. */
  at: (index: number) => MergedRowSlot;
  /** Merged row index of a file-universe offset. */
  indexOfFileOffset: (offset: number) => number;
  /** Merged row index of overlay row `j`. */
  indexOfOverlay: (overlayIndex: number) => number;
}

/**
 * Build the merged index. `overlayOffsets` are the overlay rows' file
 * universe insertion offsets in overlay order; they are clamped to
 * `[0, totalCount]` and monotonized (a momentarily-stale offset read must
 * not produce an out-of-order merge).
 */
export const buildMergedListingIndex = (
  folderCount: number,
  totalCount: number,
  overlayOffsets: readonly number[]
): MergedListingIndex => {
  // Merged (post-folder) position per overlay row; strictly increasing by
  // construction (non-decreasing clamped offsets + the running index).
  const positions: number[] = [];
  let previous = 0;
  overlayOffsets.forEach((offset, index) => {
    const clamped = Math.min(Math.max(offset, previous, 0), totalCount);
    previous = clamped;
    positions.push(clamped + index);
  });

  /** Count of overlay positions strictly below `position` (binary search —
   *  positions are strictly increasing). */
  const overlaysBefore = (position: number): number => {
    let lo = 0;
    let hi = positions.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (positions[mid]! < position) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  return {
    rowCount: folderCount + totalCount + positions.length,
    at: (index) => {
      if (index < folderCount) return { kind: "folder", position: index };
      const merged = index - folderCount;
      const before = overlaysBefore(merged);
      if (positions[before] === merged) {
        return { kind: "overlay", position: before };
      }
      return { kind: "file", position: merged - before };
    },
    indexOfFileOffset: (offset) => {
      // Overlay j sits immediately before file offset o_j, so overlays with
      // o_j <= offset precede the file row.
      let count = 0;
      for (let j = 0; j < positions.length; j++) {
        if (positions[j]! - j <= offset) count += 1;
        else break;
      }
      return folderCount + offset + count;
    },
    indexOfOverlay: (overlayIndex) => folderCount + positions[overlayIndex]!,
  };
};
