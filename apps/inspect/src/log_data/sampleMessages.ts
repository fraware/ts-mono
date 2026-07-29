import { useMemo, useRef, useState } from "react";

import {
  buildMessageRows,
  messageRowsModel,
  type MessageRowsModel,
} from "@tsmono/inspect-components/chat";

import { SampleHandle } from "../app/types";

import { chunkedMessageRows } from "./chunkedMessageRows";
import {
  inMemoryMessageRows,
  kDefaultMessageRowOptions,
  type SampleMessagesData,
} from "./messageRows";
import { useMessageRowsModel, useMessageRowTarget } from "./messageRowsQuery";
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
   *  fetch, chunked index build, first page settling) — render a loading
   *  affordance, never "No messages". */
  loading: boolean;
  /** The settled conversation's source — `exportText` backs copy/download.
   *  Undefined while loading and on the streaming path. */
  source: SampleMessagesData | undefined;
  /** Row position of the `?message=` deep-link target, resolved by the
   *  active source with its covering pages pre-loaded — undefined while
   *  resolving (folded into `loading`), for unknown ids, and on the
   *  streaming path (whose rows are fully resident; the view's own scan
   *  handles it). */
  initialRowIndex: number | undefined;
}

/**
 * The Messages tab's one entry point: which feed serves the conversation —
 * completed monolith messages, a windowed chunked source, or the live
 * event stream — is selected here, behind the SampleMessagesData seam.
 * The view consumes rows and reports two gates it owns: `active` (the tab
 * is open — a chunked sample's index scan is never paid at sample open)
 * and `running` (live samples surface "waiting", not "loading", before
 * their first poll lands).
 */
export const useSampleMessages = (
  handle: SampleHandle | undefined,
  sampleData: EvalSampleData,
  active: boolean,
  running: boolean,
  initialMessageId?: string | null
): SampleMessages => {
  const chunked = sampleData.chunked;

  // The chunked source activates on first tab open — its index build
  // (a scan of the message chunks) is never paid at sample open — and
  // then LATCHES for the rest of the sample visit: recreating the source
  // on a later tab switch would rebuild the index. Render-time setState
  // is the sanctioned derive-from-previous pattern.
  const handleKey = `${handle?.logFile}::${handle?.id}::${handle?.epoch}`;
  const [activation, setActivation] = useState({ key: handleKey, on: active });
  const nextActivation = {
    key: handleKey,
    on: activation.key === handleKey ? activation.on || active : active,
  };
  if (
    nextActivation.key !== activation.key ||
    nextActivation.on !== activation.on
  ) {
    setActivation(nextActivation);
  }
  const activated = nextActivation.on;

  const inlineMessages = sampleData.sample?.messages;
  const source = useMemo(() => {
    if (chunked) {
      return activated ? chunkedMessageRows(chunked) : undefined;
    }
    return inlineMessages ? inMemoryMessageRows(inlineMessages) : undefined;
  }, [chunked, activated, inlineMessages]);

  // Deep-link resolution runs before the rows query sees the source: the
  // gate is what lets the target's page prefix land race-free, and the
  // list then mounts with the target row resident (VirtualList honors
  // initialIndex only at mount).
  const target = useMessageRowTarget(handle, source, initialMessageId);
  const pagedRows = useMessageRowsModel(
    handle,
    target.pending ? undefined : source
  );

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
    // a created source whose first page hasn't landed — covers the chunked
    // index build and page materialization as well as cache rendezvous
    (source !== undefined && pagedRows === undefined) ||
    // monolith member fetch/parse (`running` keeps the streaming path's
    // pre-first-poll state on its "waiting" affordance instead)
    (sampleData.status === "loading" && !running);

  return {
    rows: pagedRows ?? streamingRows ?? kNoRows,
    loading,
    source,
    initialRowIndex: target.index,
  };
};
