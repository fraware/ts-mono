import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { SampleHandle } from "../app/types";

import {
  chunkedMessagesQueryKey,
  hydrateFinalConversation,
} from "./chunkedMessages";
import { inMemoryMessageRows } from "./messageRows";
import { type EvalSampleData } from "./sampleData";
import { kSampleGcTimeMs } from "./sampleQuery";

/**
 * A sample conversation's exported text, produced on demand from a
 * `SampleMessagesData.exportText` stream. Sinks pick their shape: the
 * clipboard fundamentally needs one whole string, downloads take a Blob so
 * the browser owns the buffers instead of one giant JS string.
 */
export interface MessagesExport {
  /** The conversation text in parts — concatenation is the whole text. */
  text(): AsyncIterable<string>;
  /** Parts collected into a text/plain Blob (downloads). */
  blob(): Promise<Blob>;
  /** Parts joined into one string (clipboard). */
  string(): Promise<string>;
}

export const messagesExportFrom = (
  text: () => AsyncIterable<string>
): MessagesExport => {
  const collect = async (): Promise<string[]> => {
    const parts: string[] = [];
    for await (const part of text()) {
      parts.push(part);
    }
    return parts;
  };
  return {
    text,
    blob: async () => new Blob(await collect(), { type: "text/plain" }),
    string: async () => (await collect()).join(""),
  };
};

/**
 * Copy/Download > Messages: the settled conversation as text, produced on
 * demand. Undefined when there is no settled conversation to export (live
 * streaming samples, a sample still loading). Chunked samples hydrate on
 * first use, through the same query the Messages tab reads, so export
 * never requires the tab to have been opened.
 */
export const useMessagesExport = (
  handle: SampleHandle | undefined,
  sampleData: EvalSampleData
): MessagesExport | undefined => {
  const queryClient = useQueryClient();
  const chunked = sampleData.chunked;
  const messages =
    chunked === undefined ? sampleData.sample?.messages : undefined;
  return useMemo(() => {
    if (chunked && handle) {
      return messagesExportFrom(async function* () {
        const hydrated = await queryClient.fetchQuery({
          queryKey: chunkedMessagesQueryKey(handle),
          queryFn: () => hydrateFinalConversation(chunked),
          gcTime: kSampleGcTimeMs,
          // a settled chunked conversation is immutable: reuse a resident
          // hydration instead of re-fetching it per export
          staleTime: Infinity,
        });
        yield* inMemoryMessageRows(hydrated).exportText();
      });
    }
    if (messages) {
      return messagesExportFrom(() => inMemoryMessageRows(messages).exportText());
    }
    return undefined;
  }, [queryClient, chunked, handle, messages]);
};
