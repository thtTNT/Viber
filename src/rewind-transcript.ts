/**
 * Transcript slicing at user-turn boundaries (rewind / undo last prompt).
 */

import type { Message } from "./types.js";

export function findUserMessageIndices(messages: Message[]): number[] {
  const indices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === "user") {
      indices.push(i);
    }
  }
  return indices;
}

/**
 * Drop the last `turns` user messages: remove from the start index of the
 * earliest of those users through end of transcript.
 * @param turns must be >= 1
 */
export function sliceToBeforeNthUserTurnFromEnd(
  messages: Message[],
  turns: number
): Message[] {
  if (turns < 1) {
    return messages;
  }
  const userIdx = findUserMessageIndices(messages);
  if (userIdx.length === 0) {
    return messages;
  }
  const t = Math.min(turns, userIdx.length);
  const cutIndex = userIdx[userIdx.length - t]!;
  return messages.slice(0, cutIndex);
}

export function sliceToBeforeLastUserTurn(messages: Message[]): Message[] {
  return sliceToBeforeNthUserTurnFromEnd(messages, 1);
}

/**
 * Keep transcript strictly before the `userTurnIndex`-th user message (0 = first user in history).
 */
export function sliceToBeforeUserTurnIndex(
  messages: Message[],
  userTurnIndex: number
): Message[] {
  const userIdx = findUserMessageIndices(messages);
  if (userTurnIndex < 0 || userTurnIndex >= userIdx.length) {
    return messages;
  }
  const cutIndex = userIdx[userTurnIndex]!;
  return messages.slice(0, cutIndex);
}
