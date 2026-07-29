import {
  ChatMessage,
  ChatMessageSystem,
  ChatMessageTool,
} from "@tsmono/inspect-common/types";
import {
  collapsedSystemRow,
  countRowBlocks,
  kCollapsedSystemMessageId,
  messagesToStr,
  type Message,
  type MessageRow,
  type MessageRowOptions,
} from "@tsmono/inspect-components/chat";

import { type ChunkedSample } from "./chunked";
import { log } from "./chunked/log";
import { withAttachmentsResolved } from "./chunkedAttachments";
import {
  kDefaultMessageRowOptions,
  paginationRange,
  type SampleMessagesData,
} from "./messageRows";

/** Refs fetched per scan batch: bounds resident parsed messages to a few
 * chunks while keeping each batch's chunk fetches parallel. */
const SCAN_REF_BATCH = 256;

const rowHead = (message: ChatMessage, ordinal: number): Message =>
  message.id === undefined ? { ...message, id: `msg-${ordinal}` } : message;

/**
 * The folded-row index of a chunked conversation, built from one pass over
 * the message stream. Mirrors `resolveMessages` + `buildMessageRows`
 * semantics exactly (the oracle tests pin this): tool messages fold into
 * the previous non-tool row — a leading tool, or one following a system
 * message, is dropped, because pass 1 of `resolveMessages` attaches it to
 * a row that pass 2 removes; system messages collapse into one synthetic
 * row at position 0.
 */
export interface ChunkedRowsIndex {
  /** Conversation ordinal of each normal row's head message. */
  heads: Int32Array;
  /** startNumber per rendered row (synthetic system row included). */
  startNumbers: Int32Array;
  /** Conversation ordinals of system messages (synthetic row material). */
  systemOrdinals: number[];
  hasSystemRow: boolean;
  /** First-occurrence message id (head or folded tool) → rendered row. */
  rowByMessageId: Map<string, number>;
  totalRows: number;
  totalMessages: number;
}

/** Streaming fold: feed conversation messages in order, then finish(). */
export class ConversationScanner {
  private heads: number[] = [];
  private blocks: number[] = [];
  private systemOrdinals: number[] = [];
  private systemElements = 0;
  private rawRowByMessageId = new Map<string, number>();
  private lastKind: "none" | "normal" | "system" = "none";
  private ordinal = 0;

  constructor(private options: MessageRowOptions) {}

  private mapId(message: ChatMessage, ordinal: number, row: number): void {
    const id = message.id ?? `msg-${ordinal}`;
    if (!this.rawRowByMessageId.has(id)) {
      this.rawRowByMessageId.set(id, row);
    }
  }

  private headBlocks(message: ChatMessage): number {
    return countRowBlocks(
      { message, toolMessages: [] },
      this.options.toolCallStyle
    );
  }

  add(message: ChatMessage): void {
    const ordinal = this.ordinal++;
    if (!this.options.collapseToolMessages) {
      this.heads.push(ordinal);
      this.blocks.push(this.headBlocks(message));
      this.mapId(message, ordinal, this.heads.length - 1);
      return;
    }
    if (message.role === "system") {
      this.systemOrdinals.push(ordinal);
      this.systemElements +=
        typeof message.content === "string" ? 1 : message.content.length;
      this.lastKind = "system";
      return;
    }
    if (message.role === "tool") {
      if (this.lastKind === "normal") {
        this.mapId(message, ordinal, this.heads.length - 1);
      }
      return;
    }
    this.heads.push(ordinal);
    this.blocks.push(this.headBlocks(message));
    this.mapId(message, ordinal, this.heads.length - 1);
    this.lastKind = "normal";
  }

