/**
 * Build tool schemas and handler map for standard vs PTC (sandboxed JS) mode.
 */

import type { ToolDefinition } from "../types.js";
import type { ToolHandler } from "../types.js";
import type { ToolSchema } from "../llm/types.js";
import type { ToolCallMode } from "../config.js";
import { PTC_META_TOOL_NAME } from "./ptc-sandbox.js";

export type RegisteredTool = { definition: ToolDefinition; handler: ToolHandler };

const PTC_META_DEFINITION: ToolDefinition = {
  name: PTC_META_TOOL_NAME,
  description:
    "Run JavaScript in a sandbox to orchestrate multiple built-in tools in one step. " +
    "Pass `code`: async body (wrapped by the host) where you can `await read_file({ path: \"...\" })`, " +
    "`await search({ pattern: \"...\" })`, `await run_shell({ command: \"...\" })`, etc., using the same " +
    "argument objects as standard tool calls. Use RegExp and pure JS to filter or aggregate. " +
    "Return a concise string or JSON-serializable value. MCP tools are not available here—call them with separate tool_calls.",
  parameters: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description: "JavaScript source executed inside an async function; use await on built-in tool functions.",
      },
    },
    required: ["code"],
  },
};

function toSchema(t: ToolDefinition): ToolSchema {
  return {
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  };
}

/**
 * @param ptcMetaHandler - Required when mode is `ptc`; implements run_builtin_tools_code.
 */
export function buildAgentTooling(
  mode: ToolCallMode,
  builtins: RegisteredTool[],
  extraTools: RegisteredTool[],
  ptcMetaHandler?: ToolHandler
): { toolSchemas: ToolSchema[]; toolsByName: Map<string, RegisteredTool> } {
  const toolsByName = new Map<string, RegisteredTool>();

  if (mode === "standard") {
    for (const t of [...builtins, ...extraTools]) {
      toolsByName.set(t.definition.name, t);
    }
    return {
      toolSchemas: [...toolsByName.values()].map((t) => toSchema(t.definition)),
      toolsByName,
    };
  }

  if (!ptcMetaHandler) {
    throw new Error("buildAgentTooling: ptc mode requires ptcMetaHandler");
  }

  toolsByName.set(PTC_META_TOOL_NAME, {
    definition: PTC_META_DEFINITION,
    handler: ptcMetaHandler,
  });
  for (const t of extraTools) {
    toolsByName.set(t.definition.name, t);
  }

  const toolSchemas: ToolSchema[] = [
    toSchema(PTC_META_DEFINITION),
    ...extraTools.map((t) => toSchema(t.definition)),
  ];

  return { toolSchemas, toolsByName };
}
