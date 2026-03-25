/**
 * Workspace-local Viber config: `.viber/config.json` under cwd (alongside `.viber/logs`).
 * Global API keys stay in ~/.viber/config.json (see config.ts).
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface WorkspaceViberConfigFile {
  /**
   * Cursor-style root map (same shape as each entry under `mcp.servers`).
   */
  mcpServers?: Record<string, McpServerConfig>;
  mcp?: {
    servers?: Record<string, McpServerConfig>;
  };
  [key: string]: unknown;
}

export function workspaceViberConfigPath(cwd: string): string {
  return join(cwd, ".viber", "config.json");
}

export type LoadWorkspaceViberConfigResult =
  | { ok: true; path: string; data: WorkspaceViberConfigFile }
  | { ok: false; path: string; reason: "missing" }
  | { ok: false; path: string; reason: "invalid"; message: string };

export function loadWorkspaceViberConfig(cwd: string): LoadWorkspaceViberConfigResult {
  const path = workspaceViberConfigPath(cwd);
  if (!existsSync(path)) {
    return { ok: false, path, reason: "missing" };
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as unknown;
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, path, reason: "invalid", message: "Root must be a JSON object" };
    }
    return { ok: true, path, data: data as WorkspaceViberConfigFile };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, path, reason: "invalid", message };
  }
}

function asMcpServerMap(value: unknown): Record<string, McpServerConfig> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const o = value as Record<string, McpServerConfig>;
  return Object.keys(o).length > 0 ? o : null;
}

/**
 * Resolves MCP server entries from `.viber/config.json`.
 * Supports:
 * - `{ "mcpServers": { "id": { "command", "args", "env" } } }` (Cursor-compatible root)
 * - `{ "mcp": { "servers": { ... } } }` (documented Viber shape)
 * If both are present, entries are merged; `mcp.servers` wins on duplicate ids.
 */
export function getMcpServersFromWorkspace(
  data: WorkspaceViberConfigFile
): Record<string, McpServerConfig> | null {
  const fromRoot = asMcpServerMap(data.mcpServers);
  const fromNested = asMcpServerMap(data.mcp?.servers);
  if (fromRoot && fromNested) {
    return { ...fromRoot, ...fromNested };
  }
  return fromNested ?? fromRoot ?? null;
}
