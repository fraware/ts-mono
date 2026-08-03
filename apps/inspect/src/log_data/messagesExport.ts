import { useMemo } from "react";

import { type EvalSampleData } from "./sampleData";
import { sampleMessagesSource } from "./sampleMessagesSource";

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
 * demand through the same source the Messages tab reads (chunked samples
 * stream window by window off the shared chunk caches — export never
 * hydrates a conversation, and never requires the tab to have been
 * opened). Undefined when there is no settled conversation to export
 * (live streaming samples, a sample still loading).
 */
export const useMessagesExport = (
  sampleData: EvalSampleData
): MessagesExport | undefined =>
  useMemo(() => {
    const source = sampleMessagesSource(sampleData);
    return source ? messagesExportFrom(() => source.exportText()) : undefined;
  }, [sampleData]);
