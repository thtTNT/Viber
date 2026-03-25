/**
 * Configuration loader for Viber agent.
 * Uses conf for ~/.viber/config.json with env fallback.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import Conf from "conf";

export interface ViberConfig {
  /** API key for LLM provider */
  API_KEY?: string;
  /** Base URL for LLM API (optional, for proxy or custom endpoints) */
  BASE_URL?: string;
  /** Model name to use */
  MODEL?: string;
}

const CONFIG_DIR = join(homedir(), ".viber");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

const store = new Conf<ViberConfig>({
  projectName: "viber",
  cwd: CONFIG_DIR,
  configName: "config",
  defaults: {},
});

/**
 * Load configuration from ~/.viber/config.json
 * Falls back to environment variables if config file doesn't exist or keys are missing.
 */
export function loadConfig(): ViberConfig {
  const config: ViberConfig = {};

  const apiKey = store.get("API_KEY");
  const baseUrl = store.get("BASE_URL");
  const model = store.get("MODEL");

  if (apiKey) config.API_KEY = apiKey;
  if (baseUrl) config.BASE_URL = baseUrl;
  if (model) config.MODEL = model;

  if (!config.API_KEY) config.API_KEY = process.env.OPENAI_API_KEY;
  if (!config.BASE_URL) config.BASE_URL = process.env.OPENAI_BASE_URL;
  if (!config.MODEL) config.MODEL = process.env.OPENAI_MODEL;
  if (!config.MODEL) config.MODEL = process.env.BASE_MODEL;

  return config;
}

/**
 * Save configuration to ~/.viber/config.json
 */
export function saveConfig(config: ViberConfig): void {
  if (config.API_KEY !== undefined) store.set("API_KEY", config.API_KEY);
  if (config.BASE_URL !== undefined) store.set("BASE_URL", config.BASE_URL);
  if (config.MODEL !== undefined) store.set("MODEL", config.MODEL);
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
