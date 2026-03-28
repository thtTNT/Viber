/**
 * Session storage for Viber agent.
 * Persists under each workspace: `<cwd>/.viber/sessions/`
 * (alongside `.viber/config.json`).
 */

import { join } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import type { Message } from "./types.js";

/** Token counts from the provider's last chat completion (persisted on the session). */
export interface LlmUsageSnapshot {
  promptTokens: number;
  completionTokens?: number;
  totalTokens?: number;
  /** ISO time when this snapshot was taken (after the API returned). */
  recordedAt: string;
}

export type LlmUsageSource = "agent" | "summary";

/**
 * One persisted LLM completion usage record (ordered in `Session.llmUsageHistory`).
 * `transcriptLength` is user-visible message count after that completion, for future rollback.
 */
export interface LlmUsageEvent extends LlmUsageSnapshot {
  source: LlmUsageSource;
  /** Agent inner step when `source === "agent"` */
  agentStep?: number;
  /** `messages.length` in session terms after this completion (no system row). */
  transcriptLength?: number;
}

export function snapshotFromLlmUsage(
  usage:
    | { promptTokens?: number; completionTokens?: number; totalTokens?: number }
    | undefined
): LlmUsageSnapshot | undefined {
  if (usage === undefined || usage.promptTokens === undefined) {
    return undefined;
  }
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    recordedAt: new Date().toISOString(),
  };
}

/** Build a persisted usage event from API usage + metadata. */
export function usageEventFromApi(
  usage:
    | { promptTokens?: number; completionTokens?: number; totalTokens?: number }
    | undefined,
  meta: {
    source: LlmUsageSource;
    agentStep?: number;
    transcriptLength?: number;
  }
): LlmUsageEvent | undefined {
  const snap = snapshotFromLlmUsage(usage);
  if (!snap) return undefined;
  return {
    ...snap,
    source: meta.source,
    ...(meta.agentStep !== undefined ? { agentStep: meta.agentStep } : {}),
    ...(meta.transcriptLength !== undefined
      ? { transcriptLength: meta.transcriptLength }
      : {}),
  };
}

export function lastUsageSnapshot(
  history: LlmUsageEvent[] | undefined
): LlmUsageSnapshot | undefined {
  const last = history?.[history.length - 1];
  if (!last) return undefined;
  return {
    promptTokens: last.promptTokens,
    completionTokens: last.completionTokens,
    totalTokens: last.totalTokens,
    recordedAt: last.recordedAt,
  };
}

export function appendSessionUsageEvents(
  existing: LlmUsageEvent[] | undefined,
  additions: LlmUsageEvent[]
): LlmUsageEvent[] {
  if (additions.length === 0) {
    return existing ? [...existing] : [];
  }
  return [...(existing ?? []), ...additions];
}

/** Drop usage events whose transcript is longer than the rolled-back transcript (for future rollback). */
export function truncateUsageHistoryToTranscriptLength(
  history: LlmUsageEvent[] | undefined,
  maxTranscriptLength: number
): LlmUsageEvent[] {
  if (!history?.length) return [];
  return history.filter(
    (e) =>
      e.transcriptLength === undefined || e.transcriptLength <= maxTranscriptLength
  );
}

/** After each completed agent turn (or /summary), for rewind stepCount restoration. */
export interface TurnCheckpoint {
  messageCount: number;
  stepCount: number;
}

export function pushTurnCheckpoint(
  checkpoints: TurnCheckpoint[] | undefined,
  messageCount: number,
  stepCount: number
): TurnCheckpoint[] {
  const prev = checkpoints ?? [];
  const last = prev[prev.length - 1];
  if (
    last &&
    last.messageCount === messageCount &&
    last.stepCount === stepCount
  ) {
    return prev;
  }
  return [...prev, { messageCount, stepCount }];
}

export function truncateTurnCheckpointsToMessageLength(
  checkpoints: TurnCheckpoint[] | undefined,
  maxMessageCount: number
): TurnCheckpoint[] {
  if (!checkpoints?.length) return [];
  return checkpoints.filter((c) => c.messageCount <= maxMessageCount);
}

