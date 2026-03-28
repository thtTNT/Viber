/**
 * Command system for Viber agent.
 * Handles commands starting with '/' prefix.
 */

import { loadConfig, saveConfig } from "./config.js";
import { formatApiUsageSection } from "./utils/context-stats.js";
import {
  loadSession,
  exportSessionToMarkdown,
  truncateUsageHistoryToTranscriptLength,
  truncateTurnCheckpointsToMessageLength,
  resolveStepCountForRewind,
  type LlmUsageSnapshot,
  type LlmUsageEvent,
  type TurnCheckpoint,
} from "./session-store.js";
import {
  findUserMessageIndices,
  sliceToBeforeNthUserTurnFromEnd,
} from "./rewind-transcript.js";
import {
  SUB_SCREEN_SESSION,
  SUB_SCREEN_CONFIG,
  SUB_SCREEN_REWIND,
  type OpenSubScreenRequest,
} from "./tui/sub-screen-types.js";

import type { Message } from "./types.js";
import { probeMcpServers } from "./mcp/session.js";

function countToolCallsInMessages(messages: Message[]): number {
  let n = 0;
  for (const m of messages) {
    n += m.toolCalls?.length ?? 0;
  }
  return n;
}

function formatTranscriptMetrics(messageCount: number, toolCallCount: number): string {
  const lines: string[] = [];
  lines.push("╭─ 对话规模 " + "─".repeat(Math.max(0, 42)));
  lines.push(`│ 消息条数:     ${messageCount}`);
  lines.push(`│ 工具调用次数: ${toolCallCount}`);
  lines.push("╰" + "─".repeat(Math.max(0, 45)));
  return lines.join("\n");
}

/**
 * Fetch available models from the API
 */
