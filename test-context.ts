/**
 * Test script for /context command
 */

import { processCommand } from "./src/commands.js";
import type { Message } from "./src/types.js";

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

async function main() {
  console.log("=== Testing /context command ===\n");

  console.log("1. With API usage (mock):");
  console.log("-".repeat(50));
  const r1 = await processCommand("context", {
    messages: mockMessages,
    cwd: process.cwd(),
    lastLlmUsage: {
      promptTokens: 12_345,
      completionTokens: 400,
      totalTokens: 12_745,
      recordedAt: "2026-03-22T10:00:00.000Z",
    },
  });
  console.log(r1.output);
  console.log();

  console.log("2. Without API usage:");
  console.log("-".repeat(50));
  const r2 = await processCommand("context", {
    messages: mockMessages,
    cwd: process.cwd(),
  });
  console.log(r2.output);
  console.log();

  console.log("3. Alias /ctx:");
  console.log("-".repeat(50));
  const r3 = await processCommand("ctx", { messages: mockMessages, cwd: process.cwd() });
  console.log(r3.output);
  console.log();

  console.log("4. Empty history:");
  console.log("-".repeat(50));
  const r4 = await processCommand("context", { messages: [], cwd: process.cwd() });
  console.log(r4.output);
  console.log();

  console.log("=== Done ===");
}

main().catch(console.error);
