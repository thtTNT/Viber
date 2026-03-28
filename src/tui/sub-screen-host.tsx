/**
 * Renders the correct full-screen panel for `OpenSubScreenRequest`.
 * Register new screens by adding a branch here (and the type in sub-screen-types.ts).
 */

import React from "react";
import type { Session } from "../session-store.js";
import {
  SUB_SCREEN_SESSION,
  SUB_SCREEN_CONFIG,
  SUB_SCREEN_REWIND,
  type OpenSubScreenRequest,
} from "./sub-screen-types.js";
import { SessionManagerScreen } from "./session-manager-screen.js";
import { ConfigScreen } from "./config-screen.js";
import { RewindScreen } from "./rewind-screen.js";

export type SubScreenHostProps = {
  request: OpenSubScreenRequest;
  onClose: () => void;
  onResume: (session: Session) => void;
  onCurrentSessionRename: (name: string | undefined) => void;
  /** 按时间顺序的用户消息下标（与 `sliceToBeforeUserTurnIndex` 一致） */
  onRewindToUserTurn: (userTurnIndexFromStart: number) => void;
};

export function SubScreenHost({
  request,
  onClose,
  onResume,
  onCurrentSessionRename,
  onRewindToUserTurn,
}: SubScreenHostProps) {
  if (request.id === SUB_SCREEN_SESSION) {
    return (
      <SessionManagerScreen
        context={request.context}
        onClose={onClose}
        onResume={onResume}
        onCurrentSessionRename={onCurrentSessionRename}
      />
    );
  }
  if (request.id === SUB_SCREEN_CONFIG) {
    return <ConfigScreen onClose={onClose} />;
  }
  if (request.id === SUB_SCREEN_REWIND) {
    return (
      <RewindScreen
        context={request.context}
        onClose={onClose}
        onConfirm={(userTurnIndexFromStart) => {
          onRewindToUserTurn(userTurnIndexFromStart);
        }}
      />
    );
  }
  return null;
}
