import test from "node:test";
import assert from "node:assert/strict";
import { createAgent } from "../src/agent.js";
import type { LLMClientWithTools } from "../src/llm/types.js";

test("agent executes builtin search when mock LLM emits tool_calls", async () => {
  let llmRound = 0;
  const cwd = process.cwd();

  const mockLLM: LLMClientWithTools = {
    async chat() {
      throw new Error("unexpected chat()");
    },
    async chatWithTools(_messages, tools) {
      llmRound++;
      assert.ok(
        tools.some((t) => t.function.name === "search"),
        "search tool should be registered"
      );
      if (llmRound === 1) {
        return {
          message: {
            role: "assistant",
            content: "Searching...",
            toolCalls: [
              {
                id: "test-search-1",
                name: "search",
                arguments: JSON.stringify({
                  pattern: "package.json",
                  path: cwd,
                  case_sensitive: false,
                }),
              },
            ],
          },
          finishReason: "tool_calls",
        };
      }
      return {
        message: {
          role: "assistant",
          content: "Done.",
          toolCalls: [],
        },
        finishReason: "stop",
      };
    },
  };

  const agent = createAgent({
    llm: mockLLM,
    config: { cwd, maxSteps: 4 },
  });

  const result = await agent.run("find package.json in repo");
  assert.equal(result.finished, true);
  assert.ok(result.steps >= 2);

  const searchIdx = result.stepDetails.findIndex(
    (d) => d.type === "tool_call" && d.name === "search"
  );
  assert.ok(searchIdx >= 0, "stepDetails should include search tool_call");
  const searchResult = result.stepDetails[searchIdx + 1];
  assert.equal(searchResult?.type, "tool_result");
  assert.equal(searchResult?.isError, false);
  assert.match(
    searchResult!.content,
    /package\.json/i,
    "search should find package.json in cwd"
  );
});
