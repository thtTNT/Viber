import { createAgent } from "./dist/index.js";
import { createLLMClient } from "./dist/llm/openai.js";

async function testSearch() {
  console.log("Testing search functionality...");
  
  // Create a mock LLM client that will call the search tool
  const mockLLM = {
    async chatWithTools(messages, tools, options) {
      console.log("Mock LLM called with tools:", tools.map(t => t.function.name));
      
      // Find the search tool
      const searchTool = tools.find(t => t.function.name === "search");
      if (!searchTool) {
        throw new Error("Search tool not found");
      }
      
      // Return a tool call for search
      return {
        message: {
          content: "",
          toolCalls: [
            {
              id: "test-1",
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

  const agent = createAgent({
    llm: mockLLM,
    config: {
      cwd: "/tmp"
    }
  });

  try {
    const result = await agent.run("Search for files containing 'search pattern'");
    console.log("Result:", result);
  } catch (error) {
    console.error("Error:", error);
  }
}

testSearch();