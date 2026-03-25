/**
 * MCP stdio clients: connect configured servers, bridge tools into agent extraTools.
 */

import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolDefinition } from "../types.js";
import {
  loadWorkspaceViberConfig,
  getMcpServersFromWorkspace,
  type McpServerConfig,
} from "../workspace-viber-config.js";
import { formatMcpCallToolResult } from "./format-result.js";

const VIBER_MCP_CLIENT_NAME = "viber";
const VIBER_MCP_CLIENT_VERSION = "0.1.0";

export type McpExtraTool = {
  definition: ToolDefinition;
  handler: (args: Record<string, unknown>, ctx: { cwd: string }) => Promise<string>;
};

export interface McpSession {
  extraTools: McpExtraTool[];
  close: () => Promise<void>;
}

function sanitizeToolNameSegment(s: string): string {
  const t = s.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  return t || "x";
}

/** OpenAI-safe name exposed to the model; maps to one MCP server + tool. */
export function mcpBridgeOpenAiToolName(serverId: string, mcpToolName: string): string {
  return `mcp__${sanitizeToolNameSegment(serverId)}__${sanitizeToolNameSegment(mcpToolName)}`;
}

function mcpToolUnsupported(tool: Tool): boolean {
  return tool.execution?.taskSupport === "required";
}

function normalizeParameters(inputSchema: Tool["inputSchema"] | undefined): Record<string, unknown> {
  if (!inputSchema || typeof inputSchema !== "object") {
    return { type: "object", properties: {} };
  }
  const base = inputSchema as Record<string, unknown>;
  if (base.type !== "object") {
    return { type: "object", properties: {}, ...base };
  }
  return JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
}

const MCP_SERVER_MISC_LOG = "misc.log";

/**
 * Append MCP subprocess stderr to `logFilePath` (e.g. `{conversationLogDir}/misc.log`).
 * Node's spawn rejects WriteStream before its `open` event (fd still null); a numeric fd is valid in stdio.
 */
function tryOpenMcpMiscLogFd(logFilePath: string): number | undefined {
  try {
    mkdirSync(dirname(logFilePath), { recursive: true });
    return openSync(logFilePath, "a");
  } catch {
    return undefined;
  }
}

function resolveMcpMiscLogPath(workspaceCwd: string, conversationLogDir?: string): string {
  if (conversationLogDir) {
    return join(conversationLogDir, MCP_SERVER_MISC_LOG);
  }
  return join(workspaceCwd, ".viber", MCP_SERVER_MISC_LOG);
}

async function listAllTools(client: Client): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  for (;;) {
    const res = await client.listTools(cursor ? { cursor } : {});
    tools.push(...res.tools);
    if (!res.nextCursor) {
      break;
    }
    cursor = res.nextCursor;
  }
  return tools;
}

async function connectServer(
  serverId: string,
  entry: McpServerConfig,
  stderr?: ConstructorParameters<typeof StdioClientTransport>[0]["stderr"]
): Promise<Client> {
  if (!entry.command || typeof entry.command !== "string") {
    throw new Error(`Server "${serverId}": missing or invalid "command"`);
  }
  const transport = new StdioClientTransport({
    command: entry.command,
    args: Array.isArray(entry.args) ? entry.args : [],
    env: entry.env && typeof entry.env === "object" ? entry.env : undefined,
    cwd: entry.cwd,
    ...(stderr !== undefined ? { stderr } : {}),
  });
  const client = new Client(
    { name: VIBER_MCP_CLIENT_NAME, version: VIBER_MCP_CLIENT_VERSION },
    { capabilities: {} }
  );
  await client.connect(transport);
  return client;
}

/**
 * Empty session when no MCP config or no servers; always safe to call `close`.
 */
export function emptyMcpSession(): McpSession {
  return {
    extraTools: [],
    close: async () => {},
  };
}

/**
 * Start stdio MCP servers from `.viber/config.json`, list tools, build extraTools. Caller must `close()` when done.
 *
 * @param conversationLogDir — Same folder as upstream LLM logs (`ConversationContext.logDir`); MCP stderr goes to `misc.log` there. Omit to use `.viber/misc.log` under `cwd` (e.g. `/mcp` probe).
 */
