/**
 * Full-screen picker: choose a user message; transcript rolls back to before it.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { findUserMessageIndices } from "../rewind-transcript.js";
import type { RewindSubScreenContext } from "./sub-screen-types.js";

function previewLine(content: string, max: number): string {
  const one = content.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  return one.slice(0, max - 1) + "…";
}

export interface RewindScreenProps {
  context: RewindSubScreenContext;
  onClose: () => void;
  /** 按时间顺序的第几条用户消息（0 = 最早一条） */
  onConfirm: (userTurnIndexFromStart: number) => void;
}

export function RewindScreen({ context, onClose, onConfirm }: RewindScreenProps) {
  const { messages } = context;
  const userIdx = useMemo(() => findUserMessageIndices(messages), [messages]);
  const termCols = Math.max(40, process.stdout.columns || 72);
  const termRows = Math.max(12, process.stdout.rows || 24);
  const previewMax = Math.max(20, termCols - 16);
  const listPageSize = Math.max(4, termRows - 9);

  const rows = useMemo(
    () =>
      userIdx.map((msgIndex, turnIndex) => ({
        turnIndex,
        preview: previewLine(messages[msgIndex]!.content, previewMax),
      })),
    [messages, userIdx, previewMax]
  );

  const [cursor, setCursor] = useState(() => {
    const n = findUserMessageIndices(context.messages).length;
    return n > 0 ? n - 1 : 0;
  });
  const [scrollTop, setScrollTop] = useState(0);

  useEffect(() => {
    if (rows.length === 0) {
      setCursor(0);
      setScrollTop(0);
      return;
    }
    setCursor((c) => Math.min(Math.max(0, c), rows.length - 1));
  }, [rows.length]);

  useEffect(() => {
    if (rows.length === 0) {
      setScrollTop(0);
      return;
    }
    const maxTop = Math.max(0, rows.length - listPageSize);
    setScrollTop((top) => {
      let t = top;
      if (cursor < t) t = cursor;
      if (cursor >= t + listPageSize) t = cursor - listPageSize + 1;
      return Math.max(0, Math.min(t, maxTop));
    });
  }, [cursor, rows.length, listPageSize]);

  const commit = useCallback(() => {
    if (rows.length === 0) return;
    onConfirm(rows[cursor]!.turnIndex);
  }, [rows, cursor, onConfirm]);

  useInput(
    (input, key) => {
      if (key.escape || (input === "q" && !key.return)) {
        onClose();
        return;
      }
      if (rows.length === 0) return;
      if (key.return) {
        commit();
        return;
      }
      if (key.upArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow) {
        setCursor((c) => Math.min(rows.length - 1, c + 1));
        return;
      }
      if (key.pageUp || key.leftArrow) {
        setCursor((c) => Math.max(0, c - listPageSize));
        return;
      }
      if (key.pageDown || key.rightArrow) {
        setCursor((c) => Math.min(rows.length - 1, c + listPageSize));
        return;
      }
    },
    { isActive: true }
  );

  const visible = rows.slice(scrollTop, scrollTop + listPageSize);

  return (
    <Box flexDirection="column" padding={1} width={termCols}>
      <Text bold color="cyan">
        回退位置 — 选择从哪条用户消息起丢弃（含该句及之后整段）
      </Text>
      <Text dimColor>↑↓ 移动 · Enter 确认 · Esc / q 取消</Text>
      <Box height={1} />
      {rows.length === 0 ? (
        <Text dimColor>没有用户消息</Text>
      ) : (
        <>
          {visible.map((r, i) => {
            const globalI = scrollTop + i;
            const mark = globalI === cursor ? "› " : "  ";
            const dim = globalI === cursor ? false : true;
            const label = `#${r.turnIndex + 1}`;
            return (
              <Box key={r.turnIndex} flexDirection="column" marginBottom={0}>
                <Text dimColor={dim}>
                  {mark}
                  {label}
                  {"  "}
                  {r.preview}
                </Text>
              </Box>
            );
          })}
          {rows.length > listPageSize ? (
            <Text dimColor>
              {scrollTop + 1}-{Math.min(scrollTop + listPageSize, rows.length)} / {rows.length}
            </Text>
          ) : null}
        </>
      )}
    </Box>
  );
}