  finish(): ChunkedRowsIndex {
    const hasSystemRow =
      this.options.collapseToolMessages && this.systemElements > 0;
    const offset = hasSystemRow ? 1 : 0;
    const totalRows = this.heads.length + offset;
    const startNumbers = new Int32Array(totalRows);
    let next = 1;
    if (hasSystemRow) {
      startNumbers[0] = next;
      next += 1; // the synthetic system row renders one block
    }
    for (let i = 0; i < this.blocks.length; i++) {
      startNumbers[i + offset] = next;
      next += this.blocks[i] ?? 0;
    }
    const rowByMessageId = new Map<string, number>();
    if (hasSystemRow) {
      rowByMessageId.set(kCollapsedSystemMessageId, 0);
    }
    for (const [id, row] of this.rawRowByMessageId) {
      rowByMessageId.set(id, row + offset);
    }
    return {
      heads: Int32Array.from(this.heads),
      startNumbers,
      systemOrdinals: this.systemOrdinals,
      hasSystemRow,
      rowByMessageId,
      totalRows,
      totalMessages: this.ordinal,
    };
  }
}

/**
 * The Messages tab's windowed source over a chunked sample: one role-scan
 * over the message sequence builds an exact folded-row index (no
 * attachment chunks touched — the bytes that dominate full hydration),
 * then pages materialize only their covering chunks with per-batch
 * attachment resolution.
 *
 * Known divergence, deliberate: block counts are computed over unresolved
 * content (an `attachment://` ref counts as visible). A resolved
 * attachment is never rendered empty in practice, so numbering matches
 * the legacy full-hydration derivation; the oracle tests pin this on the
 * fixture corpus.
 */
