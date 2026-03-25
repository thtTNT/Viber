import { APIError } from "openai";

const BODY_MAX = 800;

/**
 * Turn OpenAI SDK errors (and generic Errors) into a multi-line message for the TUI.
 */
export function formatLlmApiError(err: unknown): string {
  if (err instanceof APIError) {
    const lines: string[] = [err.message || `HTTP ${String(err.status)}`];
    if (err.code) lines.push(`code: ${err.code}`);
    if (err.type) lines.push(`type: ${err.type}`);
    if (err.request_id) lines.push(`request_id: ${err.request_id}`);
    const body = err.error;
    if (body !== undefined && body !== null && typeof body === "object") {
      const s = JSON.stringify(body);
      if (s && s !== "{}") {
        lines.push(s.length > BODY_MAX ? `${s.slice(0, BODY_MAX)}…` : s);
      }
    }
    if (err.status === 403) {
      lines.push(
        "提示：403 多为密钥无效、当前账号/组织无权使用该模型，或 OPENAI_BASE_URL 与密钥不属于同一服务商。"
      );
    } else if (err.status === 401) {
      lines.push("提示：401 请检查 OPENAI_API_KEY 或 ~/.viber/config.json 中的 API_KEY。");
    }
    return lines.join("\n");
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
