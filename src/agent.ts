/**
 * Core agent loop: receive user task -> LLM decides -> execute tools -> repeat until done.
 */

import type { Message, ToolDefinition, ToolResult, AgentConfig } from "./types.js";
import type { LLMClientWithTools, ToolSchema } from "./llm/types.js";
import { getBuiltinTools } from "./tools/index.js";
import { join } from "node:path";
import { agentLogger, error } from "./agent-log.js";
import { SYSTEM_PROMPT } from "./prompts.js";
import {
  UNKNOWN_TOOL_MESSAGE,
  MAX_STEPS_MESSAGE,
  getToolCallSummary,
} from "./constants.js";
import { appendAssistantTextTurn, appendAssistantToolRound } from "./agent-conversation.js";
import type { LlmUsageEvent } from "./session-store.js";
import { usageEventFromApi } from "./session-store.js";
import type { ChatCompletionResult } from "./llm/types.js";


export interface RunResult {
  /** Final assistant message (summary or answer) */
  message: string;
  /** Number of LLM + tool steps taken */
  steps: number;
  /** Whether the agent finished without hitting max steps */
  finished: boolean;
  /** Full message history after this run (for multi-turn chat) */
  messages: Message[];
  /** Tool calls and results in order (for displaying thinking process) */
  stepDetails: StepDetail[];
  /** One entry per LLM completion in this run that returned usage (in order). */
  llmUsageEvents: LlmUsageEvent[];
}

export type StepDetail =
  | { type: "tool_call"; name: string; args: string }
  | { type: "tool_result"; content: string; isError?: boolean };

export interface RunOptions {
  /** Previous conversation messages (without system). Used for interactive chat. */
  initialMessages?: Message[];
  /** Override model for this run (e.g. current config.MODEL so /model changes take effect). */
  model?: string;
  /** Called during the run for streaming progress (thinking, tool_call, tool_result). */
  onProgress?: (event: ProgressEvent) => void;
  /** Abort signal to interrupt the run */
  signal?: AbortSignal;
}

export type ProgressEvent =
  | { type: "thinking"; content?: string }
  | { type: "response"; content: string; step?: number }
  | { type: "tool_call"; name: string; args: string }
  | { type: "tool_result"; content: string; isError?: boolean };

export interface AgentOptions {
  llm: LLMClientWithTools;
  config?: Partial<AgentConfig>;
  systemPrompt?: string;
  /** Extra tools beyond builtin */
  extraTools?: Array<{ definition: ToolDefinition; handler: (args: Record<string, unknown>, ctx: { cwd: string }) => Promise<string> }>;
}

/**
 * Safely parse tool arguments, ensuring they are valid JSON.
 * If parsing fails, returns an empty object and logs the error.
 */
function safeParseArguments(argsString: string | undefined, toolName: string): Record<string, unknown> {
  if (!argsString) {
    return {};
  }
  try {
    return JSON.parse(argsString) as Record<string, unknown>;
  } catch (err) {
    error(`Failed to parse arguments for tool "${toolName}": ${err instanceof Error ? err.message : String(err)}`);
    error(`Raw arguments: ${argsString}`);
    // Try to fix common issues:
    // 1. If it's already an object (some APIs return parsed object), return as-is
    if (typeof argsString === 'object' && argsString !== null) {
      return argsString as Record<string, unknown>;
    }
    // 2. Try to clean up common JSON issues
    const cleaned = argsString
      .replace(/'/g, '"') // Replace single quotes with double quotes
      .replace(/,\s*}/g, '}') // Remove trailing commas before closing brace
      .replace(/,\s*]/g, ']'); // Remove trailing commas before closing bracket
    try {
      return JSON.parse(cleaned) as Record<string, unknown>;
    } catch {
      // If all else fails, return empty object
      return {};
    }
  }
}

/**
 * Ensure tool call arguments are valid JSON strings.
 * This is important for APIs that strictly validate the arguments format.
 */
function ensureValidJsonArguments(argsString: string | undefined, toolName?: string): string {
  if (!argsString) {
    return '{}';
  }
  
  // If it's already a valid JSON string, return as-is
  try {
    JSON.parse(argsString);
    return argsString;
  } catch {
    // If it's already an object, stringify it
    if (typeof argsString === 'object' && argsString !== null) {
      return JSON.stringify(argsString);
    }
    
    // Try to fix common issues and re-stringify
    try {
      const cleaned = argsString
        .replace(/'/g, '"')
        .replace(/,\s*}/g, '}')
        .replace(/,\s*]/g, ']');
      const parsed = JSON.parse(cleaned);
      return JSON.stringify(parsed);
    } catch {
      // If all else fails, return empty object
      return '{}';
    }
  }
}

