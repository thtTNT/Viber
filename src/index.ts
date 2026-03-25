/**
 * VIBER - Minimal Node.js coding agent framework
 *
 * Usage:
 *   import { createAgent } from "viber-agent";
 *   import { createOpenAIClient } from "viber-agent/llm";
 *   const agent = createAgent({ llm: createOpenAIClient() });
 *   const result = await agent.run("List files in current directory");
 */

export { createAgent } from "./agent.js";
export type { RunResult, RunOptions, AgentOptions, StepDetail, ProgressEvent } from "./agent.js";
export type { Message, ToolDefinition, ToolResult, AgentConfig } from "./types.js";
export { getBuiltinTools } from "./tools/index.js";