export const chunkedMessageRows = (
  chunked: ChunkedSample,
  options: MessageRowOptions = kDefaultMessageRowOptions
): SampleMessagesData => {
  const refs = chunked.shell.message_refs;
  // conversation ordinal space: refs concatenated; prefix[i] = ordinal of
  // refs[i]'s first message
  const prefix: number[] = [0];
  for (const [start, end] of refs) {
    prefix.push((prefix[prefix.length - 1] ?? 0) + (end - start));
  }

  /** Conversation slice [lo, hi) — parallel getRange per covered ref. */
  const fetchConversation = async (
    lo: number,
    hi: number
  ): Promise<ChatMessage[]> => {
    const reads: Promise<ChatMessage[]>[] = [];
    for (let i = 0; i < refs.length; i++) {
      const refLo = prefix[i] ?? 0;
      const refHi = prefix[i + 1] ?? 0;
      if (refHi <= lo) continue;
      if (refLo >= hi) break;
      const [seqStart] = refs[i] ?? [0, 0];
      const from = Math.max(lo, refLo) - refLo + (seqStart ?? 0);
      const to = Math.min(hi, refHi) - refLo + (seqStart ?? 0);
      reads.push(chunked.messages.getRange(from, to));
    }
    return (await Promise.all(reads)).flat();
  };

  // memoize successes only — a transient read failure must not disable the
  // source for the sample's lifetime (same policy as SequenceReader)
  let indexPromise: Promise<ChunkedRowsIndex> | undefined;
  const ensureIndex = (): Promise<ChunkedRowsIndex> => {
    if (!indexPromise) {
      const pending = (async () => {
        const startedAt = performance.now();
        const scanner = new ConversationScanner(options);
        for (let i = 0; i < refs.length; i += SCAN_REF_BATCH) {
          const batch = refs.slice(i, i + SCAN_REF_BATCH);
          const ranges = await Promise.all(
            batch.map(([start, end]) => chunked.messages.getRange(start, end))
          );
          for (const range of ranges) {
            for (const message of range) {
              scanner.add(message);
            }
          }
        }
        const index = scanner.finish();
        log.info(
          `message-rows index: ${index.totalRows} rows / ` +
            `${index.totalMessages} messages via ${refs.length} ranges in ` +
            `${(performance.now() - startedAt).toFixed(0)}ms`
        );
        return index;
      })();
      pending.catch(() => {
        if (indexPromise === pending) {
          indexPromise = undefined;
        }
      });
      indexPromise = pending;
    }
    return indexPromise;
  };

  /** The synthetic system row, materialized once (scattered ordinals). */
  let systemRowPromise: Promise<MessageRow | undefined> | undefined;
  const systemRow = (index: ChunkedRowsIndex): Promise<MessageRow | undefined> => {
    if (!systemRowPromise) {
      const pending = (async () => {
        const fetched = (
          await Promise.all(
            index.systemOrdinals.map((o) => fetchConversation(o, o + 1))
          )
        ).flat();
        const resolved = await withAttachmentsResolved(
          fetched,
          chunked,
          "system row"
        );
        const row = collapsedSystemRow(resolved as ChatMessageSystem[]);
        return row === undefined
          ? undefined
          : { resolved: row, startNumber: index.startNumbers[0] ?? 1 };
      })();
      pending.catch(() => {
        if (systemRowPromise === pending) {
          systemRowPromise = undefined;
        }
      });
      systemRowPromise = pending;
    }
    return systemRowPromise;
  };

  /** Rendered rows [lo, hi) — fetches only the covering message span. */
  const materializeRows = async (
    index: ChunkedRowsIndex,
    lo: number,
    hi: number
  ): Promise<MessageRow[]> => {
    const rows: MessageRow[] = [];
    let rowCursor = lo;
    if (index.hasSystemRow && lo === 0 && hi > 0) {
      const sys = await systemRow(index);
      if (sys !== undefined) {
        rows.push(sys);
      }
      rowCursor = 1;
    }
    const offset = index.hasSystemRow ? 1 : 0;
    const firstNormal = rowCursor - offset;
    const lastNormal = hi - offset; // exclusive
    if (lastNormal <= firstNormal) {
      return rows;
    }
    const convLo = index.heads[firstNormal] ?? 0;
    const convHi =
      lastNormal < index.heads.length
        ? (index.heads[lastNormal] ?? index.totalMessages)
        : index.totalMessages;
    const span = await withAttachmentsResolved(
      await fetchConversation(convLo, convHi),
      chunked,
      `message rows ${lo}..${hi}`
    );
    for (let row = firstNormal; row < lastNormal; row++) {
      const headOrdinal = index.heads[row] ?? 0;
      const nextOrdinal =
        row + 1 < index.heads.length
          ? (index.heads[row + 1] ?? index.totalMessages)
          : index.totalMessages;
      const head = span[headOrdinal - convLo];
      if (head === undefined) {
        throw new Error(`message row ${row} missing its head message`);
      }
      if (!options.collapseToolMessages) {
        rows.push({
          resolved: { message: rowHead(head, headOrdinal), toolMessages: [] },
          startNumber: index.startNumbers[row + offset] ?? 1,
        });
        continue;
      }
      const toolMessages: ChatMessageTool[] = [];
      let sawSystem = false;
      for (let o = headOrdinal + 1; o < nextOrdinal; o++) {
        const message = span[o - convLo];
        if (message === undefined) continue;
        if (message.role === "system") {
          sawSystem = true;
        } else if (message.role === "tool" && !sawSystem) {
          toolMessages.push(rowHead(message, o) as ChatMessageTool);
        }
      }
      rows.push({
        resolved: { message: rowHead(head, headOrdinal), toolMessages },
        startNumber: index.startNumbers[row + offset] ?? 1,
      });
    }
    return rows;
  };

  return {
    rowCount: async () => (await ensureIndex()).totalRows,
    getRows: async (pagination) => {
      const index = await ensureIndex();
      const { lo, hi } = paginationRange(pagination, index.totalRows);
      return {
        rows: await materializeRows(index, lo, hi),
        offset: lo,
        totalRowCount: index.totalRows,
        nextCursor: hi < index.totalRows ? { position: hi } : null,
        prevCursor: lo > 0 ? { position: lo } : null,
      };
    },
    resolveMessage: async (messageId) =>
      (await ensureIndex()).rowByMessageId.get(messageId),
    // Explicit user action (copy/download): materializes the whole
    // conversation — the one sanctioned full read, same profile as the
    // monolith path's messagesToStr.
    exportText: async () => {
      const index = await ensureIndex();
      const messages = await withAttachmentsResolved(
        await fetchConversation(0, index.totalMessages),
        chunked,
        "export text"
      );
      return messagesToStr(messages);
    },
  };
};
