import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { ChatMessage } from "@tsmono/inspect-common/types";

import { SampleHandle } from "../app/types";

import {
  inMemoryMessageRows,
  type SampleMessagesData,
} from "./messageRows";
import { useMessageRowsModel } from "./messageRowsQuery";

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

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(
    QueryClientProvider,
    { client: new QueryClient() },
    children
  );

describe("useMessageRowsModel", () => {
  it("returns undefined without a source", () => {
    const { result } = renderHook(
      () => useMessageRowsModel("dir", handle, undefined),
      { wrapper }
    );
    expect(result.current).toBeUndefined();
  });

  it("seeds an in-memory source fully on first render — no fetch, no placeholders", () => {
    const source = inMemoryMessageRows(makeMessages(1200));
    const { result } = renderHook(
      () => useMessageRowsModel("dir", handle, source),
      { wrapper }
    );
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
    const { result } = renderHook(
      () => useMessageRowsModel("dir", handle, source),
      { wrapper }
    );

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
        useMessageRowsModel("dir", handle, source),
      { wrapper, initialProps }
    );
    expect(result.current).toBeUndefined();

    rerender({ source: asyncSource(makeMessages(3)) });
    await waitFor(() => expect(result.current).toBeDefined());
    expect(result.current!.total).toBe(3);
    expect(result.current!.rowAt(2)).toBeDefined();
  });

  it("models an empty conversation as total 0, not as loading", () => {
    const source = inMemoryMessageRows([]);
    const { result } = renderHook(
      () => useMessageRowsModel("dir", handle, source),
      { wrapper }
    );
    expect(result.current).toBeDefined();
    expect(result.current!.total).toBe(0);
  });
});
