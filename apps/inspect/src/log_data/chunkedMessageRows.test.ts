/**
 * Parity tests for the chunked windowed source: the in-memory source over
 * a fully hydrated conversation is the oracle (it runs the legacy
 * resolveMessages/buildMessageRows derivation), and the windowed source
 * must be indistinguishable from it — rows, numbering, id resolution,
 * export text — while never touching an attachment chunk during its
 * index build.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ChatMessage } from "@tsmono/inspect-common/types";
import { buildMessageRows } from "@tsmono/inspect-components/chat";

import { openZipFileFromBuffer } from "../client/remote/remoteZipFile";

import {
  openChunkedSample,
  type ChunkedSample,
  type EntryByteSource,
} from "./chunked";
import { withAttachmentsResolved } from "./chunkedAttachments";
import {
  chunkedMessageRows,
  ConversationScanner,
} from "./chunkedMessageRows";
import {
  inMemoryMessageRows,
  kDefaultMessageRowOptions,
  type SampleMessagesData,
} from "./messageRows";

const forwardPage = (position: number | undefined, limit: number) => ({
  cursor: position === undefined ? null : { position },
  direction: "forward" as const,
  limit,
});

// ---------------------------------------------------------------------------
// ConversationScanner vs the legacy derivation, on synthetic edge cases
// ---------------------------------------------------------------------------

const scanIndex = (messages: ChatMessage[]) => {
  const scanner = new ConversationScanner(kDefaultMessageRowOptions);
  for (const message of messages) {
    scanner.add(message);
  }
  return scanner.finish();
};

const legacyIndex = (messages: ChatMessage[]) => {
  const rows = buildMessageRows(messages, kDefaultMessageRowOptions);
  const rowByMessageId = new Map<string, number>();
  rows.forEach((row, position) => {
    const claim = (id: string | null | undefined) => {
      if (id && !rowByMessageId.has(id)) {
        rowByMessageId.set(id, position);
      }
    };
    claim(row.resolved.message.id);
    for (const tool of row.resolved.toolMessages) {
      claim(tool.id);
    }
  });
  return {
    totalRows: rows.length,
    startNumbers: rows.map((row) => row.startNumber),
    rowByMessageId,
  };
};

const edgeCases: Record<string, ChatMessage[]> = {
  "plain conversation": [
    { id: "s", role: "system", content: "sys" },
    { id: "u", role: "user", content: "hi" },
    { id: "a", role: "assistant", content: "yo" },
  ],
  "tool folding with block numbering": [
    { id: "u", role: "user", content: "go" },
    {
      id: "a1",
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "c1", function: "bash", arguments: {}, type: "function" },
        { id: "c2", function: "py", arguments: {}, type: "function" },
      ],
    },
    { id: "t1", role: "tool", content: "ok", tool_call_id: "c1" },
    { id: "t2", role: "tool", content: "ok", tool_call_id: "c2" },
    { id: "a2", role: "assistant", content: "done" },
  ],
  "leading tool message is dropped": [
    { id: "t0", role: "tool", content: "orphan" },
    { id: "u", role: "user", content: "hi" },
  ],
  "tool after system is dropped": [
    { id: "u", role: "user", content: "hi" },
    { id: "a", role: "assistant", content: "yo" },
    { id: "s", role: "system", content: "late system" },
    { id: "t", role: "tool", content: "attaches to removed row" },
    { id: "a2", role: "assistant", content: "end" },
  ],
  "scattered system messages collapse": [
    { id: "s1", role: "system", content: "one" },
    { id: "u", role: "user", content: "hi" },
    { id: "s2", role: "system", content: ["two", "three"] },
    { id: "a", role: "assistant", content: "yo" },
  ],
  "messages without ids synthesize by ordinal": [
    { role: "user", content: "hi" },
    { role: "assistant", content: "yo" },
    { role: "tool", content: "ok" },
  ],
  "empty conversation": [],
} as unknown as Record<string, ChatMessage[]>;

describe("ConversationScanner matches the legacy derivation", () => {
  it.each(Object.entries(edgeCases))("%s", (_name, messages) => {
    const scanned = scanIndex(messages);
    const legacy = legacyIndex(messages);
    expect(scanned.totalRows).toBe(legacy.totalRows);
    expect([...scanned.startNumbers]).toEqual(legacy.startNumbers);
    expect(scanned.rowByMessageId).toEqual(legacy.rowByMessageId);
    expect(scanned.totalMessages).toBe(messages.length);
  });
});

// ---------------------------------------------------------------------------
// The windowed source vs the in-memory oracle, on the fixture corpus
// ---------------------------------------------------------------------------

const logsDir = join(
  process.cwd(),
  "src/log_data/chunked/fixtures/logs/chunked"
);
const logNames = readdirSync(logsDir).filter((name) => name.endsWith(".eval"));

interface OpenedSample {
  name: string;
  sample: ChunkedSample;
  /** Entry names fetched through the byte source, in order. */
  fetched: string[];
}

