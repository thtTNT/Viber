/**
 * Debug logging for CLI TUI: when enabled, wraps process.stdout.write so every
 * write is appended to a log file (ANSI escapes preserved).
 *
 * Enable: VIBER_DEBUG=1 npm run dev  (or DEBUG=viber)
 * Log file: .viber-debug.log in cwd
 */

import * as fs from "node:fs";
import * as path from "node:path";

const LOG_FILE = ".viber-debug.log";

function isEnabled(): boolean {
  return process.env.VIBER_DEBUG === "1" || process.env.VIBER_DEBUG === "true" || process.env.DEBUG === "viber";
}

/** Escape string for log: show control chars as \xNN or \r \n */
function escapeForLog(s: string | Buffer): string {
  const str = Buffer.isBuffer(s) ? s.toString("utf8") : s;
  let out = "";
  for (let i = 0; i < str.length; i++) {
    const c = str[i]!;
    const code = str.charCodeAt(i);
    if (code === 0x1b) out += "\\x1b";
    else if (code === 13) out += "\\r";
    else if (code === 10) out += "\\n";
    else if (code < 32 || code > 126) out += "\\x" + code.toString(16).padStart(2, "0");
    else out += c;
  }
  return out;
}

let logStream: fs.WriteStream | null = null;

function ensureStream(): fs.WriteStream {
  if (logStream) return logStream;
  const file = path.join(process.cwd(), LOG_FILE);
  logStream = fs.createWriteStream(file, { flags: "a" });
  logStream.write(`\n===== ${new Date().toISOString()} session start =====\n`);
  return logStream;
}

export function enabled(): boolean {
  return isEnabled();
}

/** Log one stdout write. */
export function logStdout(data: string | Buffer, label = "stdout"): void {
  if (!isEnabled()) return;
  const stream = ensureStream();
  const ts = new Date().toISOString();
  const escaped = escapeForLog(data);
  stream.write(`${ts} [${label}] ${escaped}\n`);
}

/** Log one stdin key/chunk. */
export function logStdin(data: string | Buffer, label = "stdin"): void {
  if (!isEnabled()) return;
  const stream = ensureStream();
  const ts = new Date().toISOString();
  const escaped = escapeForLog(data);
  stream.write(`${ts} [${label}] ${escaped}\n`);
}

/** Wrap process.stdout.write to log every write when debug is on. */
export function wrapStdout(original: typeof process.stdout.write): typeof process.stdout.write {
  if (!isEnabled()) return original;
  return function (this: typeof process.stdout, chunk: unknown, ...args: unknown[]) {
    if (chunk !== undefined && chunk !== null) {
      logStdout(chunk as string | Buffer, "stdout");
    }
    return (original as (...a: unknown[]) => boolean).apply(this, [chunk, ...args]);
  } as typeof process.stdout.write;
}

/** Path to log file (for printing to user). */
export function logPath(): string {
  return path.join(process.cwd(), LOG_FILE);
}
