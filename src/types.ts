/**
 * Core types for the coding agent framework.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: Role;
  content: string;
  /** For tool messages, the ID of the tool call this result corresponds to */
  toolCallId?: string;
  /** For assistant messages, the tool calls made by the model */
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
  /** Reasoning content from models that support thinking (e.g., Deepseek reasoning) */
  reasoningContent?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for tool arguments (e.g. from zod-to-json-schema) */
  parameters: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

export interface AgentConfig {
  /** LLM model name (can also set OPENAI_MODEL env) */
  model?: string;
  /** Max iterations in one run */
  maxSteps?: number;
  /** Working directory for file/shell operations */
  cwd?: string;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  context: { cwd: string }
) => Promise<string>;