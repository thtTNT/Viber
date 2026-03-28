#!/usr/bin/env node
/**
 * CLI: interactive chat (Ink TUI).
 * Usage:
 *   viber
 *   viber -r [session-id]   # omit id → latest session in cwd
 *   viber --boarding
 * Ctrl+T: toggle thinking process.
 */

import { createRequire } from "node:module";
import React from "react";
import { program } from "commander";
import { createAgent } from "../agent.js";
import { createOpenAIClient } from "../llm/index.js";
import { loadConfig, getConfigPath, type ToolCallMode } from "../config.js";
import { runBoardingWizard } from "./boarding-wizard.js";
import type { RunOptions } from "../agent.js";
import type { Message } from "../types.js";
import { render } from "ink";
import { App } from "./ink-app.js";
import * as debugLog from "./debug-log.js";
import { CLI_BYE_MESSAGE } from "../constants.js";
import { startNewConversation, setInkUiLoggingMode } from "../agent-log.js";
import {
  loadSession,
  formatSessionResumeBanner,
  ensureEmptySessionFile,
  getLatestSession,
  type LlmUsageEvent,
  type TurnCheckpoint,
} from "../session-store.js";
import { formatLlmApiError } from "../format-llm-error.js";
import { createMcpSession, emptyMcpSession } from "../mcp/session.js";
import { runConversationSummary } from "../conversation-summary.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

/** One startup banner line (TTY is cleared before Ink draws the main UI). */
function writeStartupLine(line: string): void {
  console.log(line);
}

