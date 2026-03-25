/**
 * One-shot conversation summarization (no tools), using SUMMARY_PROMPT as system message.
 */

import type { Message } from "./types.js";
import type { LLMClient } from "./llm/types.js";
import { SUMMARY_PROMPT } from "./prompts.js";
import { SUMMARY_COMPACT_USER_MESSAGE } from "./constants.js";
import type { LlmUsageEvent } from "./session-store.js";
import { usageEventFromApi } from "./session-store.js";

/** Messages that become the sole chat history after a successful /summary (replaces prior context). */
export function summaryReplacementMessages(summaryText: string): Message[] {
  return [
    { role: "user", content: SUMMARY_COMPACT_USER_MESSAGE },
    { role: "assistant", content: summaryText },
  ];
}

const MAX_TRANSCRIPT_CHARS = 100_000;

export function formatConversationTranscript(messages: Message[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      parts.push(`### User\n${m.content}`);
    } else if (m.role === "assistant") {
      let body = m.content ?? "";
      if (m.toolCalls?.length) {
        body += `\n\n[Tool calls]\n${m.toolCalls.map((tc) => `- ${tc.name}: ${tc.arguments}`).join("\n")}`;
      }
      parts.push(`### Assistant\n${body}`);
    } else if (m.role === "tool") {
      const raw = m.content ?? "";
      const preview =
        raw.length > 8000 ? `${raw.slice(0, 8000)}\n…(truncated)` : raw;
      parts.push(`### Tool (${m.toolCallId ?? "?"})\n${preview}`);
    }
  }
  let transcript = parts.join("\n\n---\n\n");
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    transcript =
      "(Earlier lines omitted due to length.)\n\n" +
      transcript.slice(transcript.length - MAX_TRANSCRIPT_CHARS);
  }
  return transcript;
}

export interface RunConversationSummaryOptions {
  llm: LLMClient;
  model?: string;
  messages: Message[];
  hint?: string;
  signal?: AbortSignal;
}

export interface RunConversationSummaryResult {
  summary: string;
  /** Present when summary is non-empty: full replacement for prior context (user framing + assistant summary). */
  replacementMessages: Message[];
  /** Usage from the summarization API call (0–1 entries). */
  llmUsageEvents: LlmUsageEvent[];
}

export async function runConversationSummary(
  opts: RunConversationSummaryOptions
): Promise<RunConversationSummaryResult> {
  const { llm, model, messages, hint, signal } = opts;
  const transcript = formatConversationTranscript(messages);
  const hintLine = hint?.trim()
    ? `\n\n---\nAdditional instructions from the user: ${hint.trim()}`
    : "";

  const userContent = `Below is the conversation transcript.\n\n${transcript}${hintLine}\n\n---\nWrite the summary as instructed in your system message.`;

  const apiMessages: Message[] = [
    { role: "system", content: SUMMARY_PROMPT },
    { role: "user", content: userContent },
  ];

  const completion = await llm.chat(apiMessages, {
    model,
    temperature: 0.3,
    maxTokens: 4096,
    signal,
  });

  const summary = (completion.message.content ?? "").trim();
  const replacementMessages = summary ? summaryReplacementMessages(summary) : [];
  const ev = usageEventFromApi(completion.usage, {
    source: "summary",
    transcriptLength: summary ? replacementMessages.length : messages.length,
  });

  return {
    summary,
    replacementMessages,
    llmUsageEvents: ev ? [ev] : [],
  };
}
