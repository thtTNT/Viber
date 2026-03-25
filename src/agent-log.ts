/**
 * Agent logging: upstream LLM monitoring vs stderr diagnostics.
 *
 * Under `.viber/logs/{conversationId}/`:
 * - `upstream.jsonl` — one JSON object per line (NDJSON), for `jq` / log pipelines.
 * - `upstream.log` — same records pretty-printed with separators, for human audit in editor.
 * - `misc.log` — MCP stdio server stderr (e.g. Python server logs), when MCP is enabled.
 *
 * Run lifecycle, tool I/O, and generic `log`/`error` go to **stderr** only (pino), not these files.
 *
 * In Ink interactive UI, stderr mixes with the TUI on many terminals; call `setInkUiLoggingMode(true)`
 * before rendering so pino defaults to `error` only (override with `VIBER_LOG_LEVEL`).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import pino from "pino";

const LOGS_DIR = ".viber/logs";

export interface ConversationContext {
  uuid: string;
  timestamp: string;
  logDir: string;
  /** Pretty multi-line JSON + separators (open this for auditing). */
  logPath: string;
  /** Single-line JSON per LLM call (for jq, Loki, etc.). */
  jsonlPath: string;
}

function generateConversationId(): ConversationContext {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19).replace("T", "-");
  const uuid = randomUUID().slice(0, 8);
  const logDir = path.join(process.cwd(), LOGS_DIR, `${timestamp}-${uuid}`);
  const logPath = path.join(logDir, "upstream.log");
  const jsonlPath = path.join(logDir, "upstream.jsonl");
  return { uuid, timestamp, logDir, logPath, jsonlPath };
}

function ensureLogDir(logDir: string): void {
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
}

let currentContext: ConversationContext | null = null;
let upstreamJsonlStream: fs.WriteStream | null = null;
let upstreamAuditStream: fs.WriteStream | null = null;
let stderrLogger: pino.Logger | null = null;
let inkUiLoggingMode = false;

const PINO_LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

/**
 * When true, pino on stderr defaults to `error` so tool/LLM info lines do not paint over the Ink UI.
 * Set before the first `getStderrLogger()` call in the process (e.g. at start of `runInteractive`).
 */
export function setInkUiLoggingMode(enabled: boolean): void {
  inkUiLoggingMode = enabled;
  stderrLogger = null;
}

function resolveStderrLevel(): string {
  const fromEnv = process.env.VIBER_LOG_LEVEL?.toLowerCase();
  if (fromEnv && PINO_LEVELS.has(fromEnv)) return fromEnv;
  return inkUiLoggingMode ? "error" : "debug";
}

function getStderrLogger(): pino.Logger {
  if (!stderrLogger) {
    stderrLogger = pino(
      {
        level: resolveStderrLevel(),
        base: undefined,
        formatters: {
          level: (label) => ({ level: label }),
        },
      },
      process.stderr
    );
  }
  return stderrLogger;
}

function openUpstreamStream(ctx: ConversationContext): void {
  if (upstreamJsonlStream) {
    try {
      upstreamJsonlStream.end();
    } catch {
      /* ignore */
    }
    upstreamJsonlStream = null;
  }
  if (upstreamAuditStream) {
    try {
      upstreamAuditStream.end();
    } catch {
      /* ignore */
    }
    upstreamAuditStream = null;
  }
  ensureLogDir(ctx.logDir);
  upstreamJsonlStream = fs.createWriteStream(ctx.jsonlPath, { flags: "a" });
  upstreamAuditStream = fs.createWriteStream(ctx.logPath, { flags: "a" });
  const id = `${ctx.timestamp}-${ctx.uuid}`;
  upstreamAuditStream.write(
    `---\nViber upstream LLM audit | conversation ${id}\n---\n`
  );
}

function writeUpstreamRecord(obj: Record<string, unknown>): void {
  if (!upstreamJsonlStream && currentContext) {
    openUpstreamStream(currentContext);
  }
  if (!upstreamJsonlStream || !upstreamAuditStream) return;

  const line = `${JSON.stringify(obj)}\n`;
  upstreamJsonlStream.write(line);

  const step = obj.step;
  const time = obj.time;
  const model = obj.model;
  const banner = `\n${"=".repeat(72)}\nLLM call  step=${String(step)}  time=${String(time)}  model=${String(model)}\n${"=".repeat(72)}\n`;
  upstreamAuditStream.write(`${banner}${JSON.stringify(obj, null, 2)}\n`);
}

export function getConversationContext(): ConversationContext {
  if (!currentContext) {
    currentContext = generateConversationId();
    openUpstreamStream(currentContext);
  }
  return currentContext;
}

export function startNewConversation(): ConversationContext {
  currentContext = generateConversationId();
  openUpstreamStream(currentContext);
  return currentContext;
}

export enum LogLevel {
  DEBUG = "DEBUG",
  INFO = "INFO",
  WARN = "WARN",
  ERROR = "ERROR",
}

const levelToPino: Record<LogLevel, "debug" | "info" | "warn" | "error"> = {
  [LogLevel.DEBUG]: "debug",
  [LogLevel.INFO]: "info",
  [LogLevel.WARN]: "warn",
  [LogLevel.ERROR]: "error",
};

