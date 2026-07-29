import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { ChatMessage, EvalSample } from "@tsmono/inspect-common/types";

import { SampleHandle } from "../app/types";

import { type EvalSampleData } from "./sampleData";
import { useSampleMessages } from "./sampleMessages";

const handle: SampleHandle = { logFile: "log.eval", id: "s1", epoch: 1 };

const makeMessages = (count: number): ChatMessage[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `m-${i}`,
    role: "user",
    content: `message ${i}`,
  })) as unknown as ChatMessage[];

const settledData = (messages: ChatMessage[]): EvalSampleData => ({
  sample: { messages } as EvalSample,
  status: "ok",
  error: undefined,
  running: [],
  eventsCleared: false,
  backfilling: false,
});

const makeWrapper = (client: QueryClient = new QueryClient()) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };

describe("useSampleMessages deep links", () => {
  it("holds rows on loading until the target resolves, then mounts it resident", async () => {
    const sampleData = settledData(makeMessages(1200));
    const { result } = renderHook(
      () => useSampleMessages(handle, sampleData, true, false, "m-600"),
      { wrapper: makeWrapper() }
    );

    // resolution pending: the list must not mount without its target
    expect(result.current.loading).toBe(true);
    expect(result.current.rows.total).toBe(0);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.initialRowIndex).toBe(600);
    expect(result.current.rows.total).toBe(1200);
    expect(result.current.rows.rowAt(600)).toBeDefined();
  });

  it("settles at the top for an unknown message id", async () => {
    const sampleData = settledData(makeMessages(10));
    const { result } = renderHook(
      () => useSampleMessages(handle, sampleData, true, false, "no-such-id"),
      { wrapper: makeWrapper() }
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.initialRowIndex).toBeUndefined();
    expect(result.current.rows.total).toBe(10);
  });

  it("keeps the no-deep-link path fully seeded and synchronous", () => {
    const sampleData = settledData(makeMessages(1200));
    const { result } = renderHook(
      () => useSampleMessages(handle, sampleData, true, false),
      { wrapper: makeWrapper() }
    );

    expect(result.current.loading).toBe(false);
    expect(result.current.rows.total).toBe(1200);
    expect(result.current.rows.rowAt(1199)).toBeDefined();
    expect(result.current.initialRowIndex).toBeUndefined();
  });
});
