import { useMemo, useRef } from "react";

import {
  buildMessageRows,
  messageRowsModel,
  type MessageRowsModel,
} from "@tsmono/inspect-components/chat";

import { SampleHandle } from "../app/types";

import { useChunkedMessages } from "./chunkedMessages";
import {
  inMemoryMessageRows,
  kDefaultMessageRowOptions,
  type SampleMessagesData,
} from "./messageRows";
import { useMessageRowsModel } from "./messageRowsQuery";
import {
  messagesFromEvents,
  type MessagesFromEventsState,
} from "./messagesFromEvents";
import { type EvalSampleData } from "./sampleData";

const kNoRows = messageRowsModel([]);

export interface SampleMessages {
  /** The rows-model the Messages tab renders. */
  rows: MessageRowsModel;
  /** Data that will produce messages is still in flight (monolith sample
   *  fetch, chunked hydration, first page settling) — render a loading
   *  affordance, never "No messages". */
  loading: boolean;
  /** The settled conversation's source — `exportText` backs copy/download.
   *  Undefined while loading and on the streaming path. */
  source: SampleMessagesData | undefined;
}

/**
 * The Messages tab's one entry point: which feed serves the conversation —
 * completed monolith messages, a hydrated chunked sample, or the live
 * event stream — is selected here, behind the SampleMessagesData seam.
 * The view consumes rows and reports two gates it owns: `active` (the tab
 * is open — full hydration of a chunked monster is never paid at sample
 * open) and `running` (live samples surface "waiting", not "loading",
 * before their first poll lands).
 */
export const useSampleMessages = (
  handle: SampleHandle | undefined,
  sampleData: EvalSampleData,
  active: boolean,
  running: boolean
): SampleMessages => {
  const isChunked = sampleData.chunked !== undefined;
  const chunkedMessages = useChunkedMessages(
    isChunked && active ? handle : undefined,
    sampleData.chunked
  );

  const inlineMessages = sampleData.sample?.messages;
  const source = useMemo(() => {
    if (isChunked) {
      return chunkedMessages.data
        ? inMemoryMessageRows(chunkedMessages.data)
        : undefined;
    }
    return inlineMessages ? inMemoryMessageRows(inlineMessages) : undefined;
  }, [isChunked, chunkedMessages.data, inlineMessages]);
  const pagedRows = useMessageRowsModel(handle, source);

  // Streaming path: rows derived from the event stream each poll. The
  // polling pipeline only ever appends to the running events array (or
  // replaces a tail event during streaming updates), so the cached state
  // makes a pure-extension call process only the new tail; diverging
  // events trigger a rebuild.
  const messagesRef = useRef<MessagesFromEventsState | null>(null);
  const runningEvents = sampleData.running;
  const streamingRows = useMemo(() => {
    /* eslint-disable react-hooks/refs */
    if (source !== undefined) {
      messagesRef.current = null;
      return undefined;
    }
    if (runningEvents.length === 0) {
      messagesRef.current = null;
      return undefined;
    }
    return messageRowsModel(
      buildMessageRows(
        messagesFromEvents(runningEvents, messagesRef),
        kDefaultMessageRowOptions
      )
    );
    /* eslint-enable react-hooks/refs */
  }, [source, runningEvents]);

  const loading =
    // a created source whose first page hasn't landed (cache rendezvous)
    (source !== undefined && pagedRows === undefined) ||
    // chunked hydration in flight
    (isChunked && chunkedMessages.loading) ||
    // monolith member fetch/parse (`running` keeps the streaming path's
    // pre-first-poll state on its "waiting" affordance instead)
    (sampleData.status === "loading" && !running);

  return {
    rows: pagedRows ?? streamingRows ?? kNoRows,
    loading,
    source,
  };
};
