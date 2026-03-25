import { getBuiltinTools } from './dist/tools/index.js';

async function debugSearch() {
  console.log('Debugging search tool...');

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

  // 直接复制 search 工具的 handler 代码并添加调试信息
  const pattern = args.pattern;
  const path = args.path;
  const caseSensitive = args.case_sensitive;
  const excludeHidden = args.exclude_hidden ?? true;

  console.log('\n--- Inside handler ---');
  console.log('pattern:', pattern);
  console.log('caseSensitive:', caseSensitive);
  console.log('excludeHidden:', excludeHidden);

  // Build rg command arguments
  const argsList = [];

  // Add options
  argsList.push("--no-heading");
  argsList.push("--line-number");
  argsList.push("--no-messages"); // Suppress permission errors

  if (caseSensitive === false) {
    argsList.push("--ignore-case");
  } else if (caseSensitive === true) {
    argsList.push("--case-sensitive");
  }

  if (excludeHidden === false) {
    argsList.push("--hidden");
  }
  // When excludeHidden is true (default), ripgrep already excludes hidden files
  // No need to add glob patterns as they might cause performance issues

  // Add pattern (need to handle special characters)
  argsList.push(pattern);

  // Add path if provided
  if (path) {
    const fullPath = path.startsWith("/") ? path : cwd + '/' + path;
    argsList.push(fullPath);
  }

  // Construct command string for exec
  const command = `rg ${argsList.map(arg => {
    // Escape single quotes and wrap in single quotes if contains spaces or special chars
    if (arg.includes(" ") || arg.includes("'") || arg.includes("$") || arg.includes("\\") || arg.includes("!")) {
      return `'${arg.replace(/'/g, "'\"'\"'")}'`;
    }
    return arg;
  }).join(" ")}`;

  console.log('rg argsList:', argsList);
  console.log('rg command:', command);

  // 实际执行
  const { exec } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execAsync = promisify(exec);

  try {
    console.log('\n--- Executing rg command ---');
    const startTime = Date.now();
    const { stdout, stderr } = await execAsync(command, {
      cwd: cwd,
      maxBuffer: 2 * 1024 * 1024,
      shell: "/bin/bash",
      timeout: 5000  // 5秒超时
    });
    const endTime = Date.now();
    console.log(`rg completed in ${endTime - startTime}ms`);

    if (stderr) {
      console.log('rg stderr:', stderr);
      console.log('Result would be:', `Search error: ${stderr}\n${stdout || "(no results)"}`);
      return;
    }

    const result = stdout.trim();
    console.log('rg result lines:', result.split('\n').length);
    console.log('Result would be:', result || "No matches found.");
  } catch (error) {
    console.log('rg error:', error.message);
    console.log('error code:', error.code);
    console.log('error stdout:', error.stdout);
    console.log('error stderr:', error.stderr);

    if (error.code === 1 && error.stdout === '' && error.stderr === '') {
      console.log('Result would be:', "No matches found.");
      return;
    }
    if (error.code === 1 && error.stderr && error.stderr.includes("Permission denied")) {
      if (error.stdout && error.stdout.trim()) {
        console.log('Result would be:', error.stdout.trim());
        return;
      }
      console.log('Result would be:', "No matches found (some files were inaccessible).");
      return;
    }
    console.log('Result would be:', `Search failed: ${error.message}`);
  }
}

debugSearch().catch(console.error);