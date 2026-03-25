/**
 * Renders the correct full-screen panel for `OpenSubScreenRequest`.
 * Register new screens by adding a branch here (and the type in sub-screen-types.ts).
 */

import React from "react";
import type { Session } from "../session-store.js";
import { SUB_SCREEN_SESSION, type OpenSubScreenRequest } from "./sub-screen-types.js";
import { SessionManagerScreen } from "./session-manager-screen.js";

export type SubScreenHostProps = {
  request: OpenSubScreenRequest;
  onClose: () => void;
  onResume: (session: Session) => void;
  onCurrentSessionRename: (name: string | undefined) => void;
};

export function SubScreenHost({
  request,
  onClose,
  onResume,
  onCurrentSessionRename,
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
  return null;
}
