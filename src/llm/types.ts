/**
 * LLM client abstraction. Default implementation uses OpenAI API.
 * Swap this for other providers (Anthropic, local models, etc.) as needed.
 */

import type { Message } from "../types.js";

export interface LLMOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Callback for streaming thinking content (reasoning) */
  onThinking?: (content: string) => void;
  /** When aborted, in-flight HTTP/stream is cancelled (e.g. user presses ESC). */
  signal?: AbortSignal;
}

export interface ChatCompletionMessage {
  role: "system" | "user" | "assistant";
  content: string | null;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
  reasoningContent?: string | null;
}

export interface ChatCompletionResult {
  message: ChatCompletionMessage;
  finishReason: "stop" | "tool_calls" | "length" | null;
  /** ms from request start to first streamed chunk (reasoning, content, or tool delta). Absent for non-streaming calls. */
  firstTokenTimeMs?: number;
  /** ms from request start until full response ready */
  latencyMs?: number;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

export interface LLMClient {
  chat(
    messages: Message[],
    options?: LLMOptions
  ): Promise<ChatCompletionResult>;
}

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

export interface LLMClientWithTools extends LLMClient {
  chatWithTools(
    messages: Message[],
    tools: ToolSchema[],
    options?: LLMOptions
  ): Promise<ChatCompletionResult>;
}
