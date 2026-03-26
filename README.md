# VIBER

> 一个面向终端的 Node.js Coding Agent：交互式 TUI、会话管理、MCP 扩展、审计日志。

Viber 是一个基于 **Node.js + TypeScript** 的 coding agent 框架与 CLI。它可以在当前工作区中接收自然语言任务，调用 LLM 做规划，并通过工具读写文件、执行 shell、搜索代码，直到完成任务。

当前版本重点能力：

- **交互式 Ink TUI**：默认以聊天界面运行，而不是一次性命令模式
- **会话持久化**：自动保存到工作区 `.viber/sessions/`
- **会话管理**：支持恢复、重命名、删除、导出
- **上下文压缩**：通过 `/summary` 将历史对话替换为摘要
- **MCP 支持**：从工作区 `.viber/config.json` 加载 MCP 服务，并桥接为工具
- **审计日志**：每次会话都会生成 `upstream.log` / `upstream.jsonl`
- **可编程扩展**：可作为库使用，自定义 LLM、system prompt、额外工具

## 环境要求

- Node.js **>= 18**
- 一个可用的 OpenAI 兼容接口
- `npm`（也可自行换成其他包管理器）
- 可选：`ripgrep (rg)`，用于 `search` 搜索工具

## 安装

### 从 npm 安装（推荐）

全局安装后，终端里可使用命令 **`viber`** 或 **`viber-agent`**（两者等价）：

```bash
npm install -g viber-agent
viber
# 或
viber-agent
```

不全局安装、临时试用：

```bash
npx viber-agent
```

> npm 上已有名为 `viber` 的其他包，本项目的 **包名** 为 `viber-agent`；CLI 仍保留短命令 `viber`。

### 从源码开发（本仓库）

```bash
git clone <你的仓库地址>
cd Viber
npm install
npm run build
```

开发运行（无需先 build）：

```bash
npm run dev
```

仅构建：

```bash
npm run build
```

构建后运行：

```bash
npm start
```

## 快速开始

首次使用请运行 **Boarding** 交互向导，按提示填写并写入 `~/.viber/config.json`（API Key、Base URL、模型等）：

```bash
# 已全局安装
viber --boarding

# 从 npm 临时运行
npx viber-agent --boarding

# 本仓库源码
npm run boarding
```

完成后在同一终端执行下面的命令即可进入 TUI。

## CLI 用法

默认启动 **交互式 TUI**：

```bash
viber
# 或（未全局安装）
npx viber-agent
```

本仓库开发时：

```bash
npm run dev
```

恢复之前的会话：

```bash
viber --resume <session-id>
# 源码开发时：
npx tsx src/cli/cli.ts --resume <session-id>
```

查看版本：

```bash
viber --version
```

## TUI 内置命令

当前交互界面支持这些 slash commands：

- `/status`：查看当前模型、API URL、工作目录等配置
- `/help`：查看所有命令
- `/model`：列出可用模型，或切换模型
- `/context` / `/ctx`：查看最近一次 API usage 与当前对话规模
- `/summary [额外说明]`：把当前对话压缩成摘要，并替换模型上下文
- `/session`：打开会话管理器
- `/export <session-id> [output-path]`：导出会话为 Markdown 或 JSON
- `/mcp`：探测工作区 MCP 配置与连接状态
- `/clear`：清空当前对话历史
- `/quit`：退出程序

界面提示里当前展示的是常用命令：`/status /help /session /summary /mcp /clear /quit`。

## 会话与日志

### 会话存储

每个工作区的会话会保存在：

```text
.viber/sessions/
```

会话会记录：

- 消息历史
- step 计数
- 当前模型
- 会话名称
- LLM usage 历史

### 审计日志

每次交互会话都会生成日志目录：

```text
.viber/logs/{timestamp}-{uuid}/
```

其中通常包含：

- `upstream.log`：适合人工阅读的审计日志
- `upstream.jsonl`：适合 `jq` / 管道处理的 NDJSON
- `misc.log`：MCP 子进程 stderr（启用 MCP 时）

可用下面的脚本格式化日志：

```bash
npm run logs:pretty -- path/to/upstream.jsonl
```

### 调试 TUI 输出

如果要调试 TUI stdout：

```bash
VIBER_DEBUG=1 npm run dev
```

会写入：

```text
.viber-debug.log
```

## MCP 配置

Viber 会读取工作区下的：

```text
.viber/config.json
```

目前支持两种形状：

```json
{
  "mcpServers": {
    "fs": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
```

或：

```json
{
  "mcp": {
    "servers": {
      "fs": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
      }
    }
  }
}
```

连接成功后，MCP 工具会以 `mcp__` 前缀桥接给模型使用。

## 内置工具

当前内置工具包括：

| 工具 | 说明 |
| --- | --- |
| `read_file` | 读取文件内容 |
| `write_file` | 创建并写入文件 |
| `list_dir` | 列出目录内容 |
| `run_shell` | 执行 shell 命令 |
| `search` | 使用 `ripgrep` 搜索文本或正则 |

`search` 参数示例：

```json
{
  "pattern": "TODO|FIXME",
  "path": "src",
  "case_sensitive": false,
  "exclude_hidden": true
}
```

> 如果系统没有安装 `rg`，搜索工具会返回错误信息。

## 作为库使用

你也可以把 Viber 当作一个可编程 agent 库来使用。

```ts
import { createAgent } from "./src/index.js";
import { createOpenAIClient } from "./src/llm/index.js";
import { loadConfig } from "./src/config.js";

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

如果作为包使用，也可以走 `exports` 子路径，例如：

- `viber-agent`
- `viber-agent/llm`
- `viber-agent/tools`

## 扩展能力

- 自定义 `systemPrompt`
- 通过 `extraTools` 注入自定义工具
- 替换底层 LLM client
- 通过 MCP 把外部工具系统桥接进来

## 项目结构

```text
src/
  agent.ts                # Agent 主循环
  commands.ts             # Slash commands
  conversation-summary.ts # /summary 实现
  session-store.ts        # 会话持久化
  agent-log.ts            # 审计日志
  cli/                    # Ink TUI 与 CLI 入口
  mcp/                    # MCP 桥接
  llm/                    # LLM 抽象与 OpenAI 实现
  tools/                  # 内置工具
```

## 开发脚本

```bash
npm run dev
npm run build
npm run boarding
npm run test:cli
npm run logs:pretty -- path/to/upstream.jsonl
```

## 备注

- 当前主入口是 **交互式终端 UI**，不再是 README 旧版本里那种“直接传一条任务后退出”的主要模式
- `.viber/config.json` 是 **工作区级 MCP 配置**；**用户级模型配置**由 Boarding 写入 `~/.viber/config.json`
