import test from "node:test";
import assert from "node:assert/strict";
import { processCommand } from "../src/commands.js";
import {
  findUserMessageIndices,
  sliceToBeforeNthUserTurnFromEnd,
  sliceToBeforeLastUserTurn,
  sliceToBeforeUserTurnIndex,
} from "../src/rewind-transcript.js";
import { SUB_SCREEN_REWIND } from "../src/tui/sub-screen-types.js";
import type { Message } from "../src/types.js";

test("findUserMessageIndices empty", () => {
  assert.deepEqual(findUserMessageIndices([]), []);
});

test("sliceToBeforeLastUserTurn removes last user and tail", () => {
  const messages: Message[] = [
    { role: "user", content: "a" },
    { role: "assistant", content: "A" },
    { role: "user", content: "b" },
    { role: "assistant", content: "B" },
  ];
  const out = sliceToBeforeLastUserTurn(messages);
  assert.equal(out.length, 2);
  assert.equal(out[0]!.content, "a");
});

test("sliceToBeforeNthUserTurnFromEnd n=2 keeps transcript before earliest of last two users", () => {
  const messages: Message[] = [
    { role: "user", content: "1" },
    { role: "assistant", content: "x" },
    { role: "user", content: "2" },
    { role: "user", content: "3" },
  ];
  const out = sliceToBeforeNthUserTurnFromEnd(messages, 2);
  assert.equal(out.length, 2);
  assert.equal(out[0]!.content, "1");
  assert.equal(out[1]!.content, "x");
});

test("sliceToBeforeNthUserTurnFromEnd clamps when n exceeds users", () => {
  const messages: Message[] = [{ role: "user", content: "only" }];
  const out = sliceToBeforeNthUserTurnFromEnd(messages, 99);
  assert.deepEqual(out, []);
});

test("no user messages returns unchanged", () => {
  const messages: Message[] = [{ role: "assistant", content: "hi" }];
  assert.deepEqual(sliceToBeforeLastUserTurn(messages), messages);
});

test("sliceToBeforeUserTurnIndex cuts before nth user (chronological)", () => {
  const messages: Message[] = [
    { role: "user", content: "a" },
    { role: "assistant", content: "A" },
    { role: "user", content: "b" },
    { role: "assistant", content: "B" },
  ];
  const beforeSecond = sliceToBeforeUserTurnIndex(messages, 1);
  assert.equal(beforeSecond.length, 2);
  assert.equal(beforeSecond[0]!.content, "a");
  assert.equal(beforeSecond[1]!.content, "A");
  assert.deepEqual(sliceToBeforeUserTurnIndex(messages, 0), []);
});

test("sliceToBeforeUserTurnIndex invalid index is no-op", () => {
  const messages: Message[] = [{ role: "user", content: "x" }];
  assert.deepEqual(sliceToBeforeUserTurnIndex(messages, -1), messages);
  assert.deepEqual(sliceToBeforeUserTurnIndex(messages, 99), messages);
});

test("/rewind with no args opens rewind sub-screen when user turns exist", async () => {
  const r = await processCommand("rewind", {
    messages: [{ role: "user", content: "x" }],
  });
  assert.equal(r.handled, true);
  assert.equal(r.openSubScreen?.id, SUB_SCREEN_REWIND);
});

test("/rewind 1 still returns rewind payload", async () => {
  const messages: Message[] = [
    { role: "user", content: "a" },
    { role: "assistant", content: "A" },
    { role: "user", content: "b" },
  ];
  const r = await processCommand("rewind 1", { messages });
  assert.ok(r.rewind);
  assert.equal(r.rewind!.messages.length, 2);
});
