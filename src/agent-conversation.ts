/**
 * Single place to append assistant / tool rows so the transcript stays API-valid:
 * at most one assistant with tool_calls before tool role messages, in order.
 */

import type { Message } from "./types.js";

export type ToolRoundToolCall = { id: string; name: string; arguments: string };

export type ToolRoundResult = { toolCallId: string; content: string };

/**
 * Append one assistant message that includes tool_calls, then each tool result row.
 * Do not push a separate assistant text-only message for the same model turn.
 */
export function appendAssistantToolRound(
  messages: Message[],
  assistant: {
    content: string;
    reasoningContent?: string;
    toolCalls: ToolRoundToolCall[];
  },
  toolResultsInOrder: ToolRoundResult[]
): void {
  messages.push({
    role: "assistant",
    content: assistant.content,
    reasoningContent: assistant.reasoningContent,
    toolCalls: assistant.toolCalls,
  });
  for (const r of toolResultsInOrder) {
    messages.push({
      role: "tool",
      content: r.content,
      toolCallId: r.toolCallId,
    });
  }
}

/** Append a normal assistant reply (no tools in this turn). */
export function appendAssistantTextTurn(
  messages: Message[],
  content: string,
  reasoningContent?: string
): void {
  messages.push({
    role: "assistant",
    content,
    reasoningContent,
  });
}
