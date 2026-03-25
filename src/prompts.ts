/**
 * Model prompt management.
 *
 * Loads model prompts from the `prompts/` directory as Markdown files
 * for easy reading and updating.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROMPTS_DIR = join(__dirname, '..', 'prompts');

/**
 * Load a prompt from a Markdown file.
 * @param name - Name of the prompt file (without .md extension)
 * @returns The content of the prompt file, or fallback default if file not found
 */
function loadPrompt(name: string, fallback: string): string {
  try {
    const filePath = join(PROMPTS_DIR, `${name}.md`);
    const content = readFileSync(filePath, 'utf-8');
    return content.trim();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn(`Failed to load prompt ${name}.md, using fallback:`, errorMessage);
    return fallback;
  }
}

/**
 * Default system prompt for the coding agent.
 * Loaded from: prompts/system_prompt.md
 */
export const SYSTEM_PROMPT = loadPrompt('system_prompt',
  `You are a coding agent. You have access to tools to read/write files, list directories, and run shell commands.
If MCP is configured in the workspace .viber/config.json, extra tools may appear with names starting with mcp__.
Plan step by step, use tools to gather information or make changes, then summarize the result for the user.
Always call tools with valid JSON arguments. Respond in the same language as the user when giving final answers.`
);

/**
 * Template for presenting tool results to the agent.
 * Loaded from: prompts/tool_results_template.md
 * @deprecated Use tool role messages instead
 */
export const TOOL_RESULTS_TEMPLATE = loadPrompt('tool_results_template',
  `Tool results:
{resultBlob}

Continue with the task. If done, reply with a final summary for the user.`
);

/**
 * Format tool results for the agent.
 * @deprecated Use tool role messages instead
 */
export function formatToolResults(resultBlob: string): string {
  return TOOL_RESULTS_TEMPLATE.replace('{resultBlob}', resultBlob);
}

/**
 * System prompt for /summary — condenses the chat transcript without tools.
 * Loaded from: prompts/summary_prompt.md
 */
export const SUMMARY_PROMPT = loadPrompt(
  "summary_prompt",
  `You summarize a coding-assistant chat transcript for the user.

Capture main goals, outcomes, important paths/commands/config changes, and brief open follow-ups.
Be faithful to the transcript; do not invent unsupported results.
Use short sections or bullets; match the user's language in the transcript; stay concise.`
);