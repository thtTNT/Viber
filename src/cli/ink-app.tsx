/**
 * Interactive chat UI using Ink (React for CLI).
 * Content zone + Toolbar (StatusBar + InputBox). Uses ink-text-input for input.
 */

import { createRequire } from "node:module";
import React, { useState, useCallback, useEffect, useRef } from "react";
import { Box, Text, Static, useInput, useApp } from "ink";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version?: string; description?: string };
const TOOLBAR_ROWS = 5;
import TextInput from "ink-text-input";
import type { RunResult, StepDetail, ProgressEvent, RunOptions } from "../agent.js";
import type { Message } from "../types.js";
import { uiLogger } from "../agent-log.js";
import {
  UI_LABELS,
  UI_COMMANDS,
  UI_TIPS,
  UI_SYSTEM_MESSAGES,
  UI_ERROR_PREFIX,
  UI_STATUS_VIBING,
} from "../constants.js";
import {
  isCommand,
  processCommand,
  getAvailableCommands,
  buildRewindResult,
  type CommandResult,
} from "../commands.js";
import {
  findUserMessageIndices,
  sliceToBeforeUserTurnIndex,
} from "../rewind-transcript.js";
import { renderTuiMd } from "./tui-md.js";
import {
  saveSession,
  formatSessionResumeBanner,
  appendSessionUsageEvents,
  lastUsageSnapshot,
  pushTurnCheckpoint,
  type Session,
  type LlmUsageEvent,
  type TurnCheckpoint,
} from "../session-store.js";
import { messagesToContentBlocks } from "./messages-to-content-blocks.js";
import {
  ContentBlockType,
  createContentBlock,
  addContentBlock,
  type ContentBlock,
} from "./content-blocks-model.js";
import { renderUserBlock, stringDisplayWidth } from "./user-block-render.js";
import { SubScreenHost } from "../tui/sub-screen-host.js";
import type { OpenSubScreenRequest } from "../tui/sub-screen-types.js";
import { getConversationId } from "../agent-log.js";
import { formatLlmApiError } from "../format-llm-error.js";
import type { RunConversationSummaryResult } from "../conversation-summary.js";

// -------- UI helpers (width, box, status bar) --------
const WIDTH = Math.max(40, process.stdout.columns || 72);
const ANSI = {
  reset: "\x1b[0m",
  border: "\x1b[38;5;245m",
  dim: "\x1b[38;5;245m",
} as const;

function renderStatusBar(text: string): string {
  const visible = text.replace(/\x1b\[[0-9;]*m/g, "");
  const pad = " ".repeat(Math.max(0, WIDTH - stringDisplayWidth(visible)));
  if (!text) {
    return ANSI.dim + pad + ANSI.reset + "\n";
  }
  return ANSI.dim + text + pad + ANSI.reset + "\n";
}

// -------- Content Block Management (types + factories in content-blocks-model) --------

/** Last block that is not a trailing tool line (assistant text is often followed by tool rows). */
function lastBlockIgnoringTrailingToolCalls(blocks: ContentBlock[]): ContentBlock | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b && b.type !== ContentBlockType.TOOL_CALL) {
      return b;
    }
  }
  return undefined;
}

function renderContentBlocks(blocks: ContentBlock[]): string[] {
  const lines: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    // Blank line between blocks (use " " so Ink reliably reserves a row)
    if (i > 0) {
      lines.push(" ");
    }

    switch (block.type) {
      case ContentBlockType.USER_INPUT:
        lines.push(...block.content.split(/\r?\n/).filter(Boolean));
        break;
        
      case ContentBlockType.THINKING:
        // 与 ASSISTANT 相同走 TUI-MD（表格、代码等常出现在推理流里）
        lines.push(...renderThinkingContentLines(block.content));
        break;
        
      case ContentBlockType.RESPONSE:
        // 与 ASSISTANT 相同走 TUI-MD
        const responseBullet = `${WHITE}●${C} `;
        const responseParsed = renderTuiMd(block.content);
        const responseLines = responseParsed.split(/\r?\n/);
        responseLines.forEach((line, idx) => {
          if (line.trim() === "" && idx > 0) {
            lines.push("  ");
          } else if (idx === 0) {
            lines.push(responseBullet + line);
          } else {
            lines.push("  " + line);
          }
        });
        break;
        
      case ContentBlockType.TOOL_CALL:
        const argsPreview = block.data?.args && block.data.args.length > 60 ? block.data.args.slice(0, 60) + "…" : block.data?.args || "";
        lines.push(`${YELLOW}●${C} ${B}${block.data?.name || ""}${C}(${DIM}${argsPreview}${C})`);
        break;
        
      case ContentBlockType.ASSISTANT:
        const assistantBullet = `${WHITE}●${C} `;
        const parsedContent = renderTuiMd(block.content);
        const assistantLines = parsedContent.split(/\r?\n/);
        assistantLines.forEach((line, idx) => {
          if (line.trim() === "" && idx > 0) {
            // Empty line after first line - show as indented empty line
            lines.push("  ");
          } else if (idx === 0) {
            lines.push(assistantBullet + line);
          } else {
            lines.push("  " + line);
          }
        });
        // If all lines were empty, show a placeholder
        if (assistantLines.length > 0 && assistantLines.every(line => !line.trim())) {
          lines.push(assistantBullet + " " + UI_SYSTEM_MESSAGES.EMPTY_RESPONSE);
        }
        break;
        
      case ContentBlockType.ERROR:
        lines.push(`${RED}${UI_ERROR_PREFIX}${C} ${block.content}`);
        break;
        
      case ContentBlockType.SYSTEM_INFO:
        const systemLines = block.content.split(/\r?\n/);
        systemLines.filter(Boolean).forEach(line => {
          lines.push(line);
        });
        break;
    }
  }
  return lines;
}