/**
 * Step count after rewinding to `messageCount` messages: prefer checkpoints,
 * else count agent completions left in usage history (post-truncation).
 */
export function resolveStepCountForRewind(
  checkpoints: TurnCheckpoint[] | undefined,
  messageCount: number,
  truncatedUsageHistory: LlmUsageEvent[]
): number {
  if (checkpoints?.length) {
    let best: TurnCheckpoint | undefined;
    for (const c of checkpoints) {
      if (c.messageCount <= messageCount) {
        if (!best || c.messageCount > best.messageCount) {
          best = c;
        }
      }
    }
    if (best !== undefined) {
      return best.stepCount;
    }
  }
  return truncatedUsageHistory.filter((e) => e.source === "agent").length;
}

function normalizeSessionLoaded(raw: Session): Session {
  let llmUsageHistory = raw.llmUsageHistory;
  if (!llmUsageHistory?.length && raw.lastLlmUsage) {
    llmUsageHistory = [{ ...raw.lastLlmUsage, source: "agent" as const }];
  }
  const history = llmUsageHistory ?? [];
  const last = lastUsageSnapshot(history);
  return {
    ...raw,
    llmUsageHistory: history,
    ...(last ? { lastLlmUsage: last } : {}),
  };
}

export interface Session {
  /** Unique session ID: {timestamp}-{uuid} */
  id: string;
  /** Optional human-readable label (does not affect log paths or id) */
  name?: string;
  /** ISO timestamp when session was created */
  createdAt: string;
  /** ISO timestamp when session was last updated */
  updatedAt: string;
  /** Session mode: "interactive" or "single" */
  mode: "interactive" | "single";
  /** Model used for this session */
  model: string;
  /** Full message history (without system message) */
  messages: Message[];
  /** Total tool call steps taken */
  stepCount: number;
  /** Whether the last run finished naturally (vs aborted) */
  finished: boolean;
  /** Working directory */
  cwd: string;
  /** Append-only log of each LLM completion usage (agent + summary); for rollback / analytics. */
  llmUsageHistory?: LlmUsageEvent[];
  /** Last completion usage (redundant with last history entry; kept for older readers). */
  lastLlmUsage?: LlmUsageSnapshot;
  /** Monotonic checkpoints for /rewind stepCount (optional; older sessions omit). */
  turnCheckpoints?: TurnCheckpoint[];
}

export interface SessionSummary {
  id: string;
  name?: string;
  createdAt: string;
  updatedAt: string;
  mode: "interactive" | "single";
  model: string;
  messageCount: number;
  stepCount: number;
  cwd: string;
}

/** Resolved directory for session JSON + `sessions.jsonl` under a workspace. */
export function workspaceSessionsDir(cwd: string): string {
  return join(cwd, ".viber", "sessions");
}

