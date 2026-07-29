import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { ChatMessage } from "@tsmono/inspect-common/types";

import { SampleHandle } from "../app/types";

import { inMemoryMessageRows, type SampleMessagesData } from "./messageRows";
import { useMessageRowsModel, useMessageRowTarget } from "./messageRowsQuery";

const handle: SampleHandle = { logFile: "log.eval", id: "s1", epoch: 1 };

const makeMessages = (count: number): ChatMessage[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `m-${i}`,
    role: "user",
    content: `message ${i}`,
  })) as unknown as ChatMessage[];

/** The in-memory source with its sync-seed affordance hidden, so the hook
 *  exercises the real fetch path (what a chunked source will look like). */
const asyncSource = (messages: ChatMessage[]): SampleMessagesData => {
  const inner = inMemoryMessageRows(messages);
  return {
    rowCount: () => inner.rowCount(),
    getRows: (pagination) => inner.getRows(pagination),
    resolveMessage: (messageId) => inner.resolveMessage(messageId),
    exportText: () => inner.exportText(),
  };
};

/** A wrapper over its own QueryClient: stable across a test's renders,
 *  never shared between tests (they reuse the same handle key). */
const makeWrapper = (client: QueryClient = new QueryClient()) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };

describe("useMessageRowsModel", () => {
  it("returns undefined without a source", () => {
    const { result } = renderHook(
      () => useMessageRowsModel(handle, undefined),
      { wrapper: makeWrapper() }
    );
    expect(result.current).toBeUndefined();
  });

  it("seeds an in-memory source fully on first render — no fetch, no placeholders", () => {
    const source = inMemoryMessageRows(makeMessages(1200));
    const { result } = renderHook(() => useMessageRowsModel(handle, source), {
      wrapper: makeWrapper(),
    });
    const model = result.current;
    expect(model).toBeDefined();
    expect(model!.total).toBe(1200);
    for (let i = 0; i < model!.total; i++) {
      expect(model!.rowAt(i)).toBeDefined();
    }
    expect(model!.rowAt(0)!.startNumber).toBe(1);
    expect(model!.rowAt(1199)!.resolved.message.id).toBe("m-1199");
  });

  it("walks pages forward on requestRange for an async source", async () => {
    const source = asyncSource(makeMessages(1200));
    const { result } = renderHook(() => useMessageRowsModel(handle, source), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current).toBeDefined());
    expect(result.current!.total).toBe(1200);
    // page 0 resident, tail not yet
    expect(result.current!.rowAt(0)).toBeDefined();
    expect(result.current!.rowAt(1199)).toBeUndefined();

    // the core re-requests the visible range as each page lands; emulate it
    await waitFor(() => {
      const model = result.current!;
      model.requestRange(1150, 1200);
      expect(model.rowAt(1199)).toBeDefined();
    });
    expect(result.current!.rowAt(1199)!.resolved.message.id).toBe("m-1199");
    expect(result.current!.rowAt(1199)!.startNumber).toBe(1200);
  });

  it("appears when the source arrives after mount (chunked hydration)", async () => {
    const initialProps: { source: SampleMessagesData | undefined } = {
      source: undefined,
    };
    const { result, rerender } = renderHook(
      ({ source }: { source: SampleMessagesData | undefined }) =>
        useMessageRowsModel(handle, source),
      { wrapper: makeWrapper(), initialProps }
    );
    expect(result.current).toBeUndefined();

    rerender({ source: asyncSource(makeMessages(3)) });
    await waitFor(() => expect(result.current).toBeDefined());
    expect(result.current!.total).toBe(3);
    expect(result.current!.rowAt(2)).toBeDefined();
  });

  it("models an empty conversation as total 0, not as loading", () => {
    const source = inMemoryMessageRows([]);
    const { result } = renderHook(() => useMessageRowsModel(handle, source), {
      wrapper: makeWrapper(),
    });
    expect(result.current).toBeDefined();
    expect(result.current!.total).toBe(0);
  });
});

describe("useMessageRowTarget", () => {
  it("idles without a message id", () => {
    const source = asyncSource(makeMessages(10));
    const { result } = renderHook(
      () => useMessageRowTarget(handle, source, null),
      { wrapper: makeWrapper() }
    );
    expect(result.current.pending).toBe(false);
    expect(result.current.index).toBeUndefined();
  });

  it("resolves the row position and pre-loads the covering prefix", async () => {
    const client = new QueryClient();
    const source = asyncSource(makeMessages(1200));
    const target = renderHook(
      () => useMessageRowTarget(handle, source, "m-600"),
      { wrapper: makeWrapper(client) }
    );
    expect(target.result.current.pending).toBe(true);
    await waitFor(() => expect(target.result.current.pending).toBe(false));
    expect(target.result.current.index).toBe(600);

    // the rows model mounts (post-gate) with the prefix resident
    const rows = renderHook(() => useMessageRowsModel(handle, source), {
      wrapper: makeWrapper(client),
    });
    await waitFor(() => expect(rows.result.current).toBeDefined());
    expect(rows.result.current!.rowAt(600)).toBeDefined();
    expect(rows.result.current!.rowAt(999)).toBeDefined();
    // beyond the target's page, nothing was fetched
    expect(rows.result.current!.rowAt(1000)).toBeUndefined();
  });

  it("settles with an undefined index for an unknown id", async () => {
    const source = asyncSource(makeMessages(10));
    const { result } = renderHook(
      () => useMessageRowTarget(handle, source, "no-such-id"),
      { wrapper: makeWrapper() }
    );
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.index).toBeUndefined();
  });

  it("extends an existing prefix instead of clobbering it", async () => {
    const client = new QueryClient();
    const source = asyncSource(makeMessages(1200));

    // rows query loads page 0 first (e.g. a previous visit within gcTime)
    const rows = renderHook(() => useMessageRowsModel(handle, source), {
      wrapper: makeWrapper(client),
    });
    await waitFor(() => expect(rows.result.current).toBeDefined());
    expect(rows.result.current!.rowAt(0)).toBeDefined();
    expect(rows.result.current!.rowAt(600)).toBeUndefined();

    const target = renderHook(
      () => useMessageRowTarget(handle, source, "m-600"),
      { wrapper: makeWrapper(client) }
    );
    await waitFor(() => expect(target.result.current.pending).toBe(false));
    expect(target.result.current.index).toBe(600);

    await waitFor(() => {
      expect(rows.result.current!.rowAt(600)).toBeDefined();
    });
    expect(rows.result.current!.rowAt(0)).toBeDefined();
  });

  it("skips the pre-load when the prefix already covers the target", async () => {
    const client = new QueryClient();
    let fetches = 0;
    const inner = asyncSource(makeMessages(10));
    const source: SampleMessagesData = {
      ...inner,
      getRows: (pagination) => {
        fetches += 1;
        return inner.getRows(pagination);
      },
    };

    const rows = renderHook(() => useMessageRowsModel(handle, source), {
      wrapper: makeWrapper(client),
    });
    await waitFor(() => expect(rows.result.current).toBeDefined());
    const fetchesBefore = fetches;

    const target = renderHook(
      () => useMessageRowTarget(handle, source, "m-5"),
      { wrapper: makeWrapper(client) }
    );
    await waitFor(() => expect(target.result.current.pending).toBe(false));
    expect(target.result.current.index).toBe(5);
    expect(fetches).toBe(fetchesBefore);
  });
});
