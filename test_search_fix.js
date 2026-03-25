import { getBuiltinTools } from './dist/tools/index.js';

async function testSearch() {
  console.log('Testing search tool fix...');

  const tools = getBuiltinTools();
  const searchTool = tools.find(t => t.definition.name === 'search');

  if (!searchTool) {
    console.error('Search tool not found');
    return;
  }

  console.log('Found search tool');

  // Test case 1: simple search for "openai" (case insensitive)
  const args = {
    pattern: 'openai',
    case_sensitive: false,
    exclude_hidden: true
  };

  const cwd = process.cwd();

  console.log('Testing with args:', JSON.stringify(args));
  console.log('cwd:', cwd);

  try {
    // Set a timeout for the search
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Search timeout after 10 seconds')), 10000);
    });

    const searchPromise = searchTool.handler(args, { cwd });
    const result = await Promise.race([searchPromise, timeoutPromise]);

    console.log('Search completed successfully');
    console.log('Result:', result);
  } catch (error) {
    console.error('Search failed:', error.message);
    console.error('Full error:', error);
  }
}

testSearch().catch(console.error);