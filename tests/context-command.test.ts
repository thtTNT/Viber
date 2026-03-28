import test from "node:test";
import assert from "node:assert/strict";
import { processCommand } from "../src/commands.js";
import type { Message } from "../src/types.js";

const mockMessages: Message[] = [
  { role: "user", content: "Hello, can you help me create a file?" },
  {
    role: "assistant",
    content: "Sure! I'll create a file for you.",
    toolCalls: [
      {
        id: "1",
        name: "write_file",
        arguments: JSON.stringify({ path: "test.txt", content: "Hello World" }),
      },
    ],
  },
  { role: "tool", content: "File written successfully", toolCallId: "1" },
  { role: "user", content: "Thanks! Now can you read it back?" },
  {
    role: "assistant",
    content: "Let me read the file.",
    toolCalls: [
      { id: "2", name: "read_file", arguments: JSON.stringify({ path: "test.txt" }) },
    ],
  },
  { role: "tool", content: "Hello World", toolCallId: "2" },
  { role: "assistant", content: "The file contains: Hello World" },
];

test("/context with lastLlmUsage shows token section and metrics", async () => {
  const r = await processCommand("context", {
    messages: mockMessages,
    cwd: process.cwd(),
    lastLlmUsage: {
      promptTokens: 12_345,
      completionTokens: 400,
      totalTokens: 12_745,
      recordedAt: "2026-03-22T10:00:00.000Z",
    },
  });
  assert.equal(r.handled, true);
  const out = r.output ?? "";
  assert.match(out, /12,?345/);
  assert.match(out, /消息条数:\s+7/);
  assert.match(out, /工具调用次数:\s+2/);
});

test("/context without lastLlmUsage shows hint and metrics", async () => {
  const r = await processCommand("context", {
    messages: mockMessages,
    cwd: process.cwd(),
  });
  assert.equal(r.handled, true);
  const out = r.output ?? "";
  assert.match(out, /尚无最近一次 API/);
  assert.match(out, /消息条数:\s+7/);
});

test("/ctx alias matches /context without usage", async () => {
  const rCtx = await processCommand("context", {
    messages: mockMessages,
    cwd: process.cwd(),
  });
  const rAlias = await processCommand("ctx", {
    messages: mockMessages,
    cwd: process.cwd(),
  });
  assert.equal(rAlias.output, rCtx.output);
});

test("/context empty messages shows zero counts", async () => {
  const r = await processCommand("context", {
    messages: [],
    cwd: process.cwd(),
  });
  assert.equal(r.handled, true);
  const out = r.output ?? "";
  assert.match(out, /消息条数:\s+0/);
  assert.match(out, /工具调用次数:\s+0/);
});
