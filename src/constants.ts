/**
 * Application messages and UI text constants for easy management and internationalization.
 *
 * Model prompts are managed separately in `src/prompts.ts` and loaded from the `prompts/` directory.
 */

// ============================================================================
// AGENT MESSAGES
// ============================================================================

/**
 * Message shown when an unknown tool is called.
 */
export const UNKNOWN_TOOL_MESSAGE = (toolName: string) => `Unknown tool: ${toolName}`;

/**
 * Message shown when max steps are reached.
 */
export const MAX_STEPS_MESSAGE = 'Max steps reached.';

/**
 * Template for tool call summary.
 */
export const TOOL_CALL_SUMMARY_TEMPLATE = (toolCalls: string) => `Called: ${toolCalls}`;

// ============================================================================
// ERROR MESSAGES
// ============================================================================

/**
 * Error when OPENAI_API_KEY is not set.
 */
export const ERROR_MISSING_API_KEY = 'Set OPENAI_API_KEY in environment.';

/**
 * CLI usage instructions.
 */
export const USAGE_INSTRUCTIONS = `Usage: viber [options]
       viber                 — interactive chat (Ink TUI)
       viber --boarding      — guided setup (BASE_URL, API_KEY, BASE_MODEL)
       viber -r [id]         — resume session (omit id = latest in cwd)`;

// ============================================================================
// CLI OUTPUT MESSAGES
// ============================================================================

/**
 * Exit message.
 */
export const CLI_BYE_MESSAGE = 'Bye.';

// ============================================================================
// UI MESSAGES (Interactive Mode)
// ============================================================================

/**
 * UI labels for welcome screen.
 */
export const UI_LABELS = {
  CWD: 'Cwd:',
  MODEL: 'Model:',
  COMMANDS: 'Commands:',
  TIPS: 'Tips:',
} as const;

/**
 * Available commands in interactive mode.
 */
export const UI_COMMANDS =
  '/status /help /session /config /summary /mcp /rewind /clear /quit';

/**
 * Appended to system prompt when TOOL_CALL_MODE is PTC.
 */
export const PTC_SYSTEM_APPEND = `

## Programmatic tools (PTC)
You are in PTC mode. Use the tool run_builtin_tools_code with a string field code containing JavaScript. The host wraps your code in an async function: use await with built-in helpers named like the usual tools (read_file, write_file, list_dir, search, search_replace, update_file, copy_or_move_file, run_shell). Pass the same argument objects as in standard mode (plain objects). You may use JSON, RegExp, Array/String methods, Map, Set, etc., to filter or aggregate before returning a concise result. MCP tools are not available inside the sandbox; invoke them with separate tool_calls using their mcp__ names. Return a short string or JSON-serializable value at the end.
`;

/**
 * Tips text shown in interactive mode.
 */
export const UI_TIPS = '输入任务描述，Agent 会调用工具帮你完成；↑↓ 浏览上一条/下一条已发送内容';

/**
 * System messages for UI.
 */
export const UI_SYSTEM_MESSAGES = {
  HISTORY_CLEARED: '(History cleared)',
  EMPTY_RESPONSE: '(empty response)',
  /** Shown when the run ended but the model returned no final message (e.g. stopped after saying "now I will do X" without calling the tool). */
  RUN_FINISHED_NO_MESSAGE: 'Run finished. (Model did not return a final message — you can send another message to continue.)',
  /** After /summary: model context is only the compact summary below, not the prior transcript. */
  CONTEXT_REPLACED_BY_SUMMARY:
    "上下文已压缩：发往模型的历史已替换为下方摘要，此前的完整对话不再注入。",
  /** Agent 正在运行时不可执行 /rewind */
  REWIND_WHILE_VIBING:
    "Agent 正在运行，无法执行 /rewind。请先等待结束或按 ESC 中断后再试。",
} as const;

/**
 * User-role message stored after /summary replaces context — tells the model the next assistant turn is a condensed prior conversation.
 */
export const SUMMARY_COMPACT_USER_MESSAGE =
  "（上文会话因上下文长度限制已整体替换为以下摘要；请仅基于摘要与后续用户消息继续协作。）";

/**
 * Error prefix for UI.
 */
export const UI_ERROR_PREFIX = 'Error:';

/**
 * Status text when agent is thinking.
 */
export const UI_STATUS_VIBING = 'vibing';

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get tool call summary from tool calls.
 */
export function getToolCallSummary(toolCalls: Array<{name: string, arguments: string}>): string {
  const calls = toolCalls.map(tc => `${tc.name}(${tc.arguments})`).join(', ');
  return `Called: ${calls}`;
}