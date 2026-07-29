import type {
  ChatMessage,
  ChatMessageAssistant,
  ChatMessageSystem,
  ChatMessageTool,
  ChatMessageUser,
  ContentAudio,
  ContentData,
  ContentDocument,
  ContentImage,
  ContentReasoning,
  ContentText,
  ContentToolUse,
  ContentVideo,
} from "@tsmono/inspect-common/types";

/**
 * Extended message type that includes an optional timestamp
 * (used by inspect for displaying message timestamps).
 */
export type Message = (
  ChatMessageAssistant | ChatMessageSystem | ChatMessageUser | ChatMessageTool
) & {
  timestamp?: string | null;
};

export interface ResolvedMessage {
  message: Message;
  toolMessages: ChatMessageTool[];
}

/** Whether an assistant message carries server-side tool calls (provider
 * executed `tool_use` content blocks) — these render as flush rows of the
 * assistant turn container rather than as message body. */
export const hasServerToolUse = (message: Message): boolean => {
  return (
    message.role === "assistant" &&
    Array.isArray(message.content) &&
    message.content.some((c) => c.type === "tool_use")
  );
};

export const resolveMessages = (messages: ChatMessage[]): ResolvedMessage[] => {
  // Filter tool messages into a sidelist that the chat stream
  // can use to lookup the tool responses

  const resolvedMessages: ResolvedMessage[] = [];
  let index = 0;
  for (const message of messages) {
    // Create a stable id for the item without mutating the original
    const resolved =
      message.id === undefined ? { ...message, id: `msg-${index}` } : message;

    if (resolved.role === "tool") {
      // Add this tool message onto the previous message
      if (resolvedMessages.length > 0) {
        const msg = resolvedMessages[resolvedMessages.length - 1];
        if (msg) {
          msg.toolMessages = msg.toolMessages || [];
          msg.toolMessages.push(resolved);
        }
      }
    } else {
      resolvedMessages.push({ message: resolved, toolMessages: [] });
    }

    index++;
  }

  // Capture system messages (there could be multiple)
  const systemMessages: ChatMessageSystem[] = [];
  const collapsedMessages = resolvedMessages
    .map((resolved) => {
      if (resolved.message.role === "system") {
        systemMessages.push(resolved.message);
      }
      return resolved;
    })
    .filter((resolved) => {
      return resolved.message.role !== "system";
    });

  // Converge them
  const systemRow = collapsedSystemRow(systemMessages);
  if (systemRow) {
    collapsedMessages.unshift(systemRow);
  }
  return collapsedMessages;
};

/** The id of the synthetic row that heads a resolved conversation with
 * system messages (they collapse into it). */
export const kCollapsedSystemMessageId = "sys-message-6815A84B062A";

/**
 * Collapse system messages into the single synthetic row that heads the
 * resolved conversation — undefined when nothing collapses. Extracted so
 * windowed sources materialize the row through the same code
 * `resolveMessages` uses.
 */
export const collapsedSystemRow = (
  systemMessages: ChatMessageSystem[]
): ResolvedMessage | undefined => {
  const systemContent: (
    | ContentText
    | ContentImage
    | ContentAudio
    | ContentVideo
    | ContentDocument
    | ContentReasoning
    | ContentData
    | ContentToolUse
  )[] = [];
  for (const systemMessage of systemMessages) {
    const contents = Array.isArray(systemMessage.content)
      ? systemMessage.content
      : [systemMessage.content];
    systemContent.push(...contents.map(normalizeContent));
  }

  if (systemContent.length === 0) {
    return undefined;
  }
  return {
    message: {
      id: kCollapsedSystemMessageId,
      role: "system",
      content: systemContent,
      source: "input",
      metadata: null,
    },
    toolMessages: [],
  };
};

/**
 * Normalize strings into ContentText objects.
 */
const normalizeContent = (
  content:
    | ContentText
    | ContentImage
    | ContentAudio
    | ContentVideo
    | ContentDocument
    | ContentReasoning
    | ContentData
    | ContentToolUse
    | string
):
  | ContentText
  | ContentImage
  | ContentAudio
  | ContentVideo
  | ContentDocument
  | ContentReasoning
  | ContentData
  | ContentToolUse => {
  if (typeof content === "string") {
    return {
      type: "text",
      text: content,
      refusal: null,
      internal: null,
      citations: null,
    };
  } else {
    return content;
  }
};
