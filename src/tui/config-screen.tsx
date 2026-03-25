/**
 * Full-screen settings: tool call mode (standard vs PTC).
 */

import React, { useCallback, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  loadConfig,
  saveConfig,
  type ToolCallMode,
} from "../config.js";

export interface ConfigScreenProps {
  onClose: () => void;
}

const MODES: { id: ToolCallMode; label: string; hint: string }[] = [
  {
    id: "standard",
    label: "Standard",
    hint: "每个内置工具单独 tool_call（默认）",
  },
  {
    id: "ptc",
    label: "PTC (sandboxed JS)",
    hint: "run_builtin_tools_code：一段 JS，仅可调内置工具 API（node:vm，尽力隔离）",
  },
];

export function ConfigScreen({ onClose }: ConfigScreenProps) {
  const initial = loadConfig().TOOL_CALL_MODE ?? "standard";
  const startIdx = Math.max(0, MODES.findIndex((m) => m.id === initial));
  const [cursor, setCursor] = useState(startIdx >= 0 ? startIdx : 0);
  const [savedMode, setSavedMode] = useState<ToolCallMode>(initial);

  const applyAndPersist = useCallback((mode: ToolCallMode) => {
    // Only persist TOOL_CALL_MODE — do not spread loadConfig() (merges env API_KEY into the object).
    saveConfig({ TOOL_CALL_MODE: mode });
    setSavedMode(mode);
  }, []);

  useInput(
    (input, key) => {
      if (key.escape || (input === "q" && !key.return)) {
        onClose();
        return;
      }
      if (key.upArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
        setCursor((c) => Math.min(MODES.length - 1, c + 1));
        return;
      }
      if (key.return) {
        const mode = MODES[cursor]!.id;
        applyAndPersist(mode);
        return;
      }
    },
    { isActive: true }
  );

  const termCols = Math.max(40, process.stdout.columns || 72);
  const selected = MODES[cursor]!;

  return (
    <Box flexDirection="column" padding={1} width={termCols}>
      <Text bold color="cyan">
        设置 — Tool call 模式
      </Text>
      <Box height={1} />
      {MODES.map((m, i) => {
        const mark = i === cursor ? "› " : "  ";
        const dim = i === cursor ? false : true;
        return (
          <Box key={m.id} flexDirection="column" marginBottom={0}>
            <Text dimColor={dim}>
              {mark}
              {m.label}
              {savedMode === m.id ? "  ✓ 已保存" : ""}
            </Text>
            <Text dimColor>{`     ${m.hint}`}</Text>
          </Box>
        );
      })}
      <Box height={1} />
      <Text dimColor>↑↓ 选择 · Enter 保存 · q / Esc 关闭</Text>
      <Text dimColor>配置写入 ~/.viber/config.json（TOOL_CALL_MODE）</Text>
      <Box height={1} />
      <Text dimColor>当前选中: {selected.label}</Text>
    </Box>
  );
}
