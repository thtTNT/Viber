/**
 * OpenAI-based LLM client with tool-calling support.
 * Supports custom baseURL (e.g. proxy, Azure, OpenRouter, local OpenAI-compatible API).
 */

import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import type { Message } from "../types.js";
import type {
  LLMClientWithTools,
  LLMOptions,
  ChatCompletionResult,
  ToolSchema,
} from "./types.js";

export interface OpenAIClientOptions {
  /** API key (default: OPENAI_API_KEY env) */
  apiKey?: string;
  /** Override API base URL (default: OPENAI_BASE_URL env or https://api.openai.com/v1) */
  baseURL?: string;
}

/**
 * Validate tool call arguments are valid JSON strings.
 * Returns error message as JSON if invalid, so LLM can see the issue.
 */
function validateJsonArguments(argsString: string | undefined, toolName: string): string {
  if (!argsString) {
    return JSON.stringify({
      error: `API returned empty arguments for tool "${toolName}"`,
      suggestion: "Please try again or use different parameters"
    });
  }
  
  // If it's already a valid JSON string, return as-is
  try {
    JSON.parse(argsString);
    return argsString;
  } catch (e) {
    // Return error as tool result instead of throwing
    return JSON.stringify({
      error: `API returned invalid JSON in tool call arguments for "${toolName}"`,
      rawArguments: argsString.substring(0, 1000), // Limit length
      parseError: String(e),
      suggestion: "The API response was malformed. Please try again or describe what you wanted to do."
    });
  }
}

/**
 * OpenAI newer / reasoning routes and some gateways reject `max_tokens` and expect
 * `max_completion_tokens` instead. Override with OPENAI_MAX_COMPLETION_TOKENS=1|0 or VIBER_MAX_COMPLETION_TOKENS.
 */
function chatCompletionTokenLimit(
  model: string,
  maxTokens: number
): { max_tokens?: number | null; max_completion_tokens?: number | null } {
  const env =
    process.env.OPENAI_MAX_COMPLETION_TOKENS ?? process.env.VIBER_MAX_COMPLETION_TOKENS;
  const e = env?.toLowerCase();
  if (e === "0" || e === "false" || e === "no") {
    return { max_tokens: maxTokens };
  }
  if (e === "1" || e === "true" || e === "yes") {
    return { max_completion_tokens: maxTokens };
  }
  const lower = model.toLowerCase();
  const useCompletion =
    lower.includes("gpt-5") ||
    lower.includes("codex") ||
    /^o1/i.test(model) ||
    /^o3/i.test(model);
  return useCompletion
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
}

/** Some gateways omit tool_call.id in streams; tool role messages still need a stable id. */
function ensureToolCallIds(
  toolCalls: Array<{ id: string; name: string; arguments: string }>
): Array<{ id: string; name: string; arguments: string }> {
  let seq = 0;
  return toolCalls.map((tc) => ({
    ...tc,
    id:
      typeof tc.id === "string" && tc.id.trim() !== ""
        ? tc.id
        : `viber_tc_${randomUUID().replace(/-/g, "").slice(0, 12)}_${seq++}`,
  }));
}

