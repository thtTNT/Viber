/**
 * TUI-MD: Terminal Markdown renderer using marked for parsing and custom ANSI output.
 * Keeps CJK display width and table column layout.
 */

import { lexer, type Token, type Tokens } from "marked";

const R = "\x1b[0m";
const BOLD = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";
const ITALIC = "\x1b[3m";
const ITALIC_OFF = "\x1b[23m";

const C = {
  reset: R,
  bold: BOLD,
  boldOff: BOLD_OFF,
  italic: ITALIC,
  italicOff: ITALIC_OFF,
  heading: "\x1b[36m",
  heading2: "\x1b[36m\x1b[2m",
  quote: "\x1b[34m\x1b[2m",
  code: "\x1b[32m",
  codeBlock: "\x1b[2m\x1b[32m",
  tableHeader: "\x1b[36m\x1b[1m",
  tableBorder: "\x1b[2m\x1b[90m",
  link: "\x1b[34m\x1b[2m",
  listBullet: "\x1b[33m\x1b[2m",
} as const;

function charDisplayWidth(c: string): number {
  if (c.length === 0) return 0;
  const code = c.codePointAt(0)!;
  if (code >= 0x4e00 && code <= 0x9fff) return 2;
  if (code >= 0x3000 && code <= 0x303f) return 2;
  if (code >= 0xff00 && code <= 0xffef) return 2;
  if (code >= 0xac00 && code <= 0xd7af) return 2;
  return 1;
}

function displayWidthPlain(s: string): number {
  let n = 0;
  for (const c of Array.from(s)) n += charDisplayWidth(c);
  return n;
}

function displayWidthVisible(s: string): number {
  return displayWidthPlain(s.replace(/\x1b\[[0-9;]*m/g, ""));
}

function truncatePlainToWidth(s: string, maxW: number): string {
  let out = "";
  let w = 0;
  for (const c of Array.from(s)) {
    const cw = charDisplayWidth(c);
    if (w + cw > maxW) break;
    out += c;
    w += cw;
  }
  return out;
}

function padDisplayEnd(s: string, target: number): string {
  const w = displayWidthVisible(s);
  if (w >= target) return s;
  return s + " ".repeat(target - w);
}

/** Render inline tokens to ANSI string */
function renderInline(tokens: Token[] | undefined): string {
  if (!tokens || tokens.length === 0) return "";
  let out = "";
  for (const t of tokens) {
    const token = t as Tokens.Generic;
    switch (token.type) {
      case "text": {
        const tt = token as Tokens.Text;
        // List items (and similar) wrap inline markup in a text token whose `.text`
        // is still raw; parsed children live in `.tokens`. Prefer children when present.
        if (tt.tokens && tt.tokens.length > 0) {
          out += renderInline(tt.tokens);
        } else {
          out += tt.text;
        }
        break;
      }
      case "strong":
        out += BOLD + renderInline((token as Tokens.Strong).tokens) + BOLD_OFF;
        break;
      case "em":
        out += ITALIC + renderInline((token as Tokens.Em).tokens) + ITALIC_OFF;
        break;
      case "codespan":
        out += C.code + (token as Tokens.Codespan).text + R;
        break;
      case "link":
        out += C.link + renderInline((token as Tokens.Link).tokens) + R + " (" + (token as Tokens.Link).href + ")";
        break;
      case "escape":
        out += (token as Tokens.Escape).text;
        break;
      default: {
        const g = token as Tokens.Generic;
        const text = (g as unknown as { text?: string }).text;
        if (typeof text === "string") out += text;
        else if (g.tokens) out += renderInline(g.tokens);
        break;
      }
    }
  }
  return out;
}

/** Render table token with CJK-aware column widths */
function renderTableToken(table: Tokens.Table): string[] {
  const header = table.header;
  const rows = table.rows;
  const allCells: string[][] = [
    header.map((c) => renderInline(c.tokens)),
    ...rows.map((row) => row.map((c) => renderInline(c.tokens))),
  ];
  const colCount = Math.max(...allCells.map((r) => r.length), 1);
  const widths: number[] = [];
  for (let c = 0; c < colCount; c++) {
    let max = 3;
    for (const row of allCells) {
      const cell = row[c] ?? "";
      max = Math.max(max, displayWidthPlain(cell));
    }
    widths.push(max);
  }
  const sep = C.tableBorder + "|" + R;
  const out: string[] = [];
  for (let i = 0; i < allCells.length; i++) {
    const row = allCells[i]!;
    const cells = [...row];
    while (cells.length < colCount) cells.push("");
    const parts = cells.map((cell, j) => {
      const w = widths[j] ?? 0;
      const plain = truncatePlainToWidth(cell, w);
      const padded = padDisplayEnd(plain, w);
      return i === 0 ? C.tableHeader + padded + R : padded;
    });
    out.push(sep + parts.join(sep) + sep);
    if (i === 0) {
      const sepCells = widths.map((w) => C.tableBorder + "-".repeat(Math.max(1, w)) + R);
      out.push(sep + sepCells.join(sep) + sep);
    }
  }
  return out;
}

/** Render a single block token to one or more ANSI lines */
function renderBlock(token: Token): string[] {
  const t = token as Tokens.Generic;
  switch (t.type) {
    case "code": {
      const code = t as Tokens.Code;
      const lines = code.text.split(/\r?\n/);
      return lines.map((line) => C.codeBlock + line + R);
    }
    case "heading": {
      const h = t as Tokens.Heading;
      const style = h.depth === 1 ? C.heading : C.heading2;
      return [style + BOLD + renderInline(h.tokens) + BOLD_OFF + R];
    }
    case "blockquote": {
      const bq = t as Tokens.Blockquote;
      return [C.quote + renderInline(bq.tokens) + R];
    }
    case "paragraph":
      return [renderInline((t as Tokens.Paragraph).tokens)];
    case "list": {
      const list = t as Tokens.List;
      const lines: string[] = [];
      const start = typeof list.start === "number" ? list.start : 1;
      for (let i = 0; i < list.items.length; i++) {
        const bullet = list.ordered ? `${start + i}.` : "-";
        const prefix = C.listBullet + bullet + " " + R;
        lines.push(prefix + renderInline(list.items[i]!.tokens));
      }
      return lines;
    }
    case "table":
      return renderTableToken(t as Tokens.Table);
    case "space":
      return [""];
    case "hr":
      return [C.tableBorder + "---" + R];
    default: {
      const g = t as Tokens.Generic;
      const text = (g as unknown as { text?: string }).text;
      if (typeof text === "string") return [text];
      if (g.tokens) return [renderInline(g.tokens)];
      return [];
    }
  }
}

/**
 * Render markdown to ANSI-colored terminal output.
 * Uses marked for parsing; preserves CJK width and table layout.
 */
export function renderTuiMd(text: string): string {
  if (!text.trim()) return text;
  const tokens = lexer(text);
  const lines: string[] = [];
  for (const token of tokens) {
    lines.push(...renderBlock(token));
  }
  return lines.join("\n");
}
