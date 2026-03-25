# VIBER 交互式 CLI UI 设计

本文档描述 `npm run chat` 的 UI 设计机制。交互界面由 **Ink**（React for CLI）接管，不再手写 draw/clear/tick。

---

## 1. 整体结构

- **Content Zone（内容区）**：历史消息行，用 Ink 的 `<Static>` 渲染，只增不改。
- **Toolbar（工具栏）**：底部固定区域，用 `<Box>` + `<Text>` 渲染 StatusBar（1 行）+ InputBox（3 行）。

```
┌─────────────────────────────────────────────────────────────────┐
│  Content Zone（Static items = contentLines）                     │
│  - 欢迎信息、Human 消息、思考过程、Agent 回复、提示行             │
├─────────────────────────────────────────────────────────────────┤
│  Toolbar（Box + Text）                                           │
│  ┌─ StatusBar（1 行）───────────────────────────────────────────┐ │
│  └─ InputBox（3 行，top + editLineWithCursor + bottom）─────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. 技术栈

- **Ink**：`render()` 挂载根组件，`useInput` 处理按键，`useApp` 提供 `exit()`。
- **状态**：React `useState`（contentLines、inputBuffer、inputCursor、isThinking、showThinking 等）。
- **布局**：`<Box flexDirection="column">`，上为 `<Static items={contentLines}>`，下为 StatusBar + InputBox。
- **无手写 ANSI 布局**：不再自己管理光标、clear、tick；Ink 负责重绘与输入。

---

## 3. 内容区（Content Zone）

- **数据**：`contentLines: string[]`，每行一条。
- **渲染**：`<Static items={contentLines}>`，每项 `<Text key={i}>{line}</Text>`。
- **更新**：提交用户消息时 push `renderUserBlock(input).split('\n')`；Agent 返回后 push `formatAssistantBlock(...)`；/clear 时 push `"History cleared."`。

---

## 4. Toolbar

### 4.1 StatusBar 组件

- **props**：`isThinking`。
- **内部状态**：`dotIndex`（0/1/2 对应 Thinking. / .. / ...）。
- **动效**：`useEffect` + `setInterval(100)` 在 `isThinking` 时更新 `dotIndex`。
- **渲染**：`<Text>{renderStatusBar(statusText).trimEnd()}</Text>`。

### 4.2 InputBox 组件

- **实现**：`ink-text-input`，外部包。
- **props**：`value`、`onChange`、`onSubmit`、`focus`。
- **渲染**：`top()` + `<TextInput>` + `bottom()`。输入、光标、Enter 提交由 ink-text-input 内置处理。

### 4.3 Toolbar 组件

- **props**：`isThinking`、`inputBuffer`、`inputCursor`。
- **渲染**：`<StatusBar />` + `<InputBox />`。按键由 App 的 `useInput` 统一处理。

---

## 5. 快捷键与模式

- **Ctrl+C**：`useApp().exit()` 退出。
- **Enter**：若 `waitContinue` 则清除提示行并回到输入；否则 `submit(inputBuffer)`。
- **Ctrl+T**：在 `waitContinue` 时切换 `showThinking` 并重写最后一条 Assistant 块。
- **/quit、/exit**：调用 `exit()`；**/clear**：清空 `conversationHistory` 并追加 `"History cleared."`。

---

## 6. 文件职责

| 文件 | 职责 |
|------|------|
| cli.ts | 创建 agent、调用 `render(<App runAgent={...} />)`、`waitUntilExit()` |
| cli/ink-app.tsx | 完整交互 UI：宽度/CJK 工具、box/statusBar 渲染、Content Zone + Toolbar 组件、useInput、submit |