async function fetchModels(): Promise<string[]> {
  const config = loadConfig();
  const apiKey = config.API_KEY || process.env.OPENAI_API_KEY;
  const baseUrl = config.BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  
  if (!apiKey) {
    throw new Error("API key is not configured. Please set OPENAI_API_KEY or configure via config file.");
  }
  
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  const urlsToTry = [
    `${normalizedBaseUrl}/models`,
    ...(normalizedBaseUrl.endsWith("/v1") ? [] : [`${normalizedBaseUrl}/v1/models`]),
  ];
  const headers = {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  let response: Response | null = null;
  let lastError: string = "";
  for (const modelsUrl of urlsToTry) {
    response = await fetch(modelsUrl, { headers });
    if (response.ok) break;
    lastError = await response.text().catch(() => response!.statusText);
    if (response.status !== 404) {
      throw new Error(`Failed to fetch models: ${response.status} ${response.statusText} - ${lastError}`);
    }
  }

  if (!response || !response.ok) {
    throw new Error(
      `Models endpoint not available (404). This API may not support listing models.\n` +
      `You can set a model directly with: /model <model_name>`
    );
  }

  const data = await response.json();
  
  // Handle different API response formats
  if (data.data && Array.isArray(data.data)) {
    // OpenAI format: { data: [{ id: "model-name", ... }, ...] }
    return data.data.map((model: any) => model.id).sort();
  } else if (Array.isArray(data)) {
    // Direct array format
    return data.map((model: any) => model.id || model.name || String(model)).sort();
  } else if (data.models && Array.isArray(data.models)) {
    // Alternative format: { models: [...] }
    return data.models.map((model: any) => model.id || model.name || String(model)).sort();
  }
  
  throw new Error("Unexpected API response format for models endpoint");
}

export interface CommandContext {
  /** Current conversation history (without system message) */
  messages?: Message[];
  /** Current working directory */
  cwd?: string;
  /** Active session id in interactive UI */
  sessionId?: string;
  /** Display name for the active session (TUI session manager) */
  sessionName?: string;
  /** Last API completion usage for this session (persisted), for /context */
  lastLlmUsage?: LlmUsageSnapshot;
  /** For /rewind step + usage alignment */
  llmUsageHistory?: LlmUsageEvent[];
  turnCheckpoints?: TurnCheckpoint[];
}

export interface CommandResult {
  /** Whether the command was handled */
  handled: boolean;
  /** Output message to display */
  output?: string;
  /** Whether to exit after command */
  exit?: boolean;
  /** Whether to clear history */
  clearHistory?: boolean;
  /** When a command renames the active session on disk, sync TUI display name */
  sessionNameUpdate?: { forSessionId: string; name: string | undefined };
  /** Interactive TUI: open a full-screen sub-panel (see `tui/sub-screen-types.ts`) */
  openSubScreen?: OpenSubScreenRequest;
  /** Host runs a one-shot LLM summary of `context.messages` (TUI or CLI with resumed messages) */
  runSummary?: { hint?: string };
  /** TUI: rewind transcript (applied in ink-app) */
  rewind?: {
    messages: Message[];
    stepCount: number;
    llmUsageHistory: LlmUsageEvent[];
    turnCheckpoints: TurnCheckpoint[];
  };
}

/** Shared rewind payload for TUI picker and `/rewind n` (returns null if nothing to drop). */
export function buildRewindResult(
  messages: Message[],
  newMessages: Message[],
  nUserTurnsRemoved: number,
  context?: Pick<CommandContext, "llmUsageHistory" | "turnCheckpoints">
): Pick<CommandResult, "output" | "rewind"> | null {
  if (newMessages.length === messages.length) {
    return null;
  }
  const L = newMessages.length;
  const truncatedUsage = truncateUsageHistoryToTranscriptLength(
    context?.llmUsageHistory,
    L
  );
  const truncatedCp = truncateTurnCheckpointsToMessageLength(
    context?.turnCheckpoints,
    L
  );
  const stepCount = resolveStepCountForRewind(
    context?.turnCheckpoints,
    L,
    truncatedUsage
  );
  const removed = messages.length - newMessages.length;
  return {
    output: `已回退 ${nUserTurnsRemoved} 轮用户消息（移除 ${removed} 条 transcript）。注意：工作区文件不会因 /rewind 而恢复。`,
    rewind: {
      messages: newMessages,
      stepCount,
      llmUsageHistory: truncatedUsage,
      turnCheckpoints: truncatedCp,
    },
  };
}

export interface CommandDefinition {
  name: string;
  description: string;
  aliases?: string[];
  handler: (args: string, context?: CommandContext) => CommandResult | Promise<CommandResult>;
}

/**
 * Built-in commands registry
 */
const commands: Map<string, CommandDefinition> = new Map();

/**
 * Register a command
 */
export function registerCommand(cmd: CommandDefinition): void {
  commands.set(cmd.name, cmd);
  if (cmd.aliases) {
    for (const alias of cmd.aliases) {
      commands.set(alias, cmd);
    }
  }
}

/**
 * Process a command string (without the leading '/')
 */
export async function processCommand(input: string, context?: CommandContext): Promise<CommandResult> {
  const trimmed = input.trim();
  const parts = trimmed.split(/\s+/);
  const cmdName = parts[0]?.toLowerCase() || "";
  const args = parts.slice(1).join(" ");

  const cmd = commands.get(cmdName);
  if (!cmd) {
    return {
      handled: true,
      output: `Unknown command: /${cmdName}. Type /help for available commands.`,
    };
  }

  try {
    return await cmd.handler(args, context);
  } catch (err) {
    return {
      handled: true,
      output: `Error executing command: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Check if input is a command (starts with '/')
 */
export function isCommand(input: string): boolean {
  return input.startsWith("/");
}

/**
 * Get all available commands for help display
 */
export function getAvailableCommands(): CommandDefinition[] {
  const seen = new Set<CommandDefinition>();
  const result: CommandDefinition[] = [];
  
  for (const cmd of commands.values()) {
    if (!seen.has(cmd)) {
      seen.add(cmd);
      result.push(cmd);
    }
  }
  
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

// -------- Built-in Commands --------

// /status - Show current configuration
registerCommand({
  name: "status",
  description: "Show current model, API URL, and configuration",
  aliases: ["info"],
  handler: () => {
    const config = loadConfig();
    const cwd = process.cwd();
    const model = config.MODEL || process.env.OPENAI_MODEL || "not set";
    const baseUrl = config.BASE_URL || process.env.OPENAI_BASE_URL || "default (api.openai.com)";
    const apiKeySet = !!(config.API_KEY || process.env.OPENAI_API_KEY);
    const toolMode = config.TOOL_CALL_MODE ?? "standard";

    // Format values with better alignment
    const labelWidth = 14; // Width for labels like "Model:", "Tool mode:", etc.
    const formatLine = (label: string, value: string) =>
      `│ ${label.padEnd(labelWidth)} ${value}`;

    const statusLines = [
      formatLine("Model:", model),
      formatLine("API URL:", baseUrl),
      formatLine("API Key:", apiKeySet ? "✓ configured" : "✗ not set"),
      formatLine("Tool mode:", toolMode === "ptc" ? "ptc (sandbox JS)" : "standard"),
      formatLine("CWD:", cwd),
    ];
    
    // Calculate max width for dynamic border
    const maxContentWidth = Math.max(...statusLines.map(line => line.length));
    const borderInnerWidth = maxContentWidth - 2; // Subtract "│ " prefix and suffix
    const topBorder = `╭─ Status ${"─".repeat(borderInnerWidth - 8)}`;
    const bottomBorder = `╰${"─".repeat(borderInnerWidth + 1)}`;
    
    const output = [
      topBorder,
      ...statusLines,
      bottomBorder,
    ].join("\n");
    
    return {
      handled: true,
      output,
    };
  },
});

// /help - Show available commands
registerCommand({
  name: "help",
  description: "Show available commands",
  aliases: ["?"],
  handler: () => {
    const cmds = getAvailableCommands();
    const lines: string[] = [];
    
    // Build command entries
    for (const cmd of cmds) {
      const aliases = cmd.aliases?.length ? ` (${cmd.aliases.map(a => `/${a}`).join(", ")})` : "";
      lines.push(`│ /${cmd.name}${aliases}`);
      lines.push(`│   ${cmd.description}`);
    }
    
    // Calculate max width for dynamic border
    const maxContentWidth = lines.length > 0 ? Math.max(...lines.map(line => line.length)) : 30;
    const borderInnerWidth = maxContentWidth - 2;
    const topBorder = `╭─ Available Commands ${"─".repeat(borderInnerWidth - 20)}`;
    const bottomBorder = `╰${"─".repeat(borderInnerWidth + 1)}`;
    
    const output = [
      topBorder,
      ...lines,
      bottomBorder,
    ].join("\n");
    
    return {
      handled: true,
      output,
    };
  },
});

// /mcp — Workspace .viber/config.json MCP servers (probe stdio + tools/list)
registerCommand({
  name: "mcp",
  description: "Show MCP servers from .viber/config.json and probe connectivity",
  handler: async (_args, context) => {
    const cwd = context?.cwd ?? process.cwd();
    const probe = await probeMcpServers(cwd);
    const lines: string[] = [];
    const labelWidth = 12;
    const fmt = (label: string, value: string) => `│ ${label.padEnd(labelWidth)} ${value}`;

    lines.push(fmt("Config file:", probe.configPath));

    if (probe.configStatus === "missing") {
      lines.push(fmt("Status:", "file not found"));
      lines.push("│");
      lines.push("│ Create .viber/config.json (next to .viber/logs). Supported shapes:");
      lines.push('│   { "mcpServers": { "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] } } }');
      lines.push('│   or { "mcp": { "servers": { ...same entries... } } }');
    } else if (probe.configStatus === "invalid") {
      lines.push(fmt("Status:", "invalid JSON"));
      if (probe.configError) {
        lines.push(fmt("Error:", probe.configError));
      }
    } else if (probe.configStatus === "empty") {
      lines.push(fmt("Status:", "no mcpServers / mcp.servers"));
      lines.push("│");
      lines.push("│ Add a root \"mcpServers\" object or \"mcp.servers\" with one entry per MCP server.");
    } else {
      lines.push(fmt("Status:", "ok"));
    }

    const maxShow = 28;
    for (const s of probe.servers) {
      lines.push("│");
      lines.push(fmt(`[${s.id}]`, s.ok ? "connected" : "failed"));
      lines.push(fmt("Command:", s.commandLine));
      if (s.ok) {
        const n = s.toolCount ?? 0;
        lines.push(fmt("Tools:", String(n)));
        const names = s.toolNames ?? [];
        if (names.length > 0) {
          const slice = names.slice(0, maxShow);
          const suffix =
            names.length > maxShow ? ` … (+${names.length - maxShow} more)` : "";
          lines.push(fmt("Names:", slice.join(", ") + suffix));
        }
      } else if (s.error) {
        lines.push(fmt("Error:", s.error));
      }
    }

    const maxContentWidth = lines.length > 0 ? Math.max(...lines.map((l) => l.length), 24) : 24;
    const borderInnerWidth = maxContentWidth - 2;
    const topBorder = `╭─ MCP ${"─".repeat(Math.max(0, borderInnerWidth - 4))}`;
    const bottomBorder = `╰${"─".repeat(borderInnerWidth + 1)}`;
    const output = [topBorder, ...lines, bottomBorder].join("\n");
    return { handled: true, output };
  },
});

// /summary — LLM summary of current conversation (see SUMMARY_PROMPT in prompts.ts)
registerCommand({
  name: "summary",
  description:
    "Replace model context with a summary of the chat (optional: /summary <extra instructions>)",
  aliases: ["sum"],
  handler: (_args, context) => {
    const messages = context?.messages ?? [];
    if (messages.length === 0) {
      return {
        handled: true,
        output:
          "当前没有可摘要的对话。先发送几条消息，或使用 /session 恢复会话后再试。",
      };
    }
    const hint = _args.trim() || undefined;
    return {
      handled: true,
      runSummary: hint ? { hint } : {},
    };
  },
});

// /rewind — drop last n user turns from model context (does not undo disk changes)
registerCommand({
  name: "rewind",
  description:
    "Pick a user message to rewind to (TUI), or /rewind n to drop last n user turns. Does not revert files on disk.",
  aliases: ["rw"],
  handler: (_args, context) => {
    const messages = context?.messages ?? [];
    const raw = _args.trim();
    if (raw === "") {
      const userIdx = findUserMessageIndices(messages);
      if (userIdx.length === 0) {
        return {
          handled: true,
          output: "当前没有可回退的用户消息。",
        };
      }
      return {
        handled: true,
        openSubScreen: {
          id: SUB_SCREEN_REWIND,
          context: { messages },
        } satisfies OpenSubScreenRequest,
      };
    }
    let n = 1;
    if (!/^\d+$/.test(raw)) {
      return {
        handled: true,
        output:
          "用法: /rewind — 打开列表选择回退位置；或 /rewind <n> — 回退最近 n 轮用户消息（n 为正整数）。",
      };
    }
    n = Number.parseInt(raw, 10);
    if (n < 1) {
      return {
        handled: true,
        output:
          "用法: /rewind — 打开列表选择回退位置；或 /rewind <n> — 回退最近 n 轮用户消息（n 为正整数）。",
      };
    }
    const newMessages = sliceToBeforeNthUserTurnFromEnd(messages, n);
    const built = buildRewindResult(messages, newMessages, n, context);
    if (!built) {
      return {
        handled: true,
        output: "当前没有可回退的用户消息。",
      };
    }
    return {
      handled: true,
      ...built,
    };
  },
});

// /clear - Clear conversation history (already exists in UI, but register for consistency)
registerCommand({
  name: "clear",
  description: "Clear conversation history",
  handler: () => {
    return {
      handled: true,
      output: "Conversation history cleared.",
      clearHistory: true,
    };
  },
});

// /quit - Exit the application
registerCommand({
  name: "quit",
  description: "Exit the application",
  aliases: ["exit", "q"],
  handler: () => {
    return {
      handled: true,
      output: "Goodbye!",
      exit: true,
    };
  },
});

// /context — API usage only (persisted last completion); no local token estimates
registerCommand({
  name: "context",
  description: "Show last API token usage and transcript size (no estimates)",
  aliases: ["ctx", "tokens"],
  handler: (_args, context) => {
    const messages = context?.messages || [];
    const apiUsage = context?.lastLlmUsage;
    const messageCount = messages.length;
    const toolCallCount = countToolCallsInMessages(messages);
    const maxContext = 128000;

    const sections: string[] = [];
    if (apiUsage) {
      sections.push(formatApiUsageSection(apiUsage, maxContext));
      sections.push("");
    } else {
      sections.push(
        "尚无最近一次 API 返回的用量。成功完成一轮模型调用并保存会话后会显示（输入/输出 tokens 以服务商返回为准）。"
      );
      sections.push("");
    }
    sections.push(formatTranscriptMetrics(messageCount, toolCallCount));

    return {
      handled: true,
      output: sections.join("\n"),
    };
  },
});

// /model - List and select available models
registerCommand({
  name: "model",
  description: "List available models or select a model to use",
  handler: async (args) => {
    const config = loadConfig();
    const currentModel = config.MODEL || process.env.OPENAI_MODEL || "not set";
    
    // If a model name is provided, select it
    if (args.trim()) {
      const selectedModel = args.trim();
      
      // Save the selected model to config
      const newConfig = { ...config, MODEL: selectedModel };
      saveConfig(newConfig);
      
      return {
        handled: true,
        output: `Model selected: ${selectedModel}\nCurrent model is now: ${selectedModel}`,
      };
    }
    
    // No model name provided - fetch and list available models
    try {
      const output = `Fetching available models...\nCurrent model: ${currentModel}`;
      
      // Note: We need to fetch models asynchronously, but command handlers are synchronous
      // We'll return a message indicating the user should check the output
      const models = await fetchModels();
      
      const lines: string[] = [];
      lines.push(`╭─ Available Models ${"─".repeat(50)}`);
      lines.push(`│ Current model: ${currentModel}`);
      lines.push(`│`);
      lines.push(`│ Usage: /model <model_name> to select a model`);
      lines.push(`│`);
      
      // Show first 50 models to avoid overwhelming output
      const displayModels = models.slice(0, 50);
      for (const model of displayModels) {
        const isCurrent = model === currentModel ? " (current)" : "";
        lines.push(`│   • ${model}${isCurrent}`);
      }
      
      if (models.length > 50) {
        lines.push(`│   ... and ${models.length - 50} more models`);
      }
      
      lines.push(`╰${"─".repeat(68)}`);
      
      return {
        handled: true,
        output: lines.join("\n"),
      };
    } catch (err) {
      return {
        handled: true,
        output: `Error fetching models: ${err instanceof Error ? err.message : String(err)}\n\nYou can still set a model directly with: /model <model_name>`,
      };
    }
  },
});

// /session — interactive TUI opens the session manager; subcommands removed
registerCommand({
  name: "session",
  description: "Open session manager (list, resume, rename, delete, export)",
  aliases: ["sessions", "history"],
  handler: (_args, context) => ({
    handled: true,
    openSubScreen: {
      id: SUB_SCREEN_SESSION,
      context: {
        activeSessionId: context?.sessionId ?? "",
        activeSessionName: context?.sessionName,
        cwd: context?.cwd ?? process.cwd(),
      },
    } satisfies OpenSubScreenRequest,
  }),
});

// /config — tool call mode (standard vs PTC)
registerCommand({
  name: "config",
  description: "Open settings (tool call mode: standard vs PTC)",
  aliases: ["settings"],
  handler: () => ({
    handled: true,
    openSubScreen: {
      id: SUB_SCREEN_CONFIG,
      context: {},
    } satisfies OpenSubScreenRequest,
  }),
});

// /export - Export a session to file
registerCommand({
  name: "export",
  description: "Export a session to Markdown or JSON file",
  handler: (args, context) => {
    const parts = args.trim().split(/\s+/);
    const sessionId = parts[0];
    const outputPath = parts[1];
    
    if (!sessionId) {
      return {
        handled: true,
        output: "Usage: /export <session-id> [output-path.md]\nUse /session to open the session manager and copy an id.",
      };
    }
    
    const sessionCwd = context?.cwd ?? process.cwd();
    const session = loadSession(sessionId, sessionCwd);
    if (!session) {
      return {
        handled: true,
        output: `Session not found: ${sessionId}`,
      };
    }
    
    const { writeFileSync } = require("node:fs");
    const { join } = require("node:path");
    
    const format = outputPath?.endsWith(".json") ? "json" : "md";
    const defaultPath = join(process.cwd(), `${sessionId}.${format}`);
    const finalPath = outputPath || defaultPath;
    
    try {
      if (format === "json") {
        writeFileSync(finalPath, JSON.stringify(session, null, 2), "utf-8");
      } else {
        const markdown = exportSessionToMarkdown(session);
        writeFileSync(finalPath, markdown, "utf-8");
      }
      
      return {
        handled: true,
        output: `Session exported to: ${finalPath}`,
      };
    } catch (err) {
      return {
        handled: true,
        output: `Failed to export session: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});
