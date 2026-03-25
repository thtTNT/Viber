import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Serialize MCP tools/call result for the agent (tool role message).
 */
export function formatMcpCallToolResult(result: CallToolResult): string {
  const parts: string[] = [];
  if (result.isError) {
    parts.push("MCP tool reported an error.");
  }
  if (result.structuredContent && Object.keys(result.structuredContent).length > 0) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }
  for (const block of result.content ?? []) {
    if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "image") {
      parts.push(`[image ${block.mimeType}, base64 length ${block.data.length}]`);
    } else if (block.type === "audio") {
      parts.push(`[audio ${block.mimeType}, base64 length ${block.data.length}]`);
    } else if (block.type === "resource") {
      const r = block.resource;
      if ("text" in r) {
        parts.push(r.text);
      } else {
        parts.push(`[binary resource ${r.uri}${r.mimeType ? ` ${r.mimeType}` : ""}]`);
      }
    } else if (block.type === "resource_link") {
      parts.push(`[resource link ${block.name}: ${block.uri}]`);
    }
  }
  const out = parts.join("\n\n").trim();
  return out || "(empty MCP tool result)";
}
