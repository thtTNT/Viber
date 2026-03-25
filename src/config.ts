/**
 * Configuration loader for Viber agent.
 * Uses conf for ~/.viber/config.json with env fallback.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import Conf from "conf";

/** Standard OpenAI-style tool_calls per step, or PTC: single `run_builtin_tools_code` with sandboxed JS. */
export type ToolCallMode = "standard" | "ptc";

export interface ViberConfig {
  /** API key for LLM provider */
  API_KEY?: string;
  /** Base URL for LLM API (optional, for proxy or custom endpoints) */
  BASE_URL?: string;
  /** Model name to use */
  MODEL?: string;
  /** Tool calling style (default: standard). Also: env `VIBER_TOOL_CALL_MODE=ptc`. */
  TOOL_CALL_MODE?: ToolCallMode;
}

const CONFIG_DIR = join(homedir(), ".viber");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

const store = new Conf<ViberConfig>({
  projectName: "viber",
  cwd: CONFIG_DIR,
  configName: "config",
  defaults: {},
});

export function normalizeToolCallMode(value: unknown): ToolCallMode {
  if (value === "ptc" || value === "PTC") return "ptc";
  return "standard";
}

/**
 * Load configuration from ~/.viber/config.json
 * Falls back to environment variables if config file doesn't exist or keys are missing.
 */
export function loadConfig(): ViberConfig {
  const config: ViberConfig = {};

  const apiKey = store.get("API_KEY");
  const baseUrl = store.get("BASE_URL");
  const model = store.get("MODEL");
  const toolCallMode = store.get("TOOL_CALL_MODE");

  if (apiKey) config.API_KEY = apiKey;
  if (baseUrl) config.BASE_URL = baseUrl;
  if (model) config.MODEL = model;
  if (toolCallMode !== undefined) {
    config.TOOL_CALL_MODE = normalizeToolCallMode(toolCallMode);
  }

  if (!config.API_KEY) config.API_KEY = process.env.OPENAI_API_KEY;
  if (!config.BASE_URL) config.BASE_URL = process.env.OPENAI_BASE_URL;
  if (!config.MODEL) config.MODEL = process.env.OPENAI_MODEL;
  if (!config.MODEL) config.MODEL = process.env.BASE_MODEL;
  if (config.TOOL_CALL_MODE === undefined && process.env.VIBER_TOOL_CALL_MODE) {
    config.TOOL_CALL_MODE = normalizeToolCallMode(process.env.VIBER_TOOL_CALL_MODE);
  }

  return config;
}

/**
 * Save configuration to ~/.viber/config.json
 */
export function saveConfig(config: ViberConfig): void {
  if (config.API_KEY !== undefined) store.set("API_KEY", config.API_KEY);
  if (config.BASE_URL !== undefined) store.set("BASE_URL", config.BASE_URL);
  if (config.MODEL !== undefined) store.set("MODEL", config.MODEL);
  if (config.TOOL_CALL_MODE !== undefined) store.set("TOOL_CALL_MODE", config.TOOL_CALL_MODE);
}

/**
 * Get the config file path.
 */
export function getConfigPath(): string {
  return store.path;
}

/**
 * Check if config file exists.
 */
export function hasConfigFile(): boolean {
  return existsSync(store.path);
}
