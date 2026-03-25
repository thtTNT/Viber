/**
 * Format API-reported usage for /context (no local token estimation).
 */

import type { LlmUsageSnapshot } from "../session-store.js";

export function formatApiUsageSection(
  u: LlmUsageSnapshot,
  maxContext?: number
): string {
  const lines: string[] = [];
  lines.push("╭─ API 用量（最近一次响应） " + "─".repeat(Math.max(0, 26)));
  const pctSuffix =
    maxContext && maxContext > 0
      ? ` （约 ${Math.round((u.promptTokens / maxContext) * 100)}% 上限）`
      : "";
  lines.push(
    `│ 输入 (prompt) tokens:     ${u.promptTokens.toLocaleString()}${pctSuffix}`
  );
  if (u.completionTokens !== undefined) {
    lines.push(`│ 输出 (completion) tokens: ${u.completionTokens.toLocaleString()}`);
  }
  if (u.totalTokens !== undefined) {
    lines.push(`│ 本次总计 tokens:          ${u.totalTokens.toLocaleString()}`);
  }
  lines.push(`│ 记录时间:                 ${u.recordedAt}`);
  if (maxContext && u.promptTokens > maxContext * 0.8) {
    lines.push("│");
    const percentage = Math.round((u.promptTokens / maxContext) * 100);
    lines.push(`│ ⚠️  提示: 输入规模已达上限的 ${percentage}%`);
  }
  lines.push("╰" + "─".repeat(Math.max(0, 45)));
  return lines.join("\n");
}
