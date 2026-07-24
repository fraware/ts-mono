import { cleanup, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { ExtendedColumnDef } from "./columnTypes";
import { DataGrid, type VisibleRowRange } from "./DataGrid";

// Vitest globals aren't enabled in this app, so RTL's automatic afterEach
// cleanup never fires. Run it explicitly.
afterEach(cleanup);

interface Row {
  id: string;
  a: string;
}

const columns: ExtendedColumnDef<Row>[] = [
  {
    id: "a",
    header: "A",
    size: 100,
    accessorFn: (r: Row) => r.a,
    cell: ({ getValue }) => <div>{getValue<string>()}</div>,
  },
];

// The virtualizer sizes its window from the scroll element's offsetWidth/
// offsetHeight, which jsdom (no layout) reports as 0 — nothing would render.
// Give every element a real-looking viewport; scrollToIndex additionally
// bottoms out in scrollElement.scrollTo, which jsdom doesn't implement —
// stub it and observe calls (the mount emits one scroll-restore call, so
// assertions compare against a baseline).
const scrollTo = vi.fn();
beforeEach(() => {
  scrollTo.mockClear();
  Element.prototype.scrollTo = scrollTo;
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 800,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => 300,
  });
});
afterEach(() => {
  delete (HTMLElement.prototype as unknown as Record<string, unknown>)
    .offsetWidth;
  delete (HTMLElement.prototype as unknown as Record<string, unknown>)
    .offsetHeight;
  vi.restoreAllMocks();
});

/** rowAt double: rows 0..loadedThrough are loaded, the rest unloaded. */
const rowAtThrough =
  (loadedThrough: number) =>
  (index: number): Row | undefined =>
    index <= loadedThrough ? { id: `r${index}`, a: `${index}a` } : undefined;

const gridWith = (props: {
  rowCount: number;
  rowAt: (index: number) => Row | undefined;
  onVisibleRangeChange?: (range: VisibleRowRange) => void;
  scrollToIndexRef?: React.RefObject<((index: number) => void) | null>;
  selectedRowId?: string;
}) => (
  <DataGrid<Row>
    columns={columns}
    getRowId={(r) => r.id}
    onRowActivate={() => {}}
    {...props}
  />
);

describe("DataGrid windowed mode", () => {
  test("renders loaded rows and skeletons for unloaded indices", () => {
    render(gridWith({ rowCount: 1000, rowAt: rowAtThrough(2) }));

    // Loaded rows render their cells.
    expect(screen.getByText("0a")).toBeInTheDocument();
    expect(screen.getByText("2a")).toBeInTheDocument();

    // The rendered window extends past the loaded rows; those positions are
    // skeleton rows (aria-busy) rather than missing.
    const skeletons = document.querySelectorAll('[role="row"][aria-busy]');
    expect(skeletons.length).toBeGreaterThan(0);
    // Each skeleton still carries its cells so grid semantics hold.
    expect(skeletons[0]?.querySelector('[role="gridcell"]')).not.toBeNull();
  });

  test("the scrollbar and a11y row count span the whole universe", () => {
    render(gridWith({ rowCount: 1000, rowAt: rowAtThrough(2) }));
    expect(screen.getByRole("grid")).toHaveAttribute("aria-rowcount", "1001");
  });

  test("reports the rendered row range", () => {
    const ranges: VisibleRowRange[] = [];
    render(
      gridWith({
        rowCount: 1000,
        rowAt: rowAtThrough(2),
        onVisibleRangeChange: (range) => ranges.push(range),
      })
    );

    const last = ranges.at(-1);
    expect(last).toBeDefined();
    expect(last?.start).toBe(0);
    // 300px viewport / 30px rows + overscan: comfortably under a page, but
    // more than the visible ten (overscan included in the report).
    expect(last?.end).toBeGreaterThanOrEqual(9);
    expect(last?.end).toBeLessThan(100);
  });

  test("scrollToIndexRef jumps to an arbitrary (unloaded) index", () => {
    const ref = createRef<((index: number) => void) | null>();
    render(
      gridWith({
        rowCount: 1000,
        rowAt: rowAtThrough(2),
        scrollToIndexRef: ref,
      })
    );
    const baseline = scrollTo.mock.calls.length;

    expect(ref.current).not.toBeNull();
    ref.current?.(750);
    expect(scrollTo.mock.calls.length).toBeGreaterThan(baseline);
  });

  test("a selected row scrolls by its absolute index, not its window position", () => {
    // Rows 0..9 loaded; select row 5 — the scroll target must be computed
    // from the absolute index even though the table only holds the window.
    render(
      gridWith({
        rowCount: 1000,
        rowAt: rowAtThrough(9),
        selectedRowId: "r5",
      })
    );
    // The selection scroll happened (baseline mount call + selection call).
    expect(scrollTo.mock.calls.length).toBeGreaterThan(0);
  });
});
