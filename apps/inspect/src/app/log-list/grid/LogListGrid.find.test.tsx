import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { RefObject } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { LogsListingMatch } from "../../../log_data";

import type { LogListRow } from "./columns/types";
import { LogListGrid } from "./LogListGrid";

const holder = vi.hoisted(() => ({
  matches: [] as LogsListingMatch[],
  scrollToIndex: vi.fn(),
  openFind: undefined as (() => void) | undefined,
  patchGridState: vi.fn(),
}));

vi.mock("../../../state/hooks", () => ({
  useLogsListing: () => ({
    gridStateByScope: {},
    patchGridState: holder.patchGridState,
  }),
}));

vi.mock("@tsmono/react/hooks", () => ({
  useProperty: () => ["by-metric"],
}));

interface MockFindBandProps {
  inputRef: RefObject<HTMLInputElement | null>;
  value: string;
  onChange: () => void;
  onNext: () => void;
  matchCount?: number;
  matchIndex?: number;
  noResults?: boolean;
}

vi.mock("@tsmono/react/components", () => ({
  FindBandUI: ({
    inputRef,
    value,
    onChange,
    onNext,
    matchCount,
    matchIndex,
    noResults,
  }: MockFindBandProps) => (
    <div>
      <input
        aria-label="Find"
        ref={inputRef}
        value={value}
        onChange={onChange}
      />
      <button type="button" onClick={onNext}>
        Next
      </button>
      <span data-testid="match-state">
        {matchIndex}:{matchCount}
      </span>
      <span data-testid="no-results">{String(noResults)}</span>
    </div>
  ),
  useFindBandShortcut: (openFind: () => void) => {
    holder.openFind = openFind;
  },
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("./columns/hooks", () => ({
  useLogListColumns: () => ({
    columns: [
      {
        id: "name",
        header: "Name",
        accessorFn: (row: LogListRow) => row.name,
      },
    ],
    visibility: { name: true },
    getValue: (row: LogListRow, column: string) => row[column],
    getComparator: () => undefined,
    getFilterType: () => undefined,
    accessorsKey: "name:string",
  }),
}));

vi.mock("../listing/useLogsListingQuery", () => ({
  useLogsListingMatches: () => ({
    matches: holder.matches,
    settled: true,
    reset: vi.fn(),
  }),
}));

interface MockDataGridProps {
  selectedRowId?: string;
  scrollToIndexRef?: RefObject<((index: number) => void) | null>;
}

vi.mock("../../shared/data-grid/DataGrid", () => ({
  DataGrid: ({ selectedRowId, scrollToIndexRef }: MockDataGridProps) => {
    if (scrollToIndexRef) scrollToIndexRef.current = holder.scrollToIndex;
    return <div data-testid="selected-row">{selectedRowId}</div>;
  },
}));

afterEach(cleanup);

describe("LogListGrid Find pagination", () => {
  beforeEach(() => {
    holder.matches = [
      { id: "/logs/loaded.eval", offset: 0 },
      { id: "/logs/unloaded.eval", offset: 750 },
    ];
    holder.scrollToIndex.mockReset();
    holder.patchGridState.mockReset();
    holder.openFind = undefined;
  });

  const loadedRow: LogListRow = {
    id: "/logs/loaded.eval",
    name: "loaded.eval",
    type: "file",
  };

  const renderGrid = () =>
    render(
      <LogListGrid
        rowCount={1000}
        rowAt={(index) => (index === 0 ? loadedRow : undefined)}
        overlayRows={[]}
        // One pinned folder ahead of the files, so the mapping is visible
        // in the jump target (offset N → row index N + 1).
        fileOffsetToRowIndex={(offset) => offset + 1}
        rowIndexById={() => undefined}
        onVisibleRangeChange={() => {}}
        totalRowCount={2}
        sorting={[]}
        busy={false}
        listing={{
          logDir: "/logs",
          prefix: "/logs",
          universe: "logs::/logs",
          toRow: () => undefined,
        }}
      />
    );

  const openFind = () => {
    act(() => holder.openFind?.());
    fireEvent.change(screen.getByRole("textbox", { name: "Find" }), {
      target: { value: "needle" },
    });
  };

  test("jumps to a sole match outside the loaded pages instead of reporting no results", async () => {
    holder.matches = [{ id: "/logs/unloaded.eval", offset: 750 }];
    renderGrid();
    openFind();

    await waitFor(() => expect(holder.scrollToIndex).toHaveBeenCalledWith(751));
    expect(screen.getByTestId("match-state")).toHaveTextContent("0:1");
    expect(screen.getByTestId("no-results")).toHaveTextContent("false");
    expect(screen.getByTestId("selected-row")).toHaveTextContent(
      "/logs/unloaded.eval"
    );
  });

  test("navigates the complete match list, jumping to an unloaded match's offset", async () => {
    renderGrid();

    openFind();

    await waitFor(() => expect(holder.scrollToIndex).toHaveBeenCalledWith(1));
    expect(screen.getByTestId("match-state")).toHaveTextContent("0:2");
    holder.scrollToIndex.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => expect(holder.scrollToIndex).toHaveBeenCalledWith(751));
    expect(screen.getByTestId("match-state")).toHaveTextContent("1:2");
    expect(screen.getByTestId("selected-row")).toHaveTextContent(
      "/logs/unloaded.eval"
    );
  });
});
