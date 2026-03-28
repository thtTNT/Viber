/**
 * User input strip styling for TUI (shared by live input and transcript replay).
 */

const BOX_WIDTH = Math.max(40, process.stdout.columns || 72);
export const CONTENT_WIDTH = BOX_WIDTH - 4;

const ANSI = {
  reset: "\x1b[0m",
  userBg: "\x1b[48;5;236m\x1b[37m",
} as const;

function charWidth(c: string): number {
  if (c.length === 0) return 0;
  const code = c.codePointAt(0)!;
  if (code >= 0x4e00 && code <= 0x9fff) return 2;
  if (code >= 0x3000 && code <= 0x303f) return 2;
  if (code >= 0xff00 && code <= 0xffef) return 2;
  if (code >= 0xac00 && code <= 0xd7af) return 2;
  return 1;
}

/** East Asian width-aware display width (for padding status lines). */
export function stringDisplayWidth(s: string): number {
  let w = 0;
  for (const c of Array.from(s)) w += charWidth(c);
  return w;
}

function truncateToWidth(s: string, maxCols: number = CONTENT_WIDTH): string {
  const arr = Array.from(s);
  let w = 0;
  let i = 0;
  for (; i < arr.length && w + charWidth(arr[i]!) <= maxCols - 1; i++) {
    w += charWidth(arr[i]!);
  }
  if (i >= arr.length) return s;
  return arr.slice(0, i).join("") + "…";
}

function padToWidth(s: string, maxCols: number): string {
  return s + " ".repeat(Math.max(0, maxCols - stringDisplayWidth(s)));
}

export function renderUserBlock(input: string): string {
  const lines = input.split(/\r?\n/);
  let out = "";
  for (const line of lines) {
    const c = truncateToWidth(line, CONTENT_WIDTH - 2);
    const padded = padToWidth("> " + c, CONTENT_WIDTH);
    out += ANSI.userBg + padded + "  " + ANSI.reset + "\n";
  }
  return out;
}