/** Clear viewport and scrollback so boot logs disappear before the TUI. */
function clearTerminalForInk(): void {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[3J\x1b[2J\x1b[H");
  }
}

function hasResolvedApiKey(config: ReturnType<typeof loadConfig>): boolean {
  return Boolean(config.API_KEY || process.env.OPENAI_API_KEY);
}

/** Print setup hints and exit before any conversation / audit log is created. */
function exitWithSetupGuide(): never {
  const configPath = getConfigPath();
  console.log("\n🎉 Welcome to Viber! Let's get you set up.\n");
  console.log("📋 Configuration:\n");
  console.log("   • Environment: OPENAI_API_KEY (and optionally OPENAI_BASE_URL, OPENAI_MODEL)");
  console.log("   • CLI wizard:  viber --boarding");
  console.log("   • Config file: see path below\n");
  console.log("🔗 Get API Key from:\n");
  console.log("   • OpenAI:        https://platform.openai.com/api-keys");
  console.log("   • SiliconFlow:   https://cloud.siliconflow.cn/account/ak");
  console.log("   • Other OpenAI-compatible providers\n");
  console.log("📁 Config file location: " + configPath + "\n");
  console.log("Complete setup first, then run viber again.\n");
  process.exit(1);
}

/** Resolve `--resume` / `-r`: explicit id, or latest session in workspace when flag has no value. */
function resolveResumeSessionId(
  resume: string | boolean | undefined,
  cwd: string
): string | undefined {
  if (resume === undefined) return undefined;
  const trimmed = typeof resume === "string" ? resume.trim() : "";
  if (resume === true || trimmed === "") {
    const latest = getLatestSession(cwd);
    if (!latest) {
      console.error(
        "[viber] 当前目录下没有已保存的会话。直接运行 `viber` 开新会话，或使用 `viber --resume <session-id>`。"
      );
      process.exit(1);
    }
    return latest.id;
  }
  return trimmed;
}

async function runInteractive(resumeSessionId?: string) {
  const config = loadConfig();
  if (!hasResolvedApiKey(config)) {
    exitWithSetupGuide();
  }

  // Start a new conversation context only after API key is available
  const ctx = startNewConversation();
  const sessionId = resumeSessionId || `${ctx.timestamp}-${ctx.uuid}`;

  writeStartupLine(`[viber] llm audit (readable): ${ctx.logPath}`);
  writeStartupLine(`[viber] llm audit (ndjson): ${ctx.jsonlPath}`);
  writeStartupLine(`[viber] conversation id: ${sessionId}`);

  const cwdEarly = process.cwd();
  if (resumeSessionId) {
    const session = loadSession(resumeSessionId, cwdEarly);
    if (session) {
      writeStartupLine(
        `[viber] session: resumed ${sessionId} (${session.messages.length} messages, ${session.stepCount} steps)`
      );
    } else {
      writeStartupLine(
        `[viber] session: not found (${resumeSessionId}), empty transcript for this id`
      );
    }
  }

  const llm = createOpenAIClient({
    apiKey: config.API_KEY,
    baseURL: config.BASE_URL,
  });

  const cwd = cwdEarly;
  let mcp = emptyMcpSession();
  try {
    mcp = await createMcpSession(
      cwd,
      (serverId, err) => {
        writeStartupLine(
          `[viber] mcp: server "${serverId}" failed: ${err.message}`
        );
      },
      ctx.logDir,
      writeStartupLine
    );
  } catch (e) {
    writeStartupLine(
      `[viber] mcp: config invalid — ${e instanceof Error ? e.message : String(e)}`
    );
  }

  const agent = createAgent({
    llm,
    config: {
      cwd,
      maxSteps: 15,
      model: config.MODEL,
    },
    extraTools: mcp.extraTools,
  });

  const runAgent = (input: string, options?: RunOptions) => {
    const cfg = loadConfig();
    const toolCallMode: ToolCallMode = options?.toolCallMode ?? cfg.TOOL_CALL_MODE ?? "standard";
    return agent.run(input, {
      ...options,
      model: cfg.MODEL ?? options?.model,
      toolCallMode,
    });
  };

  const summarizeThread = (
    messages: Message[],
    options: { hint?: string; signal?: AbortSignal }
  ) =>
    runConversationSummary({
      llm,
      model: loadConfig().MODEL,
      messages,
      hint: options.hint,
      signal: options.signal,
    });

  if (debugLog.enabled()) {
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = debugLog.wrapStdout(origWrite);
    writeStartupLine(`[viber] debug: TUI stdout trace → ${debugLog.logPath()}`);
  }

  // Load previous messages if resuming
  let initialMessages: Message[] = [];
  let initialSessionName: string | undefined;
  let initialLlmUsageHistory: LlmUsageEvent[] | undefined;
  let initialResumeBanner: string | undefined;
  let initialSessionCreatedAt: string | undefined;
  let initialSessionSteps: number | undefined;
  let initialTurnCheckpoints: TurnCheckpoint[] | undefined;
  if (resumeSessionId) {
    const session = loadSession(resumeSessionId, cwd);
    if (session) {
      initialMessages = session.messages;
      initialSessionName = session.name;
      initialLlmUsageHistory = session.llmUsageHistory;
      initialResumeBanner = formatSessionResumeBanner(session);
      initialSessionCreatedAt = session.createdAt;
      initialSessionSteps = session.stepCount;
      initialTurnCheckpoints = session.turnCheckpoints;
    }
  }

  const modelForSession =
    config.MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini";
  if (!loadSession(sessionId, cwd)) {
    const createdAt = new Date().toISOString();
    ensureEmptySessionFile(sessionId, cwd, {
      model: modelForSession,
      createdAt,
    });
    if (initialSessionCreatedAt === undefined) {
      initialSessionCreatedAt = createdAt;
    }
  }

  try {
    clearTerminalForInk();
    setInkUiLoggingMode(true);
    const app = render(
      React.createElement(App, {
        runAgent,
        summarizeThread,
        sessionId,
        initialMessages,
        initialSessionName,
        initialLlmUsageHistory,
        initialResumeBanner,
        initialSessionCreatedAt,
        initialSessionSteps,
        initialTurnCheckpoints,
      })
    );
    await app.waitUntilExit();
  } finally {
    await mcp.close();
    console.log(CLI_BYE_MESSAGE);
  }
}

program
  .name("viber")
  .description("A minimal Node.js coding agent framework (interactive TUI)")
  .version(pkg.version)
  .option(
    "-r, --resume [session-id]",
    "resume a session (omit id to use the latest updated session in this directory)"
  )
  .option("--boarding", "interactive setup: BASE_URL, API_KEY, BASE_MODEL → config file")
  .action(async (opts: { resume?: string | boolean; boarding?: boolean }) => {
    if (opts.boarding) {
      const ok = await runBoardingWizard();
      process.exit(ok ? 0 : 1);
    }
    const cwd = process.cwd();
    const resumeId = resolveResumeSessionId(opts.resume, cwd);
    await runInteractive(resumeId);
  });

function normalizeCliArgv(raw: string[]): string[] {
  let argv = raw;
  // `tsx src/cli/cli.ts …` or `tsx src/cli.ts …` leaves the script path in argv; strip it
  if (
    argv[0]?.match(/(^|[/\\])cli[\\/]cli\.(js|ts)$/) ||
    argv[0]?.match(/(^|[/\\])cli\.(js|ts)$/)
  ) {
    argv = argv.slice(1);
  }
  while (argv[0] === "--") {
    argv = argv.slice(1);
  }
  return argv;
}

async function main() {
  let argv = normalizeCliArgv(process.argv.slice(2));
  if (argv.includes("--help") || argv.includes("-h")) {
    program.outputHelp();
    return;
  }
  if (argv.includes("--version") || argv.includes("-V")) {
    console.log(pkg.version);
    return;
  }
  // argv is already user args (e.g. process.argv.slice(2)); without { from: 'user' },
  // Commander treats argv like node argv and does slice(2), dropping all flags.
  await program.parseAsync(argv, { from: "user" });
}

main().catch((err) => {
  console.error(formatLlmApiError(err));
  process.exit(1);
});
