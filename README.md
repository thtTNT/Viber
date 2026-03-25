# VIBER

> 🚀 简单、灵活、可扩展的 Coding Agent 框架

基于 Node.js 的最小化 coding agent 框架：接收自然语言任务 → 调用 LLM 规划 → 执行工具（读/写文件、执行命令等）→ 循环直到完成。

## 要求

- Node.js >= 18
- OpenAI API Key（默认使用 GPT-4o-mini，可配置其他模型）
- **npm 或 yarn** - 用于安装依赖（或使用 pnpm）
- TypeScript 5.x（开发时需要）
- **ripgrep (rg)** - 用于搜索功能（可选，如无则搜索功能不可用）

## 安装

```bash
npm install
```

### 安装 ripgrep（macOS）

```bash
brew install ripgrep
```

### 安装 ripgrep（Ubuntu/Debian）

```bash
sudo apt-get install ripgrep
```

## 配置说明

### 方式一：配置文件（推荐）

在 `~/.viber/config.json` 中配置：

```json
{
  "API_KEY": "sk-your-key",
  "BASE_URL": "https://api.openai.com/v1",
  "MODEL": "gpt-4o-mini"
}
```

**配置项说明：**

| 配置项 | 说明 | 是否必填 |
|--------|------|----------|
| `API_KEY` | LLM API 密钥 | 是 |
| `BASE_URL` | API 基础 URL（代理、Azure、OpenRouter、本地兼容服务等） | 否 |
| `MODEL` | 使用的模型名称 | 否 |

**自定义 API 地址示例：**

```json
{
  "API_KEY": "your-key",
  "BASE_URL": "https://openrouter.ai/api/v1",
  "MODEL": "openai/gpt-4o-mini"
}
```

或本地服务：

```json
{
  "API_KEY": "not-needed",
  "BASE_URL": "http://localhost:11434/v1",
  "MODEL": "llama2"
}
```

### 方式二：环境变量（兼容旧版）

如果配置文件不存在，会回退到环境变量：

```bash
export OPENAI_API_KEY=sk-your-key
export OPENAI_BASE_URL=https://your-gateway/v1
export OPENAI_MODEL=gpt-4o-mini
```

环境变量优先级低于配置文件。

## 使用

### 命令行

```bash
npm run dev -- "列出当前目录下的所有文件"
# 或
npx tsx src/cli/cli.ts "Create a hello.txt file with content Hello World"
```

### 代码调用

```ts
import { createAgent } from "./src/index.js";
import { createOpenAIClient } from "./src/llm/index.js";
import { loadConfig } from "./src/config.js";

// 从配置文件加载
const config = loadConfig();

const llm = createOpenAIClient({
  apiKey: config.API_KEY,
  baseURL: config.BASE_URL,
});
const agent = createAgent({
  llm,
  config: { 
    cwd: process.cwd(), 
    maxSteps: 15,
    model: config.MODEL,
  },
});

const result = await agent.run("在 src 目录下创建一个 hello.ts 文件，内容为 console.log('hi')");
console.log(result.message);
console.log("Steps:", result.steps, "Finished:", result.finished);
```

从 npm 安装本包时，可使用 `package.json` 的 `exports` 子路径，例如：`import { createOpenAIClient } from "viber-agent/llm"`、`import { getBuiltinTools } from "viber-agent/tools"`。

## 内置工具

| 工具 | 说明 |
|------|------|
| `read_file` | 读取文件内容 |
| `write_file` | 写入文件（自动创建目录） |
| `list_dir` | 列出目录内容 |
| `run_shell` | 执行 shell 命令 |
| `search` | **新增**：使用 ripgrep (rg) 搜索文本，返回匹配行及文件路径和行号 |

### 搜索工具参数

```json
{
  "pattern": "搜索模式（文本或正则表达式）",
  "path": "可选的目录或文件路径（默认：当前工作目录）",
  "case_sensitive": "布尔值，是否区分大小写（默认：false）",
  "exclude_hidden": "布尔值，是否排除隐藏文件和目录（默认：true）"
}
```

## 扩展

- **自定义 system prompt**：传入 `systemPrompt`。
- **自定义工具**：传入 `extraTools: [{ definition, handler }]`。
- **更换 LLM**：实现 `LLMClientWithTools` 接口（见 `src/llm/types.ts`），传入 `createAgent({ llm: yourClient })`。

## 项目结构

```
src/
  agent.ts      # 主循环与 run()
  types.ts      # 消息、工具等类型
  cli/          # 命令行与 Ink TUI（入口 cli/cli.ts）
  config.ts     # 配置文件加载
  llm/          # LLM 抽象与 OpenAI 实现
  tools/        # 内置工具
```

## 构建

```bash
npm run build
npm start -- "your task"
```

## 示例：使用搜索功能

```bash
# 搜索当前目录中包含 "TODO" 的文件
npm run dev -- "Search for TODO in the current directory"

# 在 src 目录中搜索 "function createAgent"（区分大小写）
npm run dev -- "Find all occurrences of 'function createAgent' in src directory with case-sensitive search"

# 搜索包含 "error" 的 TypeScript 文件
npm run dev -- "Search for 'error' in TypeScript files (.ts, .tsx)"
```

**注意**：搜索功能依赖 ripgrep (rg)。如果系统中没有安装 rg，搜索工具会返回错误信息。