// -------- Constants --------
const C = "\x1b[0m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const WHITE = "\x1b[37m";
const YELLOW = "\x1b[33m";
const B = "\x1b[1m";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** 单行推理块渲染（与 content 区一致），供 Static 拆分与流式区复用 */
function renderThinkingContentLines(content: string): string[] {
  const lines: string[] = [];
  const thinkingBullet = `${CYAN}${DIM}●${C} `;
  const thinkingParsed = renderTuiMd(content);
  const thinkingLines = thinkingParsed.split(/\r?\n/);
  thinkingLines.forEach((line, idx) => {
    if (line.trim() === "" && idx > 0) {
      lines.push("  ");
    } else if (idx === 0) {
      lines.push(thinkingBullet + line);
    } else {
      lines.push("  " + line);
    }
  });
  if (thinkingLines.length > 0 && thinkingLines.every((line) => !line.trim())) {
    lines.push(thinkingBullet + " " + UI_SYSTEM_MESSAGES.EMPTY_RESPONSE);
  }
  return lines;
}

// --- StatusBar: vibing until model fully returns ---
function StatusBar({ isVibing }: { isVibing: boolean }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!isVibing) return;
    const id = setInterval(() => setFrame((i) => (i + 1) % 10), 80);
    return () => clearInterval(id);
  }, [isVibing]);

  const dots = frame < 3 ? ".".repeat(frame + 1) : "";
  const text = isVibing ? `${CYAN}${SPINNER[frame % SPINNER.length]}${C} ${DIM}${UI_STATUS_VIBING}${dots}${C}` : "";
  return <Text>{renderStatusBar(text).trimEnd()}</Text>;
}

// --- InputBox: ink-text-input with autocomplete hint ---
function InputBox({
  value,
  onChange,
  onSubmit,
  focus,
  autocomplete,
  textInputKey,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  focus: boolean;
  autocomplete: string;
  onTab: () => void;
  /** Bump when recalling ↑↓ history so ink-text-input remounts with cursor at end of line. */
  textInputKey: number;
}) {
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderTop
      borderBottom
      borderLeft={false}
      borderRight={false}
      borderDimColor
    >
      <Box>
        <TextInput
          key={textInputKey}
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          focus={focus}
          showCursor
        />
        {autocomplete ? (
          <Text dimColor>{autocomplete}</Text>
        ) : null}
      </Box>
    </Box>
  );
}

// --- Toolbar: StatusBar + InputBox ---
function Toolbar({
  isVibing,
  inputBuffer,
  setInputBuffer,
  onSubmit,
  autocomplete,
  onTab,
  textInputKey,
}: {
  isVibing: boolean;
  inputBuffer: string;
  setInputBuffer: (v: string) => void;
  onSubmit: (v: string) => void;
  autocomplete: string;
  onTab: () => void;
  textInputKey: number;
}) {
  return (
    <Box flexDirection="column">
      <StatusBar isVibing={isVibing} />
      <InputBox
        value={inputBuffer}
        onChange={setInputBuffer}
        onSubmit={onSubmit}
        focus={true}
        autocomplete={autocomplete}
        onTab={onTab}
        textInputKey={textInputKey}
      />
    </Box>
  );
}

// --- App ---
export interface InkAppProps {
  runAgent: (input: string, options: RunOptions) => Promise<RunResult>;
  /** One-shot transcript summary for /summary (no tools) */
  summarizeThread: (
    messages: Message[],
    options: { hint?: string; signal?: AbortSignal }
  ) => Promise<RunConversationSummaryResult>;
  sessionId?: string;
  initialMessages?: Message[];
  /** Display name from resumed session JSON (id is unchanged) */
  initialSessionName?: string;
  /** Persisted LLM usage log from resumed session */
  initialLlmUsageHistory?: LlmUsageEvent[];
  /** When resuming from CLI, banner line(s) from `formatSessionResumeBanner(session)` */
  initialResumeBanner?: string;
  initialSessionCreatedAt?: string;
  initialSessionSteps?: number;
  initialTurnCheckpoints?: TurnCheckpoint[];
}

