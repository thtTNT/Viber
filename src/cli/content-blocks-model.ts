/**
 * TUI transcript blocks (live agent + replay from persisted messages).
 */

export enum ContentBlockType {
  USER_INPUT = "user_input",
  THINKING = "thinking",
  RESPONSE = "response",
  TOOL_CALL = "tool_call",
  ASSISTANT = "assistant",
  ERROR = "error",
  SYSTEM_INFO = "system_info",
}

export interface ContentBlock {
  type: ContentBlockType;
  content: string;
  data?: {
    name?: string;
    args?: string;
    lines?: string[];
    step?: number;
  };
}

export function createContentBlock(
  type: ContentBlockType,
  content: string,
  data?: ContentBlock["data"]
): ContentBlock {
  return { type, content, data };
}

export function addContentBlock(
  blocks: ContentBlock[],
  type: ContentBlockType,
  content: string,
  data?: ContentBlock["data"]
): ContentBlock[] {
  return [...blocks, createContentBlock(type, content, data)];
}