function indexPath(sessionsDir: string): string {
  return join(sessionsDir, "sessions.jsonl");
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function sessionToSummary(session: Session): SessionSummary {
  const summary: SessionSummary = {
    id: session.id,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    mode: session.mode,
    model: session.model,
    messageCount: session.messages.length,
    stepCount: session.stepCount,
    cwd: session.cwd,
  };
  if (session.name !== undefined && session.name !== "") {
    summary.name = session.name;
  }
  return summary;
}

function summaryToIndexLine(s: SessionSummary): string {
  const o: Record<string, unknown> = {
    id: s.id,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    mode: s.mode,
    model: s.model,
    messageCount: s.messageCount,
    stepCount: s.stepCount,
    cwd: s.cwd,
  };
  if (s.name !== undefined && s.name !== "") {
    o.name = s.name;
  }
  return JSON.stringify(o);
}

/** Read index NDJSON; last line wins per id (migrates legacy append-only files). */
function readSessionIndexMap(sessionsDir: string): Map<string, SessionSummary> {
  const byId = new Map<string, SessionSummary>();
  const indexFile = indexPath(sessionsDir);
  if (!existsSync(indexFile)) {
    return byId;
  }
  try {
    const content = readFileSync(indexFile, "utf-8");
    for (const line of content.trim().split(/\r?\n/).filter(Boolean)) {
      try {
        const s = JSON.parse(line) as SessionSummary;
        byId.set(s.id, s);
      } catch {
        /* skip bad line */
      }
    }
  } catch {
    /* missing or unreadable */
  }
  return byId;
}

/** One NDJSON line per session id, sorted by updatedAt desc (stable listing). */
function writeSessionIndexMap(
  sessionsDir: string,
  byId: Map<string, SessionSummary>
): void {
  ensureDir(sessionsDir);
  const sorted = Array.from(byId.values()).sort(
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
  const body =
    sorted.map((s) => summaryToIndexLine(s)).join("\n") +
    (sorted.length > 0 ? "\n" : "");
  writeFileSync(indexPath(sessionsDir), body, "utf-8");
}

/**
 * Get the file path for a session in a workspace (may not exist on disk yet).
 */
export function getSessionPath(id: string, cwd: string): string {
  return join(workspaceSessionsDir(cwd), `${id}.json`);
}

/**
 * Create `<id>.json` with an empty transcript if the file is absent.
 * Called at interactive CLI startup so the session appears in the list and can be renamed before the first turn.
 */
export function ensureEmptySessionFile(
  id: string,
  cwd: string,
  opts: { model: string; createdAt: string }
): void {
  if (existsSync(getSessionPath(id, cwd))) {
    return;
  }
  const { createdAt, model } = opts;
  saveSession({
    id,
    createdAt,
    updatedAt: createdAt,
    mode: "interactive",
    model,
    messages: [],
    stepCount: 0,
    finished: false,
    cwd,
  });
}

/**
 * Save a session to `<session.cwd>/.viber/sessions/`.
 */
export function saveSession(session: Session): void {
  const sessionsDir = workspaceSessionsDir(session.cwd);
  ensureDir(sessionsDir);

  const sessionPath = join(sessionsDir, `${session.id}.json`);
  const history = session.llmUsageHistory ?? [];
  const last = lastUsageSnapshot(history);
  const toWrite: Session = {
    ...session,
    llmUsageHistory: history,
  };
  if (last) {
    toWrite.lastLlmUsage = last;
  } else {
    delete toWrite.lastLlmUsage;
  }
  const sessionJson = JSON.stringify(toWrite, null, 2);
  writeFileSync(sessionPath, sessionJson, "utf-8");

  const map = readSessionIndexMap(sessionsDir);
  map.set(session.id, sessionToSummary(toWrite));
  writeSessionIndexMap(sessionsDir, map);
}

/**
 * Load a session from `<cwd>/.viber/sessions/<id>.json`.
 */
export function loadSession(id: string, cwd: string): Session | null {
  const workspacePath = getSessionPath(id, cwd);
  if (!existsSync(workspacePath)) {
    return null;
  }
  try {
    const content = readFileSync(workspacePath, "utf-8");
    return normalizeSessionLoaded(JSON.parse(content) as Session);
  } catch (err) {
    console.error(
      `Failed to load session ${id}:`,
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

/**
 * Rewrite `sessions.jsonl` so each session id appears once (migrates legacy append-only index).
 */
export function dedupeSessionIndex(cwd: string): void {
  const sessionsDir = workspaceSessionsDir(cwd);
  if (!existsSync(indexPath(sessionsDir))) {
    return;
  }
  writeSessionIndexMap(sessionsDir, readSessionIndexMap(sessionsDir));
}

/**
 * List recent sessions for the given workspace directory only.
 */
export function listSessions(limit: number = 10, cwd: string): SessionSummary[] {
  const sessionsDir = workspaceSessionsDir(cwd);

  if (!existsSync(indexPath(sessionsDir))) {
    return [];
  }

  try {
    const sessions = Array.from(readSessionIndexMap(sessionsDir).values()).sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
    return sessions.slice(0, limit);
  } catch (err) {
    console.error(
      "Failed to read sessions index:",
      err instanceof Error ? err.message : String(err)
    );
    return [];
  }
}

/**
 * Get the most recent session in a workspace.
 */
export function getLatestSession(cwd: string): SessionSummary | null {
  const sessions = listSessions(1, cwd);
  return sessions.length > 0 ? sessions[0] : null;
}

/**
 * Set or clear the display name of a session. The id and on-disk JSON filename are unchanged.
 * Pass an empty string to remove the name.
 * `cwd` scopes load lookup; writes go to `session.cwd` via saveSession.
 */
export function renameSession(id: string, name: string, cwd: string): boolean {
  const session = loadSession(id, cwd);
  if (!session) {
    return false;
  }

  const trimmed = name.trim();
  const updated: Session = {
    ...session,
    updatedAt: new Date().toISOString(),
  };
  if (trimmed === "") {
    delete updated.name;
  } else {
    updated.name = trimmed;
  }

  saveSession(updated);
  return true;
}

/**
 * Delete a session file under `<cwd>/.viber/sessions/`.
 */
export function deleteSession(id: string, cwd: string): boolean {
  const workspacePath = getSessionPath(id, cwd);
  if (!existsSync(workspacePath)) {
    return false;
  }
  try {
    unlinkSync(workspacePath);
    const sessionsDir = workspaceSessionsDir(cwd);
    const map = readSessionIndexMap(sessionsDir);
    map.delete(id);
    writeSessionIndexMap(sessionsDir, map);
    return true;
  } catch (err) {
    console.error(
      `Failed to delete session ${id}:`,
      err instanceof Error ? err.message : String(err)
    );
    return false;
  }
}

/**
 * Banner text after resuming a session (TUI / CLI messaging).
 */
export function formatSessionResumeBanner(session: Session): string {
  const lines: string[] = [];
  lines.push(`╭─ Session Resumed ${"─".repeat(50)}`);
  lines.push(`│ ID: ${session.id}`);
  if (session.name) {
    lines.push(`│ Name: ${session.name}`);
  }
  lines.push(`│ Created: ${new Date(session.createdAt).toLocaleString()}`);
  lines.push(`│ Model: ${session.model}`);
  lines.push(`│ Messages: ${session.messages.length}`);
  lines.push(`│ Steps: ${session.stepCount}`);
  lines.push(`│`);
  lines.push(`│ Last message:`);
  const lastMsg = session.messages[session.messages.length - 1];
  if (lastMsg) {
    const text = lastMsg.content ?? "";
    const preview = text.substring(0, 100) + (text.length > 100 ? "..." : "");
    lines.push(`│   ${lastMsg.role}: ${preview}`);
  }
  lines.push(`╰${"─".repeat(68)}`);
  return lines.join("\n");
}

/** Deep-enough copy for passing a loaded session into the agent (avoid shared `messages` array). */
export function cloneSessionForResume(session: Session): Session {
  return {
    ...session,
    messages: session.messages.map((m) => ({ ...m })),
  };
}

/**
 * Export session to Markdown
 */
export function exportSessionToMarkdown(session: Session): string {
  const lines: string[] = [];

  lines.push(`# Viber Session: ${session.id}`);
  lines.push("");
  if (session.name) {
    lines.push(`**Name**: ${session.name}`);
    lines.push("");
  }
  lines.push(`**Created**: ${new Date(session.createdAt).toLocaleString()}`);
  lines.push(`**Updated**: ${new Date(session.updatedAt).toLocaleString()}`);
  lines.push(`**Model**: ${session.model}`);
  lines.push(`**Mode**: ${session.mode}`);
  lines.push(`**Steps**: ${session.stepCount}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const msg of session.messages) {
    if (msg.role === "user") {
      lines.push(`## 👤 User`);
      lines.push("");
      lines.push(msg.content);
      lines.push("");
    } else if (msg.role === "assistant") {
      lines.push(`## 🤖 Assistant`);
      lines.push("");
      if (msg.content) {
        lines.push(msg.content);
        lines.push("");
      }
      if (msg.toolCalls?.length) {
        lines.push(`**Tool calls**: ${msg.toolCalls.length}`);
        lines.push("");
        for (const tc of msg.toolCalls) {
          lines.push(`- \`${tc.name}\`(${tc.arguments})`);
        }
        lines.push("");
      }
    } else if (msg.role === "tool") {
      lines.push(
        `**Tool Result**: ${msg.content.substring(0, 500)}${msg.content.length > 500 ? "..." : ""}`
      );
      lines.push("");
    }
  }

  return lines.join("\n");
}
