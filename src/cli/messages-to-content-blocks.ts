/**
 * Rebuild TUI content blocks from persisted chat messages (resume / rewind).
 */

import type { Message } from "../types.js";
import { renderUserBlock } from "./user-block-render.js";
import {
  ContentBlockType,
  createContentBlock,
  type ContentBlock,
} from "./content-blocks-model.js";

const TOOL_RESULT_PREVIEW = 800;

function toolResultBlock(content: string): ContentBlock {
  const preview =
    content.length > TOOL_RESULT_PREVIEW
      ? content.slice(0, TOOL_RESULT_PREVIEW) + "…"
      : content;
  const text = `Tool result\n${preview}`;
  return createContentBlock(ContentBlockType.SYSTEM_INFO, text, {
    lines: text.split("\n"),
  });
}

/**
 * Map session `messages` (no system row) to content blocks for Static rendering.
 * Omits live-only streams (THINKING chunks, per-token RESPONSE).
 */
export function messagesToContentBlocks(messages: Message[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const ub = renderUserBlock(msg.content);
      blocks.push(
        createContentBlock(ContentBlockType.USER_INPUT, ub, {
          lines: ub.split("\n").filter(Boolean),
        })
      );
    } else if (msg.role === "assistant") {
      if (msg.reasoningContent?.trim()) {
        blocks.push(
          createContentBlock(ContentBlockType.THINKING, msg.reasoningContent)
        );
      }
      const text = (msg.content ?? "").trim();
      const hasTools = (msg.toolCalls?.length ?? 0) > 0;
      if (text) {
        blocks.push(
          createContentBlock(
            hasTools ? ContentBlockType.RESPONSE : ContentBlockType.ASSISTANT,
            msg.content ?? ""
          )
        );
      }
      if (msg.toolCalls?.length) {
        for (const tc of msg.toolCalls) {
          blocks.push(
            createContentBlock(ContentBlockType.TOOL_CALL, "", {
              name: tc.name,
              args: tc.arguments,
            })
          );
        }
      }
    } else if (msg.role === "tool") {
      blocks.push(toolResultBlock(msg.content));
    }
  }
  return blocks;
}
