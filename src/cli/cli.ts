#!/usr/bin/env node
/**
 * CLI: interactive chat (Ink TUI).
 * Usage:
 *   viber
 *   viber -r <session-id>
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
import { loadSession, type LlmUsageEvent } from "../session-store.js";
import { formatLlmApiError } from "../format-llm-error.js";
import { createMcpSession, emptyMcpSession } from "../mcp/session.js";
import { runConversationSummary } from "../conversation-summary.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

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

async function runInteractive(resumeSessionId?: string) {
  const config = loadConfig();
  if (!hasResolvedApiKey(config)) {
    exitWithSetupGuide();
  }

  // Start a new conversation context only after API key is available
  const ctx = startNewConversation();
  const sessionId = resumeSessionId || `${ctx.timestamp}-${ctx.uuid}`;

  console.log(`📝 LLM audit (readable): ${ctx.logPath}`);
  console.log(`📝 LLM NDJSON (jq):     ${ctx.jsonlPath}`);
  console.log(`🆔 Conversation ID: ${sessionId}`);

  const cwdEarly = process.cwd();
  if (resumeSessionId) {
    const session = loadSession(resumeSessionId, cwdEarly);
    if (session) {
      console.log(`📖 Resumed session: ${sessionId} (${session.messages.length} messages, ${session.stepCount} steps)`);
    } else {
      console.warn(`⚠️  Session not found: ${resumeSessionId}, starting fresh`);
    }
  }
  console.log();

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
        console.warn(`[viber] MCP server "${serverId}" failed: ${err.message}`);
      },
      ctx.logDir
    );
  } catch (e) {
    console.warn(
      `[viber] MCP config error: ${e instanceof Error ? e.message : String(e)}`
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
    console.log("🔍 TUI stdout debug logging → " + debugLog.logPath() + "\n");
  }

  // Load previous messages if resuming
  let initialMessages: Message[] = [];
  let initialSessionName: string | undefined;
  let initialLlmUsageHistory: LlmUsageEvent[] | undefined;
  if (resumeSessionId) {
    const session = loadSession(resumeSessionId, cwd);
    if (session) {
      initialMessages = session.messages;
      initialSessionName = session.name;
      initialLlmUsageHistory = session.llmUsageHistory;
    }
  }

  try {
    setInkUiLoggingMode(true);
    const app = render(
      React.createElement(App, {
        runAgent,
        summarizeThread,
        sessionId,
        initialMessages,
        initialSessionName,
        initialLlmUsageHistory,
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
  .option("-r, --resume <session-id>", "resume a previous session")
  .option("--boarding", "interactive setup: BASE_URL, API_KEY, BASE_MODEL → config file")
  .action(async (opts: { resume?: string; boarding?: boolean }) => {
    if (opts.boarding) {
      const ok = await runBoardingWizard();
      process.exit(ok ? 0 : 1);
    }
    await runInteractive(opts.resume);
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