export function App({
  runAgent,
  summarizeThread,
  sessionId: propSessionId,
  initialMessages: propInitialMessages,
  initialSessionName,
  initialLlmUsageHistory,
  initialResumeBanner,
  initialSessionCreatedAt,
  initialSessionSteps,
  initialTurnCheckpoints,
}: InkAppProps) {
  const { exit } = useApp();
  const [contentBlocks, setContentBlocks] = useState<ContentBlock[]>(() => {
    if (propInitialMessages?.length) {
      const replay = messagesToContentBlocks(propInitialMessages);
      const banner = initialResumeBanner?.trim();
      if (banner) {
        return [
          createContentBlock(ContentBlockType.SYSTEM_INFO, banner, {
            lines: banner.split("\n").filter(Boolean),
          }),
          ...replay,
        ];
      }
      return replay;
    }
    const c = "\x1b[0m";
    const b = "\x1b[1m";
    const dim = "\x1b[2m";
    const cyan = "\x1b[36m";
    const yellow = "\x1b[33m";
    const version = pkg.version ?? "0.1.0";
    const desc = pkg.description ?? "interactive coding agent";
    const cwd = process.cwd();
    // Get model from config to match what the agent actually uses
    let model = "gpt-4o-mini";
    let apiKeySet = false;
    let baseUrlSet = false;
    try {
      const { loadConfig } = require("../config.js");
      const config = loadConfig();
      model = config.MODEL || process.env.OPENAI_MODEL || model;
      apiKeySet = !!(config.API_KEY || process.env.OPENAI_API_KEY);
      baseUrlSet = !!(config.BASE_URL || process.env.OPENAI_BASE_URL);
    } catch {
      model = process.env.OPENAI_MODEL || model;
    }
    
    const initLines: string[] = [
      "",
      `  ${cyan}${b}VIBER${c} ${dim}v${version}${c}  ${dim}— ${desc}${c}`,
      "",
      `${dim}  ${UI_LABELS.CWD}${c}  ${cwd}`,
      `${dim}  ${UI_LABELS.MODEL}${c} ${model}`,
      "",
      `${dim}  ${UI_LABELS.COMMANDS}${c} ${UI_COMMANDS}`,
      `${dim}  ${UI_LABELS.TIPS}${c} ${UI_TIPS}`,
    ];
    
    // Add setup hint if API key is not configured
    if (!apiKeySet) {
      initLines.push(
        "",
        `  ${yellow}${b}⚠️  First-time setup needed!${c}`,
        `  ${dim}Set ${cyan}OPENAI_API_KEY${dim}, run ${cyan}viber --boarding${dim}, or edit ${cyan}~/.viber/config.json${dim}.${c}`,
        ""
      );
    }
    
    // Convert initial lines to system info block
    return [createContentBlock(
      ContentBlockType.SYSTEM_INFO,
      initLines.join("\n"),
      { lines: initLines }
    )];
  });
  const [inputBuffer, setInputBuffer] = useState("");
  /** Increment on ↑↓ history recall so TextInput remounts with cursor at end of line. */
  const [textInputRemountKey, setTextInputRemountKey] = useState(0);
  const [isVibing, setVibing] = useState(false);
  const [conversationHistory, setConversationHistory] = useState<Message[]>(() => propInitialMessages || []);
  const [autocomplete, setAutocomplete] = useState("");
  /** 全屏子界面（由 `CommandResult.openSubScreen` 打开，见 `tui/sub-screen-types.ts`） */
  const [subScreen, setSubScreen] = useState<OpenSubScreenRequest | null>(null);
  /** 递增以在 /clear 等场景下重置 `<Static>`，避免缩短历史时终端残留旧行 */
  const [staticMountKey, setStaticMountKey] = useState(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  /** 已发送的输入（含普通消息与 / 指令），用于 ↑↓ 浏览 */
  const inputHistoryRef = useRef<string[]>([]);
  /** null = 正在编辑当前行；否则为 `inputHistoryRef` 中的下标 */
  const historyBrowseIdxRef = useRef<number | null>(null);
  /** 从「当前行」进入历史前暂存的草稿（↓ 回到最新时恢复） */
  const historyDraftRef = useRef<string>("");
  /** Current session ID */
  const [sessionId, setSessionId] = useState<string>(() => propSessionId || getConversationId());
  /** Optional display label (stored in session JSON; logs still use id) */
  const [sessionName, setSessionName] = useState<string | undefined>(() =>
    initialSessionName?.trim() ? initialSessionName.trim() : undefined
  );
  /** Session mode */
  const [sessionMode] = useState<"interactive" | "single">("interactive");
  /** Total steps in current session */
  const [sessionSteps, setSessionSteps] = useState(
    () => initialSessionSteps ?? 0
  );
  /** Append-only LLM usage log (persisted; supports future rollback) */
  const [llmUsageHistory, setLlmUsageHistory] = useState<LlmUsageEvent[]>(
    () => initialLlmUsageHistory ?? []
  );
  const [turnCheckpoints, setTurnCheckpoints] = useState<TurnCheckpoint[]>(
    () => initialTurnCheckpoints ?? []
  );
  /**
   * Latest session fields for unmount save — avoids stale closure from `useEffect([], ...)`
   * that would otherwise write empty or resumed-only history on exit.
   */
  const exitSaveRef = useRef<{
    conversationHistory: Message[];
    sessionId: string;
    sessionCreatedAt: string;
    sessionMode: "interactive" | "single";
    sessionSteps: number;
    sessionName?: string;
    llmUsageHistory: LlmUsageEvent[];
    turnCheckpoints: TurnCheckpoint[];
  }>({
    conversationHistory: propInitialMessages || [],
    sessionId: propSessionId || "",
    sessionCreatedAt: new Date().toISOString(),
    sessionMode: "interactive",
    sessionSteps: initialSessionSteps ?? 0,
    sessionName: undefined,
    llmUsageHistory: initialLlmUsageHistory ?? [],
    turnCheckpoints: initialTurnCheckpoints ?? [],
  });
  /** Session created timestamp (CLI `--resume` / TUI 会话管理恢复) */
  const [sessionCreatedAt, setSessionCreatedAt] = useState<string>(() => {
    if (initialSessionCreatedAt) {
      return initialSessionCreatedAt;
    }
    if (propInitialMessages && propInitialMessages.length > 0) {
      const ts = propSessionId?.split("-").slice(0, 6).join("-");
      if (ts) {
        return ts.replace(
          /(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/,
          "$1-$2-$3T$4:$5:$6Z"
        );
      }
    }
    return new Date().toISOString();
  });

  exitSaveRef.current = {
    conversationHistory,
    sessionId,
    sessionCreatedAt,
    sessionMode,
    sessionSteps,
    sessionName,
    llmUsageHistory,
    turnCheckpoints,
  };

  // Calculate autocomplete suggestion when typing "/"
  useEffect(() => {
    if (inputBuffer.startsWith("/")) {
      const input = inputBuffer.slice(1).toLowerCase();
      const commands = getAvailableCommands();
      const match = commands.find(cmd => cmd.name.toLowerCase().startsWith(input));
      if (match && match.name.toLowerCase() !== input) {
        setAutocomplete(match.name.slice(input.length));
      } else {
        setAutocomplete("");
      }
    } else {
      setAutocomplete("");
    }
  }, [inputBuffer]);

  // Handle Tab key for autocomplete
  const handleTab = useCallback(() => {
    if (autocomplete && inputBuffer.startsWith("/")) {
      setInputBuffer(inputBuffer + autocomplete);
      setAutocomplete("");
    }
  }, [autocomplete, inputBuffer]);

  const applySessionResume = useCallback((s: Session) => {
    setSessionId(s.id);
    setSessionName(s.name?.trim() ? s.name.trim() : undefined);
    setSessionSteps(s.stepCount);
    setSessionCreatedAt(s.createdAt);
    setLlmUsageHistory(s.llmUsageHistory ?? []);
    setTurnCheckpoints(s.turnCheckpoints ?? []);
    setConversationHistory(s.messages);
    setStaticMountKey((k) => k + 1);
    const banner = formatSessionResumeBanner(s);
    uiLogger.contentBlockAdded(ContentBlockType.SYSTEM_INFO, banner);
    const replay = messagesToContentBlocks(s.messages);
    setContentBlocks([
      createContentBlock(ContentBlockType.SYSTEM_INFO, banner, { lines: [banner] }),
      ...replay,
    ]);
  }, []);

  const applyRewindResult = useCallback(
    (note: string, r: NonNullable<CommandResult["rewind"]>) => {
      setConversationHistory(r.messages);
      setLlmUsageHistory(r.llmUsageHistory);
      setSessionSteps(r.stepCount);
      setTurnCheckpoints(r.turnCheckpoints);
      setStaticMountKey((k) => k + 1);
      setContentBlocks([
        createContentBlock(ContentBlockType.SYSTEM_INFO, note, {
          lines: note.split("\n").filter(Boolean),
        }),
        ...messagesToContentBlocks(r.messages),
      ]);
      uiLogger.contentBlockAdded(ContentBlockType.SYSTEM_INFO, note);
      try {
        const { loadConfig } = require("../config.js");
        const config = loadConfig();
        const label = sessionName?.trim();
        const session: Session = {
          id: sessionId,
          createdAt: sessionCreatedAt,
          updatedAt: new Date().toISOString(),
          mode: sessionMode,
          model: config.MODEL || process.env.OPENAI_MODEL || "unknown",
          messages: r.messages,
          stepCount: r.stepCount,
          finished: true,
          cwd: process.cwd(),
          ...(label ? { name: label } : {}),
          ...(r.llmUsageHistory.length > 0
            ? { llmUsageHistory: r.llmUsageHistory }
            : {}),
          ...(r.turnCheckpoints.length > 0
            ? { turnCheckpoints: r.turnCheckpoints }
            : {}),
        };
        saveSession(session);
      } catch (err) {
        console.error(
          "Failed to save session:",
          err instanceof Error ? err.message : String(err)
        );
      }
    },
    [sessionCreatedAt, sessionId, sessionMode, sessionName]
  );

  const handleRewindPick = useCallback(
    (userTurnIndexFromStart: number) => {
      setSubScreen(null);
      const newMessages = sliceToBeforeUserTurnIndex(
        conversationHistory,
        userTurnIndexFromStart
      );
      const userIdx = findUserMessageIndices(conversationHistory);
      const n = userIdx.length - userTurnIndexFromStart;
      const built = buildRewindResult(conversationHistory, newMessages, n, {
        llmUsageHistory,
        turnCheckpoints,
      });
      if (!built?.rewind) return;
      applyRewindResult(built.output ?? "", built.rewind);
    },
    [
      applyRewindResult,
      conversationHistory,
      llmUsageHistory,
      turnCheckpoints,
    ]
  );

  const lastBlock = contentBlocks[contentBlocks.length - 1];
  const liveThinking =
    isVibing && lastBlock?.type === ContentBlockType.THINKING;
  const blocksForStatic = liveThinking ? contentBlocks.slice(0, -1) : contentBlocks;
  const staticLines = renderContentBlocks(blocksForStatic);
  const streamingLines: string[] = [];
  if (liveThinking && lastBlock) {
    if (blocksForStatic.length > 0) {
      streamingLines.push(" ", " ");
    }
    streamingLines.push(...renderThinkingContentLines(lastBlock.content));
  }

  const submit = useCallback(
    async (line: string) => {
      const input = line.trim();
      if (!input) return;

      const hist = inputHistoryRef.current;
      hist.push(input);
      if (hist.length > 1000) {
        hist.splice(0, hist.length - 500);
      }
      historyBrowseIdxRef.current = null;
      historyDraftRef.current = "";

      // Check if input is a command
      if (isCommand(input)) {
        const cmdHead = input.slice(1).trim().split(/\s+/)[0]?.toLowerCase() ?? "";
        if (
          isVibing &&
          (cmdHead === "rewind" || cmdHead === "rw")
        ) {
          uiLogger.contentBlockAdded(
            ContentBlockType.SYSTEM_INFO,
            UI_SYSTEM_MESSAGES.REWIND_WHILE_VIBING
          );
          setContentBlocks((prev) =>
            addContentBlock(
              prev,
              ContentBlockType.SYSTEM_INFO,
              UI_SYSTEM_MESSAGES.REWIND_WHILE_VIBING
            )
          );
          setInputBuffer("");
          return;
        }
        const result = await processCommand(input.slice(1), {
          messages: conversationHistory,
          cwd: process.cwd(),
          sessionId,
          sessionName,
          lastLlmUsage: lastUsageSnapshot(llmUsageHistory),
          llmUsageHistory,
          turnCheckpoints,
        });
        if (result.openSubScreen) {
          setSubScreen(result.openSubScreen);
          setInputBuffer("");
          return;
        }
        if (
          result.sessionNameUpdate &&
          result.sessionNameUpdate.forSessionId === sessionId
        ) {
          setSessionName(result.sessionNameUpdate.name);
        }
        if (result.rewind) {
          applyRewindResult(result.output ?? "", result.rewind);
          setInputBuffer("");
          return;
        }
        if (result.runSummary) {
          setInputBuffer("");
          if (abortControllerRef.current) {
            abortControllerRef.current.abort();
          }
          const abortController = new AbortController();
          abortControllerRef.current = abortController;
          setVibing(true);
          try {
            const sum = await summarizeThread(conversationHistory, {
              hint: result.runSummary.hint,
              signal: abortController.signal,
            });
            setVibing(false);
            abortControllerRef.current = null;
            const text = sum.summary.trim();
            const summaryUserBlock = renderUserBlock(input);
            if (text) {
              const nextHistory = sum.replacementMessages;
              setConversationHistory(nextHistory);
              setStaticMountKey((k) => k + 1);
              const banner = UI_SYSTEM_MESSAGES.CONTEXT_REPLACED_BY_SUMMARY;
              uiLogger.contentBlockAdded(ContentBlockType.SYSTEM_INFO, banner);
              uiLogger.contentBlockAdded(ContentBlockType.USER_INPUT, summaryUserBlock);
              uiLogger.contentBlockAdded(ContentBlockType.ASSISTANT, sum.summary, {
                length: sum.summary.length,
              });
              setContentBlocks([
                createContentBlock(ContentBlockType.SYSTEM_INFO, banner, {
                  lines: [banner],
                }),
                createContentBlock(ContentBlockType.USER_INPUT, summaryUserBlock),
                createContentBlock(ContentBlockType.ASSISTANT, sum.summary),
              ]);
            } else {
              uiLogger.contentBlockAdded(ContentBlockType.USER_INPUT, summaryUserBlock);
              uiLogger.contentBlockAdded(
                ContentBlockType.SYSTEM_INFO,
                UI_SYSTEM_MESSAGES.EMPTY_RESPONSE
              );
              setContentBlocks((prev) =>
                addContentBlock(
                  addContentBlock(prev, ContentBlockType.USER_INPUT, summaryUserBlock),
                  ContentBlockType.SYSTEM_INFO,
                  UI_SYSTEM_MESSAGES.EMPTY_RESPONSE
                )
              );
              setConversationHistory((prev) => [
                ...prev,
                { role: "user" as const, content: input },
              ]);
            }
            const nextHistoryForSave = text
              ? sum.replacementMessages
              : [...conversationHistory, { role: "user" as const, content: input }];
            setSessionSteps((prev) => prev + 1);
            const mergedSummaryHistory = appendSessionUsageEvents(
              llmUsageHistory,
              sum.llmUsageEvents
            );
            setLlmUsageHistory(mergedSummaryHistory);
            const summaryCp = text
              ? pushTurnCheckpoint(
                  [],
                  nextHistoryForSave.length,
                  sessionSteps + 1
                )
              : turnCheckpoints;
            if (text) {
              setTurnCheckpoints(summaryCp);
            }
            try {
              const { loadConfig } = require("../config.js");
              const config = loadConfig();
              const label = sessionName?.trim();
              const session: Session = {
                id: sessionId,
                createdAt: sessionCreatedAt,
                updatedAt: new Date().toISOString(),
                mode: sessionMode,
                model: config.MODEL || process.env.OPENAI_MODEL || "unknown",
                messages: nextHistoryForSave,
                stepCount: sessionSteps + 1,
                finished: true,
                cwd: process.cwd(),
                ...(label ? { name: label } : {}),
                ...(mergedSummaryHistory.length > 0
                  ? { llmUsageHistory: mergedSummaryHistory }
                  : {}),
                ...(summaryCp.length > 0 ? { turnCheckpoints: summaryCp } : {}),
              };
              saveSession(session);
            } catch (err) {
              console.error(
                "Failed to save session:",
                err instanceof Error ? err.message : String(err)
              );
            }
          } catch (err) {
            setVibing(false);
            abortControllerRef.current = null;
            const errorMsg = formatLlmApiError(err);
            const errUserBlock = renderUserBlock(input);
            uiLogger.contentBlockAdded(ContentBlockType.USER_INPUT, errUserBlock);
            uiLogger.contentBlockAdded(ContentBlockType.ERROR, errorMsg);
            setContentBlocks((prev) =>
              addContentBlock(
                addContentBlock(prev, ContentBlockType.USER_INPUT, errUserBlock),
                ContentBlockType.ERROR,
                errorMsg
              )
            );
            setConversationHistory((prev) => [
              ...prev,
              { role: "user", content: input },
            ]);
          }
          return;
        }
        const output = result.output || "";
        if (output) {
          uiLogger.contentBlockAdded(ContentBlockType.SYSTEM_INFO, output);
          setContentBlocks(prev => addContentBlock(prev, ContentBlockType.SYSTEM_INFO, output));
        }
        if (result.clearHistory) {
          setConversationHistory([]);
          setLlmUsageHistory([]);
          setTurnCheckpoints([]);
          const clearMessage = result.output || "Conversation history cleared.";
          setStaticMountKey((k) => k + 1);
          setContentBlocks([
            createContentBlock(
              ContentBlockType.SYSTEM_INFO,
              clearMessage,
              { lines: [clearMessage] }
            )
          ]);
        }
        if (result.exit) {
          exit();
        }
        setInputBuffer("");
        return;
      }

      // Add user input block
      const userBlockContent = renderUserBlock(input);
      uiLogger.contentBlockAdded(ContentBlockType.USER_INPUT, userBlockContent);
      setContentBlocks(prev => addContentBlock(prev, ContentBlockType.USER_INPUT, userBlockContent));
      setInputBuffer("");
      // Abort previous agent run if any
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      // Create new AbortController for this run
      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      setVibing(true);

      try {
        const result = await runAgent(input, {
          initialMessages: conversationHistory,
          signal: abortController.signal,
          onProgress(ev: ProgressEvent) {
            if (ev.type === "thinking" && ev.content) {
              uiLogger.contentBlockAdded(ContentBlockType.THINKING, ev.content, { length: ev.content.length });
              if (process.env.DEBUG_THINKING) {
                process.stderr.write(`[UI THINKING] Received chunk: "${ev.content.replace(/\n/g, '\\n')}"\n`);
              }
              setContentBlocks(prev => {
                // Check if the last block is a THINKING block
                const lastBlock = prev.length > 0 ? prev[prev.length - 1] : null;
                if (process.env.DEBUG_THINKING) {
                  process.stderr.write(`[UI THINKING] Last block type: ${lastBlock?.type}, prev blocks: ${prev.length}\n`);
                }
                if (lastBlock && lastBlock.type === ContentBlockType.THINKING) {
                  // Update the last THINKING block by appending the new content
                  const updatedBlock = {
                    ...lastBlock,
                    content: lastBlock.content + ev.content!,
                  };
                  if (process.env.DEBUG_THINKING) {
                    process.stderr.write(`[UI THINKING] Updated block, new length: ${updatedBlock.content.length}\n`);
                  }
                  return [...prev.slice(0, -1), updatedBlock];
                } else {
                  // Add a new THINKING block
                  if (process.env.DEBUG_THINKING) {
                    process.stderr.write(`[UI THINKING] Creating new block\n`);
                  }
                  return addContentBlock(prev, ContentBlockType.THINKING, ev.content!);
                }
              });
            }
            if (ev.type === "response") {
              setContentBlocks((prev) => {
                const last = prev[prev.length - 1];
                const step = ev.step;
                if (
                  step !== undefined &&
                  last?.type === ContentBlockType.RESPONSE &&
                  last.data?.step === step
                ) {
                  return [
                    ...prev.slice(0, -1),
                    { ...last, content: ev.content },
                  ];
                }
                uiLogger.contentBlockAdded(ContentBlockType.RESPONSE, ev.content, {
                  length: ev.content.length,
                  step,
                });
                return addContentBlock(prev, ContentBlockType.RESPONSE, ev.content, {
                  step,
                });
              });
            }
            if (ev.type === "tool_call") {
              uiLogger.contentBlockAdded(ContentBlockType.TOOL_CALL, "", { name: ev.name, args: ev.args });
              setContentBlocks(prev => addContentBlock(
                prev,
                ContentBlockType.TOOL_CALL,
                "",
                { name: ev.name, args: ev.args }
              ));
            }
          },
        });

        setVibing(false);
        abortControllerRef.current = null;
        const finalMessage = result.message.trim();
        if (finalMessage) {
          let appendedAssistant = false;
          setContentBlocks((prev) => {
            const anchor = lastBlockIgnoringTrailingToolCalls(prev);
            if (
              anchor?.type === ContentBlockType.RESPONSE &&
              anchor.content.trim() === finalMessage
            ) {
              return prev;
            }
            appendedAssistant = true;
            return addContentBlock(prev, ContentBlockType.ASSISTANT, result.message);
          });
          if (appendedAssistant) {
            uiLogger.contentBlockAdded(ContentBlockType.ASSISTANT, result.message, {
              length: result.message.length,
            });
          }
        } else {
          // Model ended without a final message (e.g. said "now I will do X" but didn't call the tool) — make it clear the run finished
          uiLogger.contentBlockAdded(ContentBlockType.SYSTEM_INFO, UI_SYSTEM_MESSAGES.RUN_FINISHED_NO_MESSAGE);
          setContentBlocks(prev => addContentBlock(prev, ContentBlockType.SYSTEM_INFO, UI_SYSTEM_MESSAGES.RUN_FINISHED_NO_MESSAGE));
        }
        const nextMsgs = result.messages.slice(1);
        const nextSteps = sessionSteps + result.steps;
        const nextCp = pushTurnCheckpoint(turnCheckpoints, nextMsgs.length, nextSteps);
        setConversationHistory(nextMsgs);
        setSessionSteps(nextSteps);
        setTurnCheckpoints(nextCp);
        const mergedRunHistory = appendSessionUsageEvents(
          llmUsageHistory,
          result.llmUsageEvents
        );
        setLlmUsageHistory(mergedRunHistory);

        // Save session after each run (when waiting for user input)
        try {
          const { loadConfig } = require("../config.js");
          const config = loadConfig();
          
          const label = sessionName?.trim();
          const session: Session = {
            id: sessionId,
            createdAt: sessionCreatedAt,
            updatedAt: new Date().toISOString(),
            mode: sessionMode,
            model: config.MODEL || process.env.OPENAI_MODEL || "unknown",
            messages: nextMsgs,
            stepCount: nextSteps,
            finished: result.finished,
            cwd: process.cwd(),
            ...(label ? { name: label } : {}),
            ...(mergedRunHistory.length > 0
              ? { llmUsageHistory: mergedRunHistory }
              : {}),
            ...(nextCp.length > 0 ? { turnCheckpoints: nextCp } : {}),
          };
          saveSession(session);
        } catch (err) {
          console.error("Failed to save session:", err instanceof Error ? err.message : String(err));
        }
      } catch (err) {
        setVibing(false);
        abortControllerRef.current = null;
        const errorMsg = formatLlmApiError(err);
        uiLogger.contentBlockAdded(ContentBlockType.ERROR, errorMsg);
        setContentBlocks(prev => addContentBlock(
          prev,
          ContentBlockType.ERROR,
          errorMsg
        ));
        // If runAgent throws (API/network timeout, etc.), we never reach the success path that
        // updates history — without this, the next turn's initialMessages omit this user line,
        // so the model appears to "forget" the task after e.g. "继续".
        setConversationHistory((prev) => [...prev, { role: "user", content: input }]);
      }
    },
    [
      applyRewindResult,
      conversationHistory,
      runAgent,
      summarizeThread,
      exit,
      sessionId,
      sessionName,
      sessionCreatedAt,
      sessionMode,
      sessionSteps,
      llmUsageHistory,
      turnCheckpoints,
    ]
  );

  // Save session on exit (read latest state via ref — empty deps would otherwise freeze
  // conversationHistory / sessionId from the first render only)
  useEffect(() => {
    return () => {
      const {
        conversationHistory: messages,
        sessionId: sid,
        sessionCreatedAt: createdAt,
        sessionMode: mode,
        sessionSteps: steps,
        sessionName: name,
        llmUsageHistory: exitHistory,
        turnCheckpoints: exitCp,
      } = exitSaveRef.current;
      if (messages.length > 0) {
        try {
          const { loadConfig } = require("../config.js");
          const config = loadConfig();
          const label = name?.trim();
          const session: Session = {
            id: sid,
            createdAt,
            updatedAt: new Date().toISOString(),
            mode,
            model: config.MODEL || process.env.OPENAI_MODEL || "unknown",
            messages,
            stepCount: steps,
            finished: true,
            cwd: process.cwd(),
            ...(label ? { name: label } : {}),
            ...(exitHistory.length > 0 ? { llmUsageHistory: exitHistory } : {}),
            ...(exitCp.length > 0 ? { turnCheckpoints: exitCp } : {}),
          };
          saveSession(session);
        } catch (err) {
          console.error("Failed to save session on exit:", err instanceof Error ? err.message : String(err));
        }
      }
    };
  }, []);

  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") {
        if (inputBuffer.length > 0) {
          setInputBuffer("");
          setAutocomplete("");
          historyBrowseIdxRef.current = null;
          setTextInputRemountKey((k) => k + 1);
          return;
        }
        exit();
        return;
      }
      // Tab key for autocomplete
      if (key.tab) {
        handleTab();
        return;
      }
      // ↑↓ 输入历史（与 ink-text-input 一致：组件内忽略方向键，由此处处理）
      if (!isVibing && key.upArrow) {
        const hist = inputHistoryRef.current;
        if (hist.length === 0) return;
        if (historyBrowseIdxRef.current === null) {
          historyDraftRef.current = inputBuffer;
          historyBrowseIdxRef.current = hist.length - 1;
          setInputBuffer(hist[hist.length - 1]!);
          setTextInputRemountKey((k) => k + 1);
        } else {
          const idx = historyBrowseIdxRef.current;
          if (idx > 0) {
            historyBrowseIdxRef.current = idx - 1;
            setInputBuffer(hist[idx - 1]!);
            setTextInputRemountKey((k) => k + 1);
          }
        }
        setAutocomplete("");
        return;
      }
      if (!isVibing && key.downArrow) {
        const hist = inputHistoryRef.current;
        const idx = historyBrowseIdxRef.current;
        if (idx === null) return;
        if (idx < hist.length - 1) {
          historyBrowseIdxRef.current = idx + 1;
          setInputBuffer(hist[idx + 1]!);
          setTextInputRemountKey((k) => k + 1);
        } else {
          historyBrowseIdxRef.current = null;
          setInputBuffer(historyDraftRef.current);
          setTextInputRemountKey((k) => k + 1);
        }
        setAutocomplete("");
        return;
      }
      // ESC key to interrupt current agent run
      if (key.escape && isVibing && abortControllerRef.current) {
        abortControllerRef.current.abort();
        // The agent will handle the abort signal and return a result
        // We'll set vibing to false immediately for better UX
        setVibing(false);
      }
    },
    { isActive: !subScreen }
  );

  return (
    <Box flexDirection="column">
      {subScreen ? (
        <SubScreenHost
          request={subScreen}
          onClose={() => setSubScreen(null)}
          onResume={applySessionResume}
          onCurrentSessionRename={(name) => setSessionName(name)}
          onRewindToUserTurn={handleRewindPick}
        />
      ) : (
        <>
          <Static key={staticMountKey} items={staticLines}>
            {(line, i) => <Text key={`s-${i}`}>{line}</Text>}
          </Static>
          {streamingLines.map((line, i) => (
            <Text key={`t-${i}`}>{line}</Text>
          ))}
          <Box height={1} />
          <Toolbar
            isVibing={isVibing}
            inputBuffer={inputBuffer}
            setInputBuffer={setInputBuffer}
            onSubmit={submit}
            autocomplete={autocomplete}
            onTab={handleTab}
            textInputKey={textInputRemountKey}
          />
        </>
      )}
      <Box height={3} />
    </Box>
  );
}
