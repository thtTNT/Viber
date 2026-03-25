/**
 * Full-screen session list: resume, rename, delete, export, details.
 * Input via useInput (isActive) — main chat input is disabled while this is open.
 */

import React, { useCallback, useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  listSessions,
  loadSession,
  deleteSession,
  renameSession,
  exportSessionToMarkdown,
  cloneSessionForResume,
  dedupeSessionIndex,
  type Session,
  type SessionSummary,
} from "../session-store.js";
import type { SessionSubScreenContext } from "./sub-screen-types.js";

/** 管理器里加载的最近会话条数（仅影响列表数据源，展示由视口分页） */
const SESSION_LIST_LOAD_LIMIT = 400;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

type ScreenMode =
  | { type: "list" }
  | { type: "detail"; session: Session }
  | { type: "renameRow"; sessionId: string }
  | { type: "renameCurrent" }
  | { type: "confirmDelete"; summary: SessionSummary };

export interface SessionManagerScreenProps {
  context: SessionSubScreenContext;
  onClose: () => void;
  onResume: (session: Session) => void;
  /** After renaming the in-memory conversation’s display name (disk updated here). */
  onCurrentSessionRename: (name: string | undefined) => void;
}

export function SessionManagerScreen({
  context,
  onClose,
  onResume,
  onCurrentSessionRename,
}: SessionManagerScreenProps) {
  const workspaceCwd = context.cwd;
  const [items, setItems] = useState<SessionSummary[]>(() => {
    dedupeSessionIndex(workspaceCwd);
    return listSessions(SESSION_LIST_LOAD_LIMIT, workspaceCwd);
  });
  const [cursor, setCursor] = useState(0);
  /** 列表视口内第一条在 `items` 中的下标 */
  const [scrollTop, setScrollTop] = useState(0);
  const [mode, setMode] = useState<ScreenMode>({ type: "list" });
  const [renameBuffer, setRenameBuffer] = useState("");
  const [toast, setToast] = useState("");

  const termRows = Math.max(12, process.stdout.rows || 24);
  const termCols = Math.max(40, process.stdout.columns || 72);
  /** 每条会话占 2 行；为页眉、分页提示行、页脚、toast 预留行数 */
  const listPageSize = Math.max(
    3,
    Math.floor((termRows - 12) / 2)
  );

  const refresh = useCallback(() => {
    dedupeSessionIndex(workspaceCwd);
    setItems(listSessions(SESSION_LIST_LOAD_LIMIT, workspaceCwd));
  }, [workspaceCwd]);

  useEffect(() => {
    if (items.length === 0) {
      setCursor(0);
      setScrollTop(0);
      return;
    }
    setCursor((c) => Math.min(Math.max(0, c), items.length - 1));
  }, [items.length]);

  useEffect(() => {
    if (items.length === 0) {
      setScrollTop(0);
      return;
    }
    const maxTop = Math.max(0, items.length - listPageSize);
    setScrollTop((top) => {
      let t = top;
      if (cursor < t) t = cursor;
      if (cursor >= t + listPageSize) t = cursor - listPageSize + 1;
      return Math.max(0, Math.min(t, maxTop));
    });
  }, [cursor, items.length, listPageSize]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
  }, []);

  const selected = items.length > 0 ? items[cursor] : undefined;

  const commitRenameRow = useCallback(() => {
    if (mode.type !== "renameRow") return;
    const id = mode.sessionId;
    const name = renameBuffer.trim();
    if (!renameSession(id, name, workspaceCwd)) {
      showToast("重命名失败（会话不存在）");
      setMode({ type: "list" });
      setRenameBuffer("");
      return;
    }
    showToast(name ? `已重命名: ${truncate(name, 40)}` : "已清除显示名");
    setMode({ type: "list" });
    setRenameBuffer("");
    refresh();
  }, [mode, renameBuffer, refresh, showToast, workspaceCwd]);

  const commitRenameCurrent = useCallback(() => {
    if (mode.type !== "renameCurrent") return;
    const id = context.activeSessionId;
    if (!id) {
      showToast("当前无会话 id，无法重命名");
      setMode({ type: "list" });
      setRenameBuffer("");
      return;
    }
    const name = renameBuffer.trim();
    const ok = renameSession(id, name, workspaceCwd, { createIfMissing: true });
    if (!ok) {
      showToast("重命名失败");
      setMode({ type: "list" });
      setRenameBuffer("");
      return;
    }
    const loaded = loadSession(id, workspaceCwd);
    onCurrentSessionRename(loaded?.name?.trim() ? loaded.name : undefined);
    showToast(loaded?.name ? `当前会话显示名: ${loaded.name}` : "已清除当前会话显示名");
    setMode({ type: "list" });
    setRenameBuffer("");
    refresh();
  }, [
    mode.type,
    context.activeSessionId,
    renameBuffer,
    refresh,
    showToast,
    onCurrentSessionRename,
    workspaceCwd,
  ]);

  const runExport = useCallback(() => {
    if (!selected) {
      showToast("列表为空");
      return;
    }
    const full = loadSession(selected.id, workspaceCwd);
    if (!full) {
      showToast("无法加载会话文件");
      return;
    }
    const path = join(process.cwd(), `${selected.id}.md`);
    try {
      writeFileSync(path, exportSessionToMarkdown(full), "utf-8");
      showToast(`已导出: ${path}`);
    } catch (e) {
      showToast(`导出失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [selected, showToast, workspaceCwd]);

  const runResume = useCallback(() => {
    if (!selected) {
      showToast("列表为空");
      return;
    }
    const full = loadSession(selected.id, workspaceCwd);
    if (!full) {
      showToast("无法加载会话");
      return;
    }
    onResume(cloneSessionForResume(full));
    onClose();
  }, [selected, onResume, onClose, showToast, workspaceCwd]);

  const runDelete = useCallback(
    (summary: SessionSummary) => {
      const ok = deleteSession(summary.id, workspaceCwd);
      if (ok) {
        showToast(`已删除: ${truncate(summary.id, 32)}`);
        refresh();
      } else {
        showToast("删除失败或文件不存在");
      }
      setMode({ type: "list" });
    },
    [refresh, showToast, workspaceCwd]
  );

  useInput(
    (input, key) => {
      if (mode.type === "renameRow" || mode.type === "renameCurrent") {
        if (key.escape) {
          setMode({ type: "list" });
          setRenameBuffer("");
          return;
        }
        if (key.return) {
          if (mode.type === "renameRow") commitRenameRow();
          else commitRenameCurrent();
          return;
        }
        if (key.backspace || key.delete) {
          setRenameBuffer((b) => b.slice(0, -1));
          return;
        }
        if (input && !key.ctrl && !key.meta) {
          setRenameBuffer((b) => b + input);
        }
        return;
      }

      if (mode.type === "confirmDelete") {
        if (input === "y" || input === "Y") {
          runDelete(mode.summary);
          return;
        }
        if (input === "n" || input === "N" || key.escape) {
          setMode({ type: "list" });
        }
        return;
      }

      if (mode.type === "detail") {
        if (key.escape || input === "q") {
          setMode({ type: "list" });
        }
        return;
      }

      // list
      if (key.escape || (input === "q" && !key.return)) {
        onClose();
        return;
      }
      if (input === "l") {
        refresh();
        showToast("列表已刷新");
        return;
      }
      if (input === "?" || input === "h") {
        showToast("↑↓ 单项 · ←→ 翻页 · Enter r d i e n l q");
        return;
      }
      if (input === "i") {
        if (!selected) {
          showToast("无选中项");
          return;
        }
        const full = loadSession(selected.id, workspaceCwd);
        if (!full) {
          showToast("无法加载详情");
          return;
        }
        setMode({ type: "detail", session: full });
        return;
      }
      if (input === "r") {
        if (!selected) {
          showToast("列表为空");
          return;
        }
        const full = loadSession(selected.id, workspaceCwd);
        setRenameBuffer(full?.name?.trim() ? full.name : "");
        setMode({ type: "renameRow", sessionId: selected.id });
        return;
      }
      if (input === "n") {
        setRenameBuffer(context.activeSessionName?.trim() ? context.activeSessionName : "");
        setMode({ type: "renameCurrent" });
        return;
      }
      if (input === "d") {
        if (!selected) {
          showToast("列表为空");
          return;
        }
        setMode({ type: "confirmDelete", summary: selected });
        return;
      }
      if (input === "e") {
        runExport();
        return;
      }
      if (key.return) {
        runResume();
        return;
      }
      if (key.upArrow) {
        setCursor((c) => (items.length === 0 ? 0 : Math.max(0, c - 1)));
        return;
      }
      if (key.downArrow) {
        setCursor((c) =>
          items.length === 0 ? 0 : Math.min(items.length - 1, c + 1)
        );
        return;
      }
      if (key.pageUp || key.leftArrow) {
        setCursor((c) =>
          items.length === 0 ? 0 : Math.max(0, c - listPageSize)
        );
        return;
      }
      if (key.pageDown || key.rightArrow) {
        setCursor((c) =>
          items.length === 0
            ? 0
            : Math.min(items.length - 1, c + listPageSize)
        );
        return;
      }
    },
    {
      isActive: true,
    }
  );

  if (mode.type === "detail") {
    const s = mode.session;
    const detailLines = [
      `ID: ${s.id}`,
      s.name ? `Name: ${s.name}` : "Name: —",
      `Created: ${new Date(s.createdAt).toLocaleString()}`,
      `Updated: ${new Date(s.updatedAt).toLocaleString()}`,
      `Mode: ${s.mode}  Model: ${s.model}`,
      `Messages: ${s.messages.length}  Steps: ${s.stepCount}`,
      `Finished: ${s.finished ? "yes" : "no"}`,
      `CWD: ${truncate(s.cwd, termCols - 6)}`,
      "",
      "q / Esc 返回",
    ];
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>会话详情</Text>
        <Text dimColor>{truncate(s.id, termCols - 2)}</Text>
        <Text> </Text>
        {detailLines.map((line, i) => (
          <Text key={i}>{truncate(line, termCols)}</Text>
        ))}
      </Box>
    );
  }

  if (mode.type === "confirmDelete") {
    const s = mode.summary;
    const isCurrent = s.id === context.activeSessionId;
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="red">
          确认删除？
        </Text>
        <Text>{truncate(s.id, termCols - 2)}</Text>
        {isCurrent ? (
          <Text dimColor>
            这是当前对话的存档；删除后仍可继续聊天，但无法再从此文件恢复该记录。
          </Text>
        ) : null}
        <Text> </Text>
        <Text>y 确认删除 · n / Esc 取消</Text>
      </Box>
    );
  }

  if (mode.type === "renameRow" || mode.type === "renameCurrent") {
    const label =
      mode.type === "renameRow" ? "重命名选中会话" : "重命名当前对话（显示名）";
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>{label}</Text>
        <Text dimColor>Enter 保存 · Esc 取消</Text>
        <Text> </Text>
        <Text>
          {renameBuffer || "〈空则清除显示名〉"}
          <Text inverse> </Text>
        </Text>
      </Box>
    );
  }

  const header =
    items.length > 0
      ? `会话管理（已加载 ${items.length} 条，最多 ${SESSION_LIST_LOAD_LIMIT}）`
      : "会话管理";
  const currentLabel = context.activeSessionId
    ? truncate(
        context.activeSessionName
          ? `${context.activeSessionName} · ${context.activeSessionId}`
          : context.activeSessionId,
        termCols - 4
      )
    : "(无当前会话 id)";

  // list
  const lines: React.ReactNode[] = [];
  lines.push(
    <Text key="h1" bold>
      {header}
    </Text>
  );
  lines.push(
    <Text key="h2" dimColor>
      当前对话: {currentLabel}
    </Text>
  );
  lines.push(<Text key="sp0"> </Text>);

  if (items.length === 0) {
    lines.push(<Text key="empty">暂无已保存会话（完成至少一轮对话后会写入磁盘）。</Text>);
  } else {
    const visibleEnd = Math.min(items.length, scrollTop + listPageSize);
    if (items.length > listPageSize) {
      lines.push(
        <Text key="range" dimColor>
          可视第 {scrollTop + 1}–{visibleEnd} 条 / 共 {items.length} 条 · ←→ 或 PgUp/PgDn 翻页
        </Text>
      );
    }
    for (let i = scrollTop; i < visibleEnd; i++) {
      const it = items[i]!;
      const isSel = i === cursor;
      const isCurrent = it.id === context.activeSessionId;
      const icon = it.mode === "interactive" ? "💬" : "⚡";
      const title = it.name?.trim()
        ? `${icon} ${it.name}`
        : `${icon} ${truncate(it.id, termCols - 8)}`;
      const meta = `${new Date(it.createdAt).toLocaleString()} · ${it.messageCount} msg · ${it.stepCount} steps`;
      const prefix = isSel ? "› " : "  ";
      const row = (
        <Text key={`row-${i}`} bold={isSel} inverse={isSel}>
          {prefix}
          {isCurrent ? "★ " : ""}
          {truncate(title, termCols - 6)}
        </Text>
      );
      lines.push(row);
      lines.push(
        <Text key={`row-${i}-meta`} dimColor>
          {prefix} {truncate(meta, termCols - 4)}
        </Text>
      );
    }
  }

  lines.push(<Text key="sp1"> </Text>);
  lines.push(
    <Text key="help" dimColor>
      ↑↓ 选择 · ←→ 翻页（Mac）· PgUp/PgDn 亦可 · Enter 恢复 · r 重命名 · d 删除 · i 详情 · e 导出
    </Text>
  );
  lines.push(
    <Text key="help2" dimColor>
      n 重命名当前对话 · l 刷新 · q/Esc 返回聊天
    </Text>
  );
  if (toast) {
    lines.push(<Text key="toast"> </Text>);
    lines.push(
      <Text key="toastm" color="cyan">
        {truncate(toast, termCols - 2)}
      </Text>
    );
  }

  return <Box flexDirection="column">{lines}</Box>;
}