export function createOpenAIClient(options?: string | OpenAIClientOptions): LLMClientWithTools {
  const opts: OpenAIClientOptions =
    typeof options === "string" ? { apiKey: options } : options ?? {};
  const key = opts.apiKey ?? process.env.OPENAI_API_KEY;
  const baseURL = opts.baseURL ?? process.env.OPENAI_BASE_URL;
  if (!key) {
    throw new Error("OPENAI_API_KEY is required. Set env or pass apiKey in options.");
  }
  const client = new OpenAI({
    apiKey: key,
    ...(baseURL && { baseURL: baseURL }),
  });

  const chat: LLMClientWithTools["chat"] = async (messages, options = {}) => {
    const model = options.model ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini";
    const t0 = Date.now();
    const limit = chatCompletionTokenLimit(model, options.maxTokens ?? 4096);
    const resp = await client.chat.completions.create({
      model,
      messages: messages.map((m) => {
        if (m.role === "tool") {
          if (!m.toolCallId) {
            throw new Error("Tool message must have toolCallId");
          }
          return {
            role: m.role,
            content: m.content,
            tool_call_id: m.toolCallId,
          };
        }
        return {
          role: m.role,
          content: m.content,
        };
      }),
      temperature: options.temperature ?? 0.2,
      ...limit,
    });
    const choice = resp.choices[0];
    if (!choice?.message) {
      throw new Error("Empty completion from OpenAI");
    }
    const msg = choice.message;
    // Extract reasoning content from Deepseek/SiliconFlow API
    const reasoningContent = (msg as any).reasoning ?? (msg as any).reasoning_content ?? null;
    const latencyMs = Date.now() - t0;
    const u = resp.usage;
    return {
      message: {
        role: msg.role as "system" | "user" | "assistant",
        content: msg.content ?? "",
        toolCalls: msg.tool_calls?.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: validateJsonArguments(tc.function.arguments, `tool call ${tc.function.name}`),
        })),
        reasoningContent,
      },
      finishReason: choice.finish_reason as ChatCompletionResult["finishReason"],
      latencyMs,
      usage: u
        ? {
            promptTokens: u.prompt_tokens,
            completionTokens: u.completion_tokens,
            totalTokens: u.total_tokens,
          }
        : undefined,
    };
  };

  const chatWithTools: LLMClientWithTools["chatWithTools"] = async (
    messages,
    tools,
    options = {}
  ) => {
    const model = options.model ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini";
    const onThinking = options.onThinking;

    // Map messages to OpenAI format
    const openaiMessages = messages.map((m) => {
      if (m.role === "tool") {
        if (!m.toolCallId) {
          throw new Error("Tool message must have toolCallId");
        }
        return {
          role: m.role,
          content: m.content,
          tool_call_id: m.toolCallId,
        };
      }
      // For assistant messages with tool calls, include tool_calls field
      if (m.role === "assistant" && (m as any).toolCalls) {
        const toolCalls = (m as any).toolCalls;
        return {
          role: m.role,
          content: m.content,
          reasoning_content: (m as any).reasoningContent,
          tool_calls: toolCalls.map((tc: any) => ({
            id: tc.id,
            type: "function" as const,
            function: {
              name: tc.name,
              // Ensure arguments are valid JSON strings
              arguments: validateJsonArguments(tc.arguments, `tool call ${tc.name}`),
            },
          })),
        };
      }
      // For assistant messages with reasoning content, include reasoning_content field
      // This is required for Deepseek thinking mode
      if (m.role === "assistant" && (m as any).reasoningContent) {
        return {
          role: m.role,
          content: m.content,
          reasoning_content: (m as any).reasoningContent,
        };
      }
      return {
        role: m.role,
        content: m.content,
      };
    });

    // If onThinking callback is provided, use streaming to get reasoning content
    if (onThinking) {
      const t0 = Date.now();
      let firstTokenTimeMs: number | undefined;
      const markFirstToken = () => {
        if (firstTokenTimeMs === undefined) {
          firstTokenTimeMs = Date.now() - t0;
        }
      };

      const streamLimit = chatCompletionTokenLimit(model, options.maxTokens ?? 4096);
      const stream = await client.chat.completions.create(
        {
          model,
          messages: openaiMessages,
          tools: tools as OpenAI.Chat.Completions.ChatCompletionTool[],
          tool_choice: "auto",
          temperature: options.temperature ?? 0.2,
          ...streamLimit,
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: options.signal ?? undefined }
      );

      let content = "";
      let toolCalls: Array<{id: string, name: string, arguments: string}> = [];
      let finishReason: ChatCompletionResult["finishReason"] = null;
      let role: "system" | "user" | "assistant" = "assistant";
      let streamUsage: ChatCompletionResult["usage"];

      for await (const chunk of stream) {
        if (chunk.usage) {
          const u = chunk.usage;
          streamUsage = {
            promptTokens: u.prompt_tokens,
            completionTokens: u.completion_tokens,
            totalTokens: u.total_tokens,
          };
        }

        const choice = chunk.choices[0];
        if (!choice) continue;

        const delta = choice.delta;

        // Handle reasoning content from Deepseek/SiliconFlow API
        const reasoningDelta = (delta as any).reasoning ?? (delta as any).reasoning_content;
        if (reasoningDelta !== undefined && reasoningDelta !== null) {
          markFirstToken();
          if (process.env.DEBUG_THINKING) {
            process.stderr.write(`[OPENAI] Reasoning delta: "${String(reasoningDelta).replace(/\\n/g, '\\\\n')}" (type: ${typeof reasoningDelta})\\\\n`);
          }
          onThinking(String(reasoningDelta));
        }

        // Accumulate content
        if (delta.content) {
          markFirstToken();
          content += delta.content;
        }

        // Handle role
        if (delta.role) {
          role = delta.role as "system" | "user" | "assistant";
        }

        // Handle tool calls
        if (delta.tool_calls) {
          for (let i = 0; i < delta.tool_calls.length; i++) {
            const tc = delta.tool_calls[i] as {
              index?: number | null;
              id?: string;
              function?: { name?: string; arguments?: string };
            };
            const slotIndex =
              tc.index !== undefined && tc.index !== null ? tc.index : i;
            if (!toolCalls[slotIndex]) {
              toolCalls[slotIndex] = { id: tc.id || "", name: "", arguments: "" };
            } else if (tc.id) {
              toolCalls[slotIndex].id = tc.id;
            }
            if (tc.function?.name) {
              markFirstToken();
              toolCalls[slotIndex].name = tc.function.name;
            }
            if (tc.function?.arguments) {
              markFirstToken();
              toolCalls[slotIndex].arguments += tc.function.arguments;
            }
          }
        }

        // Handle finish reason
        if (choice.finish_reason) {
          finishReason = choice.finish_reason as ChatCompletionResult["finishReason"];
        }
      }

      // Ensure all tool call arguments are valid JSON strings before returning
      const validatedToolCalls = ensureToolCallIds(
        toolCalls
          .filter((tc) => tc.name)
          .map((tc) => ({
            ...tc,
            arguments: validateJsonArguments(tc.arguments, `tool call ${tc.name}`),
          }))
      );

      // Extract final reasoning content from the accumulated message (some APIs provide it in the final message)
      // For streaming, we've already handled reasoning via onThinking callback
      const finalReasoningContent = null; // Already streamed via onThinking
      const latencyMs = Date.now() - t0;

      return {
        message: {
          role,
          content,
          toolCalls: validatedToolCalls.length ? validatedToolCalls : undefined,
          reasoningContent: finalReasoningContent,
        },
        finishReason,
        firstTokenTimeMs,
        latencyMs,
        usage: streamUsage,
      };
    } else {
      // Non-streaming version (original implementation)
      const t0 = Date.now();
      const nsLimit = chatCompletionTokenLimit(model, options.maxTokens ?? 4096);
      const resp = await client.chat.completions.create(
        {
          model,
          messages: openaiMessages,
          tools: tools as OpenAI.Chat.Completions.ChatCompletionTool[],
          tool_choice: "auto",
          temperature: options.temperature ?? 0.2,
          ...nsLimit,
        },
        { signal: options.signal ?? undefined }
      );
      const choice = resp.choices[0];
      if (!choice?.message) {
        throw new Error("Empty completion from OpenAI");
      }
      const msg = choice.message;
      // Extract reasoning content from Deepseek/SiliconFlow API
      const reasoningContent = (msg as any).reasoning ?? (msg as any).reasoning_content ?? null;
      const latencyMs = Date.now() - t0;
      const u = resp.usage;
      const mappedToolCalls = (msg.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: validateJsonArguments(
          tc.function.arguments,
          `tool call ${tc.function.name}`
        ),
      }));
      const withIds =
        mappedToolCalls.length > 0 ? ensureToolCallIds(mappedToolCalls) : undefined;
      return {
        message: {
          role: msg.role as "system" | "user" | "assistant",
          content: msg.content ?? "",
          toolCalls: withIds,
          reasoningContent,
        },
        finishReason: choice.finish_reason as ChatCompletionResult["finishReason"],
        latencyMs,
        usage: u
          ? {
              promptTokens: u.prompt_tokens,
              completionTokens: u.completion_tokens,
              totalTokens: u.total_tokens,
            }
          : undefined,
      };
    }
  };

  return { chat, chatWithTools };
}