const openSamples = async (name: string): Promise<OpenedSample[]> => {
  const bytes = new Uint8Array(readFileSync(join(logsDir, name)));
  const zip = await openZipFileFromBuffer(bytes);
  const entryNames = new Set(zip.centralDirectory.keys());
  const refs = [...entryNames].flatMap((entry) => {
    const m = /^samples\/(.+)_epoch_(\d+)\/sample\.json$/.exec(entry);
    return m ? [{ id: m[1] ?? "", epoch: Number(m[2]) }] : [];
  });
  return Promise.all(
    refs.map(async ({ id, epoch }) => {
      const fetched: string[] = [];
      const recording: EntryByteSource = {
        readFile: (n) => {
          fetched.push(n);
          return zip.readFile(n);
        },
      };
      return {
        name: `${name} ${id}_epoch_${epoch}`,
        sample: await openChunkedSample(recording, entryNames, id, epoch),
        fetched,
      };
    })
  );
};

/** The legacy full hydration, reproduced locally as the test oracle. */
const oracleSource = async (
  sample: ChunkedSample
): Promise<SampleMessagesData> => {
  const ranges = await Promise.all(
    sample.shell.message_refs.map(([start, end]) =>
      sample.messages.getRange(start, end)
    )
  );
  const messages = await withAttachmentsResolved(
    ranges.flat(),
    sample,
    "oracle hydration"
  );
  return inMemoryMessageRows(messages);
};

describe("chunkedMessageRows matches the full-hydration oracle", () => {
  it.each(logNames.map((name) => [name]))("%s", async (name) => {
    for (const { sample } of await openSamples(name)) {
      const source = chunkedMessageRows(sample);
      const oracle = await oracleSource(sample);

      const total = await source.rowCount();
      await expect(oracle.rowCount()).resolves.toBe(total);

      // whole conversation in one page
      const all = await source.getRows(forwardPage(undefined, total + 10));
      const expected = await oracle.getRows(forwardPage(undefined, total + 10));
      expect(all.rows).toEqual(expected.rows);
      expect(all.totalRowCount).toBe(expected.totalRowCount);

      // window walk with a page size that splits folded rows' spans
      const walked = [];
      let cursor: { position: number } | null = null;
      do {
        const page = await source.getRows({
          cursor,
          direction: "forward",
          limit: 3,
        });
        walked.push(...page.rows);
        cursor = page.nextCursor;
      } while (cursor !== null);
      expect(walked).toEqual(expected.rows);

      // id resolution: every head and folded tool id, plus a miss
      for (const row of expected.rows) {
        const ids = [
          row.resolved.message.id,
          ...row.resolved.toolMessages.map((tool) => tool.id),
        ];
        for (const id of ids) {
          if (!id) continue;
          await expect(source.resolveMessage(id)).resolves.toBe(
            await oracle.resolveMessage(id)
          );
        }
      }
      await expect(source.resolveMessage("no-such-id")).resolves.toBe(
        undefined
      );

      await expect(source.exportText()).resolves.toBe(
        await oracle.exportText()
      );
    }
  });

  it("index build fetches no attachment chunks", async () => {
    const [first] = await openSamples(logNames[0] ?? "");
    if (!first) throw new Error("no fixture samples");
    const before = first.fetched.length;
    const source = chunkedMessageRows(first.sample);
    await source.rowCount();
    const scanned = first.fetched.slice(before);
    expect(scanned.length).toBeGreaterThan(0);
    expect(scanned.filter((n) => n.includes("/attachments/"))).toEqual([]);
  });
});
