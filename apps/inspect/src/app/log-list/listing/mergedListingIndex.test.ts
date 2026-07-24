import { describe, expect, test } from "vitest";

import { buildMergedListingIndex } from "./mergedListingIndex";

describe("buildMergedListingIndex", () => {
  test("dispatches folders, files, and overlays by merged index", () => {
    // 2 folders, files [F0..F3], overlays at file offsets 1 and 3:
    // [folder0, folder1, F0, O0, F1, F2, O1, F3]
    const index = buildMergedListingIndex(2, 4, [1, 3]);
    expect(index.rowCount).toBe(8);
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => index.at(i))).toEqual([
      { kind: "folder", position: 0 },
      { kind: "folder", position: 1 },
      { kind: "file", position: 0 },
      { kind: "overlay", position: 0 },
      { kind: "file", position: 1 },
      { kind: "file", position: 2 },
      { kind: "overlay", position: 1 },
      { kind: "file", position: 3 },
    ]);
  });

  test("indexOfFileOffset inverts at() for every file row", () => {
    const index = buildMergedListingIndex(2, 4, [1, 3]);
    for (let offset = 0; offset < 4; offset++) {
      const merged = index.indexOfFileOffset(offset);
      expect(index.at(merged)).toEqual({ kind: "file", position: offset });
    }
  });

  test("indexOfOverlay addresses each overlay's merged position", () => {
    const index = buildMergedListingIndex(1, 4, [1, 3]);
    expect(index.at(index.indexOfOverlay(0))).toEqual({
      kind: "overlay",
      position: 0,
    });
    expect(index.at(index.indexOfOverlay(1))).toEqual({
      kind: "overlay",
      position: 1,
    });
  });

  test("appends overlays after the whole universe when offsets equal the total", () => {
    // The unsorted contract: transient rows after all files.
    const index = buildMergedListingIndex(0, 3, [3, 3]);
    expect(index.rowCount).toBe(5);
    expect(index.at(2)).toEqual({ kind: "file", position: 2 });
    expect(index.at(3)).toEqual({ kind: "overlay", position: 0 });
    expect(index.at(4)).toEqual({ kind: "overlay", position: 1 });
  });

  test("overlays sharing an offset keep their relative order", () => {
    const index = buildMergedListingIndex(0, 2, [1, 1]);
    // [F0, O0, O1, F1]
    expect(index.at(1)).toEqual({ kind: "overlay", position: 0 });
    expect(index.at(2)).toEqual({ kind: "overlay", position: 1 });
    expect(index.at(3)).toEqual({ kind: "file", position: 1 });
    expect(index.indexOfFileOffset(1)).toBe(3);
  });

  test("clamps and monotonizes stale offsets", () => {
    // A momentarily-stale offsets read (out of range, out of order) must
    // still produce a valid merge.
    const index = buildMergedListingIndex(0, 2, [5, 0, -1]);
    expect(index.rowCount).toBe(5);
    const kinds = [0, 1, 2, 3, 4].map((i) => index.at(i).kind);
    expect(kinds.filter((kind) => kind === "file")).toHaveLength(2);
    expect(kinds.filter((kind) => kind === "overlay")).toHaveLength(3);
    // Every merged index resolves within bounds.
    for (let i = 0; i < index.rowCount; i++) {
      const slot = index.at(i);
      if (slot.kind === "file") {
        expect(slot.position).toBeGreaterThanOrEqual(0);
        expect(slot.position).toBeLessThan(2);
      }
    }
  });

  test("no overlays: file offsets map straight through after folders", () => {
    const index = buildMergedListingIndex(3, 10, []);
    expect(index.rowCount).toBe(13);
    expect(index.at(0)).toEqual({ kind: "folder", position: 0 });
    expect(index.at(3)).toEqual({ kind: "file", position: 0 });
    expect(index.indexOfFileOffset(7)).toBe(10);
  });
});
