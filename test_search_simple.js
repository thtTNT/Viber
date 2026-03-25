#!/usr/bin/env node

import { createAgent } from "./dist/index.js";

// 创建一个模拟LLM客户端，专门调用search工具
const mockLLM = {
  async chatWithTools(messages, tools, options) {
    console.log("Available tools:", tools.map(t => t.function.name));
    
    // 检查是否有search工具
    const hasSearchTool = tools.some(t => t.function.name === "search");
    console.log("Has search tool:", hasSearchTool);
    
    // 返回search工具调用
    return {
      message: {
        content: "Searching for pattern in /tmp directory...",
        toolCalls: [
          {
            id: "test-search-1",
            name: "search",
            arguments: JSON.stringify({
              pattern: "search pattern",
              path: "/tmp",
              case_sensitive: false
            })
          }
        ]
      },
      finishReason: "tool_calls"
    };
  }
};

async function main() {
  console.log("Testing search functionality...\n");
  
  const agent = createAgent({
    llm: mockLLM,
    config: {
      cwd: "/tmp",
      maxSteps: 2
    }
  });

  try {
    const result = await agent.run("Search for 'search pattern' in /tmp directory");
    console.log("\n=== Search Test Results ===");
    console.log("Steps taken:", result.steps);
    console.log("Finished:", result.finished);
    console.log("Final message:", result.message);
    
    // 查看工具调用的详细信息
    if (result.stepDetails && result.stepDetails.length > 0) {
      console.log("\n=== Tool Execution Details ===");
      result.stepDetails.forEach((detail, i) => {
        if (detail.type === "tool_call") {
          console.log(`Step ${i + 1}: Tool Call - ${detail.name}`);
          console.log(`  Args: ${detail.args}`);
        } else if (detail.type === "tool_result") {
          console.log(`Step ${i + 1}: Tool Result`);
          console.log(`  Content: ${detail.content.substring(0, 200)}...`);
        }
      });
    }
  } catch (error) {
    console.error("Error during search test:", error);
  }
}

main().catch(console.error);