export async function createMcpSession(
  cwd: string,
  onServerError?: (serverId: string, err: Error) => void,
  conversationLogDir?: string
): Promise<McpSession> {
  const loaded = loadWorkspaceViberConfig(cwd);
  if (!loaded.ok) {
    if (loaded.reason === "missing") {
      return emptyMcpSession();
    }
    throw new Error(`${loaded.path}: ${loaded.message}`);
  }

  const servers = getMcpServersFromWorkspace(loaded.data);
  if (!servers || Object.keys(servers).length === 0) {
    return emptyMcpSession();
  }

  const clients: Client[] = [];
  const extraTools: McpExtraTool[] = [];
  const usedOpenAiNames = new Set<string>();
  const miscLogFd = tryOpenMcpMiscLogFd(resolveMcpMiscLogPath(cwd, conversationLogDir));

  for (const [serverId, entry] of Object.entries(servers)) {
    let client: Client;
    try {
      client = await connectServer(serverId, entry, miscLogFd);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      onServerError?.(serverId, err);
      continue;
    }
    clients.push(client);

    let tools: Tool[];
    try {
      tools = await listAllTools(client);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      onServerError?.(serverId, err);
      try {
        await client.close();
      } catch {
        /* ignore */
      }
      clients.pop();
      continue;
    }

    for (const tool of tools) {
      if (mcpToolUnsupported(tool)) {
        continue;
      }
      let openAiName = mcpBridgeOpenAiToolName(serverId, tool.name);
      if (usedOpenAiNames.has(openAiName)) {
        let n = 2;
        while (usedOpenAiNames.has(`${openAiName}_${n}`)) {
          n += 1;
        }
        openAiName = `${openAiName}_${n}`;
      }
      usedOpenAiNames.add(openAiName);

      const mcpToolName = tool.name;
      const description =
        (tool.description?.trim() || `MCP tool ${mcpToolName} (server: ${serverId})`) +
        ` [MCP server: ${serverId}, original name: ${mcpToolName}]`;

      extraTools.push({
        definition: {
          name: openAiName,
          description,
          parameters: normalizeParameters(tool.inputSchema),
        },
        handler: async (args) => {
          const result = (await client.callTool({
            name: mcpToolName,
            arguments: args as Record<string, unknown>,
          })) as CallToolResult;
          return formatMcpCallToolResult(result);
        },
      });
    }
  }

  return {
    extraTools,
    close: async () => {
      for (const c of clients) {
        try {
          await c.close();
        } catch {
          /* ignore */
        }
      }
      if (miscLogFd !== undefined) {
        try {
          closeSync(miscLogFd);
        } catch {
          /* ignore */
        }
      }
    },
  };
}

export type McpProbeRow = {
  id: string;
  commandLine: string;
  ok: boolean;
  error?: string;
  toolCount?: number;
  toolNames?: string[];
};

/**
 * Connect each server, list tools, then disconnect — for `/mcp` status.
 */
export async function probeMcpServers(cwd: string): Promise<{
  configPath: string;
  configStatus: "missing" | "invalid" | "empty" | "ok";
  configError?: string;
  servers: McpProbeRow[];
}> {
  const loaded = loadWorkspaceViberConfig(cwd);
  const configPath = loaded.path;

  if (!loaded.ok) {
    if (loaded.reason === "missing") {
      return { configPath, configStatus: "missing", servers: [] };
    }
    return {
      configPath,
      configStatus: "invalid",
      configError: loaded.message,
      servers: [],
    };
  }

  const serversMap = getMcpServersFromWorkspace(loaded.data);
  if (!serversMap || Object.keys(serversMap).length === 0) {
    return { configPath, configStatus: "empty", servers: [] };
  }

  const servers: McpProbeRow[] = [];
  const miscLogFd = tryOpenMcpMiscLogFd(resolveMcpMiscLogPath(cwd));

  for (const [serverId, entry] of Object.entries(serversMap)) {
    const args = Array.isArray(entry.args) ? entry.args : [];
    const commandLine = [entry.command, ...args].join(" ");
    let client: Client | undefined;
    try {
      client = await connectServer(serverId, entry, miscLogFd);
      const tools = await listAllTools(client);
      const supported = tools.filter((t) => !mcpToolUnsupported(t));
      servers.push({
        id: serverId,
        commandLine,
        ok: true,
        toolCount: supported.length,
        toolNames: supported.map((t) => t.name),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      servers.push({
        id: serverId,
        commandLine,
        ok: false,
        error: message,
      });
    } finally {
      if (client) {
        try {
          await client.close();
        } catch {
          /* ignore */
        }
      }
    }
  }

  if (miscLogFd !== undefined) {
    try {
      closeSync(miscLogFd);
    } catch {
      /* ignore */
    }
  }

  return { configPath, configStatus: "ok", servers };
}
