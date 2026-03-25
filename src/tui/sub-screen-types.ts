/**
 * Contract for full-screen TUI panels opened from slash-commands.
 *
 * 扩展步骤：
 * 1. 在此文件增加新的 `id` 常量和 `context` 类型，并把 `OpenSubScreenRequest` 改为联合类型。
 * 2. 在 `sub-screen-host.tsx` 里为新的 `id` 增加分支并渲染对应组件。
 * 3. 在 `commands.ts` 里让某条命令返回 `{ openSubScreen: { id, context } }`。
 * 4. `cli/ink-app.tsx` 已在有 `openSubScreen` 时挂载 `SubScreenHost`，一般无需改。
 */

export const SUB_SCREEN_SESSION = "session" as const;

export type SessionSubScreenContext = {
  activeSessionId: string;
  activeSessionName?: string;
  /** Workspace root: session files under `<cwd>/.viber/sessions/` */
  cwd: string;
};

export type OpenSubScreenRequest = {
  id: typeof SUB_SCREEN_SESSION;
  context: SessionSubScreenContext;
};
