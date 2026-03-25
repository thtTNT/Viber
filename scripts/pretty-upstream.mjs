#!/usr/bin/env node
/**
 * Pretty-print NDJSON upstream files (one JSON object per line).
 * Prefer **upstream.jsonl**; legacy sessions used single-line **upstream.log** (same shape).
 * New **upstream.log** is already multi-line — open it directly in the editor.
 * Usage:
 *   node scripts/pretty-upstream.mjs path/to/upstream.jsonl
 *   npm run logs:pretty -- path/to/upstream.jsonl
 */

import * as fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/pretty-upstream.mjs <upstream.jsonl|upstream.log>");
  process.exit(1);
}

const text = fs.readFileSync(file, "utf8");
const lines = text.split(/\n/);

for (const line of lines) {
  const t = line.trim();
  if (!t || t.startsWith("---") || t.startsWith("Viber upstream")) continue;
  if (t.startsWith("=")) continue;
  try {
    const o = JSON.parse(t);
    console.log("\n" + "=".repeat(72));
    console.log(JSON.stringify(o, null, 2));
  } catch {
    // Skip non-JSON lines (e.g. already-pretty audit file prose)
  }
}