export function createAgent(options: AgentOptions) {
  const {
    llm,
    config = {},
    systemPrompt = SYSTEM_PROMPT,
    extraTools = [],
  } = options;

  const cwd = config.cwd ?? process.cwd();
  const maxSteps = config.maxSteps ?? 20;
  const model = config.model ?? process.env.OPENAI_MODEL ?? undefined;

  const allTools = [...getBuiltinTools(), ...extraTools];
  const toolsByName = new Map(allTools.map((t) => [t.definition.name, t]));

  const toolSchemas: ToolSchema[] = allTools.map((t) => ({
    type: "function",
    function: {
      name: t.definition.name,
      description: t.definition.description,
      parameters: t.definition.parameters,
    },
  }));

  async function run(userRequest: string, options?: RunOptions): Promise<RunResult> {
    const effectiveModel = options?.model ?? model ?? process.env.OPENAI_MODEL;
    agentLogger.runStart(userRequest, { options, maxSteps, model: effectiveModel });
    const initialMessages = options?.initialMessages ?? [];
    const onProgress = options?.onProgress;
    const signal = options?.signal;
    const messages: Message[] = [
      { role: "system", content: systemPrompt },
      ...initialMessages,
      { role: "user", content: userRequest },
    ];
    let steps = 0;
    let finished = false;
    const llmUsageEvents: LlmUsageEvent[] = [];
    const allStepDetails: RunResult["stepDetails"] = [];

    while (steps < maxSteps) {
      // Check for abort signal
      if (signal?.aborted) {
        agentLogger.runAborted();
        const result = {
          message: "Operation interrupted by user (ESC pressed)",
          steps,
          finished: false,
          messages,
          stepDetails: allStepDetails,
          llmUsageEvents,
        };
        agentLogger.runEnd(result);
        return result;
      }

      steps += 1;
      onProgress?.({ type: "thinking" });

      // Stream thinking: UI via onProgress; full text merged into upstream llm_call log
      let hasReceivedThinking = false;
      let accumulatedThinking = "";
      let completion: ChatCompletionResult;
      try {
        completion = await llm.chatWithTools(messages, toolSchemas, {
          model: effectiveModel,
          temperature: 0.2,
          maxTokens: 4096,
          signal,
          onThinking: (chunk) => {
            if (signal?.aborted) return;
            hasReceivedThinking = true;
            accumulatedThinking += chunk;
            // Debug: log chunk size (only to stderr, not to upstream.log)
            if (process.env.DEBUG_THINKING) {
              process.stderr.write(`[THINKING] Chunk length: ${chunk.length}, content: "${chunk.replace(/\n/g, '\\n')}"\n`);
            }
            onProgress?.({ type: "thinking", content: chunk });
          },
        });
      } catch (err) {
        if (signal?.aborted) {
          agentLogger.runAborted();
          const interrupted = {
            message: "Operation interrupted by user (ESC pressed)",
            steps,
            finished: false,
            messages,
            stepDetails: allStepDetails,
            llmUsageEvents,
          };
          agentLogger.runEnd(interrupted);
          return interrupted;
        }
        throw err;
      }

      agentLogger.llmCall({
        step: steps,
        model: effectiveModel,
        messages,
        tools: toolSchemas,
        result: completion,
        accumulatedThinking,
      });

      let pushedUsageThisIteration = false;
      const tryPushCurrentCompletion = () => {
        const ev = usageEventFromApi(completion.usage, {
          source: "agent",
          agentStep: steps,
          transcriptLength: messages.length - 1,
        });
        if (ev && !pushedUsageThisIteration) {
          llmUsageEvents.push(ev);
          pushedUsageThisIteration = true;
        }
      };

      // Check for abort signal after LLM call
      if (signal?.aborted) {
        agentLogger.runAborted();
        tryPushCurrentCompletion();
        const result = {
          message: "Operation interrupted by user (ESC pressed)",
          steps,
          finished: false,
          messages,
          stepDetails: allStepDetails,
          llmUsageEvents,
        };
        agentLogger.runEnd(result);
        return result;
      }

      const { message, finishReason } = completion;

      // Emit thinking content if provided by the model (e.g., Deepseek reasoning)
      // Only emit if we haven't already received streaming thinking chunks
      if (!hasReceivedThinking && message.reasoningContent) {
        onProgress?.({ type: "thinking", content: message.reasoningContent });
      }

      if (message.content) {
        // With tool calls, only one assistant row may appear before tool results, and it must
        // include tool_calls — so we defer the history push to the block below. Still emit the
        // preamble for the UI.
        if (!message.toolCalls?.length) {
          appendAssistantTextTurn(
            messages,
            message.content,
            message.reasoningContent ?? undefined
          );
        }
        onProgress?.({ type: "response", content: message.content, step: steps });
      }

      // If there are no tool calls, check if we should finish
      if (!message.toolCalls?.length) {
        if (finishReason === "stop") {
          finished = true;
          tryPushCurrentCompletion();
          const result = {
            message: message.content ?? "",
            steps,
            finished,
            messages,
            stepDetails: allStepDetails,
            llmUsageEvents,
          };
          agentLogger.runEnd(result);
          return result;
        }
        tryPushCurrentCompletion();
        break;
      }

      // If we reach here, there are tool calls to execute

      // Build tool results and append to messages
      const toolResults: ToolResult[] = [];
      const stepDetailsThisRound: RunResult["stepDetails"] = [];
      for (const tc of message.toolCalls) {
        // Check for abort signal before each tool call
        if (signal?.aborted) {
          agentLogger.runAborted();
          tryPushCurrentCompletion();
          const result = {
            message: "Operation interrupted by user (ESC pressed)",
            steps,
            finished: false,
            messages,
            stepDetails: allStepDetails,
            llmUsageEvents,
          };
          agentLogger.runEnd(result);
          return result;
        }

        // Ensure arguments are valid JSON string
        const validArgsString = ensureValidJsonArguments(tc.arguments, tc.name);
        agentLogger.toolCall(tc.name, validArgsString);
        const tool = toolsByName.get(tc.name);

        // Emit tool_call event before executing the tool
        onProgress?.({ type: "tool_call", name: tc.name, args: validArgsString });

        let content: string;
        let isError = false;
        try {
          if (!tool) {
            content = UNKNOWN_TOOL_MESSAGE(tc.name);
            isError = true;
            agentLogger.toolResult(tc.name, content, true);
          } else {
            const args = safeParseArguments(validArgsString, tc.name);
            content = await tool.handler(args, { cwd });
            agentLogger.toolResult(tc.name, content, false);
          }
        } catch (err) {
          content = err instanceof Error ? err.message : String(err);
          isError = true;
          agentLogger.toolResult(tc.name, content, true);
        }
        stepDetailsThisRound.push({ type: "tool_call", name: tc.name, args: validArgsString });
        stepDetailsThisRound.push({ type: "tool_result", content, isError });
        // tool_call event already emitted above, now emit tool_result
        onProgress?.({ type: "tool_result", content, isError });
        toolResults.push({
          toolCallId: tc.id,
          content,
          isError,
        });

        // Check for abort signal after each tool execution
        if (signal?.aborted) {
          agentLogger.runAborted();
          tryPushCurrentCompletion();
          const result = {
            message: "Operation interrupted by user (ESC pressed)",
            steps,
            finished: false,
            messages,
            stepDetails: allStepDetails,
            llmUsageEvents,
          };
          agentLogger.runEnd(result);
          return result;
        }
      }
      allStepDetails.push(...stepDetailsThisRound);

      // Check for abort signal before next iteration
      if (signal?.aborted) {
        agentLogger.runAborted();
        tryPushCurrentCompletion();
        const result = {
          message: "Operation interrupted by user (ESC pressed)",
          steps,
          finished: false,
          messages,
          stepDetails: allStepDetails,
          llmUsageEvents,
        };
        agentLogger.runEnd(result);
        return result;
      }

      // Append assistant message with tool calls (with validated arguments)
      const assistantContent =
        message.content ||
        getToolCallSummary(message.toolCalls);
      
      // Ensure all tool call arguments are valid JSON strings before storing in history
      const validatedToolCalls = message.toolCalls.map(tc => ({
        id: tc.id,
        name: tc.name,
        arguments: ensureValidJsonArguments(tc.arguments, tc.name),
      }));
      
      appendAssistantToolRound(
        messages,
        {
          content: assistantContent,
          reasoningContent: message.reasoningContent ?? undefined,
          toolCalls: validatedToolCalls,
        },
        toolResults.map((r) => ({
          toolCallId: r.toolCallId,
          content: r.content,
        }))
      );
      tryPushCurrentCompletion();
    }

    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    const result = {
      message: lastAssistant?.content ?? MAX_STEPS_MESSAGE,
      steps,
      finished: false,
      messages,
      stepDetails: allStepDetails,
      llmUsageEvents,
    };
    agentLogger.runEnd(result);
    return result;
  }

  return { run };
}