export function log(level: LogLevel, message: string, data?: unknown): void {
  const logger = getStderrLogger();
  const pinoLevel = levelToPino[level];
  if (data !== undefined) {
    logger[pinoLevel]({ data }, "%s", message);
  } else {
    logger[pinoLevel]("%s", message);
  }
}

export function debug(message: string, data?: unknown): void {
  log(LogLevel.DEBUG, message, data);
}

export function info(message: string, data?: unknown): void {
  log(LogLevel.INFO, message, data);
}

export function warn(message: string, data?: unknown): void {
  log(LogLevel.WARN, message, data);
}

export function error(message: string, data?: unknown): void {
  log(LogLevel.ERROR, message, data);
}

/** Shape of `chatWithTools` completion (minimal fields for upstream log). */
export type UpstreamLlmCallResult = {
  message: {
    content?: string | null;
    toolCalls?: unknown[];
    reasoningContent?: string | null;
  };
  finishReason?: string | null;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  latencyMs?: number;
  firstTokenTimeMs?: number;
};

export const agentLogger = {
  runStart(task: string, options?: unknown, messages?: unknown[]): void {
    getConversationContext();
    const ctx = currentContext!;
    const contextData: Record<string, unknown> = {
      conversationId: `${ctx.timestamp}-${ctx.uuid}`,
      startTime: new Date().toISOString(),
    };
    if (options && typeof options === "object") {
      Object.assign(contextData, options);
    }
    if (messages && Array.isArray(messages)) {
      contextData.initialMessages = messages;
    }
    getStderrLogger().info({ data: contextData }, `Agent run started: "${task}"`);
  },

  runEnd(result: { steps?: number; finished?: boolean; message?: string }): void {
    const msg = result.message ?? "";
    getStderrLogger().info(
      {
        data: {
          steps: result.steps,
          finished: result.finished,
          messageLength: msg.length,
          messagePreview: msg.length ? msg.substring(0, 100) : "(empty)",
        },
      },
      "Agent run completed"
    );
  },

  runAborted(): void {
    getStderrLogger().info("Agent run aborted by user");
  },

  /**
   * One LLM invocation → one line in `upstream.jsonl` and one pretty block in `upstream.log`.
   */
  llmCall(params: {
    step: number;
    model?: string;
    messages: unknown[];
    tools?: unknown[];
    result: UpstreamLlmCallResult;
    accumulatedThinking: string;
  }): void {
    const ctx = getConversationContext();
    const conversationId = `${ctx.timestamp}-${ctx.uuid}`;
    const msgs = params.messages as { role: string; content?: string }[];
    const lastUserMsg = msgs.filter((m) => m.role === "user").pop();
    const lastAssistantMsg = msgs.filter((m) => m.role === "assistant").pop();
    const systemMsg = msgs.find((m) => m.role === "system");
    const { result, accumulatedThinking } = params;
    const toolCalls = result.message.toolCalls as { name?: string; arguments?: string }[] | undefined;
    const thinking = accumulatedThinking || result.message.reasoningContent || null;

    writeUpstreamRecord({
      type: "llm_call",
      time: new Date().toISOString(),
      conversationId,
      step: params.step,
      model: params.model ?? null,
      request: {
        messageCount: msgs.length,
        lastUserMessage: lastUserMsg?.content?.substring(0, 500) ?? null,
        lastAssistantMessage: lastAssistantMsg?.content?.substring(0, 500) ?? null,
        systemMessage: systemMsg?.content?.substring(0, 500) ?? null,
        toolCount: params.tools?.length ?? 0,
        toolsPreview: params.tools ? JSON.stringify(params.tools).substring(0, 1000) : null,
      },
      response: {
        thinking,
        thinkingLength: thinking?.length ?? 0,
        response: result.message.content ?? null,
        responseLength: result.message.content?.length ?? 0,
        toolCalls: toolCalls?.map((tc) => ({ name: tc.name, arguments: tc.arguments })) ?? [],
        toolCallCount: toolCalls?.length ?? 0,
        finishReason: result.finishReason ?? null,
        usage: result.usage ?? null,
        latencyMs: result.latencyMs ?? null,
        firstTokenTimeMs: result.firstTokenTimeMs ?? null,
      },
    });
  },

  toolCall(name: string, args: string, callId?: string): void {
    getStderrLogger().info(
      {
        data: {
          args,
          callId,
          timestamp: new Date().toISOString(),
        },
      },
      `Tool call: ${name}`
    );
  },

  toolResult(name: string, result: string, isError?: boolean, callId?: string, durationMs?: number): void {
    const status = isError ? "ERROR" : "OK";
    getStderrLogger().info(
      {
        data: {
          callId,
          durationMs,
          resultLength: result.length,
          result: result.substring(0, 2000),
          timestamp: new Date().toISOString(),
        },
      },
      `Tool result: ${name} (${status})`
    );
  },
};

export const uiLogger = {
  contentBlockAdded(_type: string, _content: string, _data?: unknown): void {},

  contentBlocksRendered(_count: number, _lines: number): void {},
};

export function logPath(): string {
  return getConversationContext().logPath;
}

/** NDJSON path (same session as `logPath()`). */
export function upstreamJsonlPath(): string {
  return getConversationContext().jsonlPath;
}

export function getConversationId(): string {
  const ctx = getConversationContext();
  return `${ctx.timestamp}-${ctx.uuid}`;
}
