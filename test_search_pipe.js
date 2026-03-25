import { getBuiltinTools } from './dist/tools/index.js';

async function testSearchWithPipe() {
  console.log('Testing search tool with pipe character...');

  const tools = getBuiltinTools();
  const searchTool = tools.find(t => t.definition.name === 'search');

  if (!searchTool) {
    console.error('Search tool not found');
    return;
  }

  console.log('Found search tool');

  // Test case: search pattern with pipe (regex alternation)
  const args = {
    pattern: 'OpenAI|openai|GPT|gpt|ChatGPT|chatgpt',
    case_sensitive: false,
    exclude_hidden: true
  };

  const cwd = process.cwd();

  console.log('Testing with args:', JSON.stringify(args));
  console.log('cwd:', cwd);

  try {
    // Set a timeout for the search
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Search timeout after 15 seconds')), 15000);
    });

    const searchPromise = searchTool.handler(args, { cwd });
    const result = await Promise.race([searchPromise, timeoutPromise]);

    console.log('Search completed successfully');
    console.log('Result length:', result.length);
    console.log('First 500 chars of result:', result.slice(0, 500));
  } catch (error) {
    console.error('Search failed:', error.message);
    console.error('Full error:', error);
  }
}

testSearchWithPipe().catch(console.error);