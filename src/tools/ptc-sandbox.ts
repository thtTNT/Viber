/**
 * Programmatic tool calling (PTC): run model-supplied JS in node:vm with only builtin tool APIs exposed.
 */

import vm from "node:vm";
import type { ToolDefinition } from "../types.js";
import type { ToolHandler } from "../types.js";

export const PTC_META_TOOL_NAME = "run_builtin_tools_code";

export const PTC_CODE_MAX_CHARS = 64 * 1024;
export const PTC_DEFAULT_TIMEOUT_MS = 120_000;
export const PTC_SUB_RESULT_MAX_CHARS = 200_000;

export type BuiltinToolEntry = { definition: ToolDefinition; handler: ToolHandler };

export type PtcSubToolHooks = {
  onSubToolCall: (name: string, argsJson: string) => void;
  onSubToolResult: (name: string, content: string, isError: boolean) => void;
};

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n...[truncated]`;
}

function formatScriptResult(result: unknown): string {
  if (result === undefined) return "(no return value)";
  if (result === null) return "null";
  if (typeof result === "string") return truncate(result, PTC_SUB_RESULT_MAX_CHARS * 2);
  try {
    return truncate(JSON.stringify(result, null, 2), PTC_SUB_RESULT_MAX_CHARS * 2);
  } catch {
    return truncate(String(result), PTC_SUB_RESULT_MAX_CHARS * 2);
  }
}

/**
 * Minimal safe globals + one async function per builtin (same names as tool definitions).
 */
function buildSandbox(
  builtins: BuiltinToolEntry[],
  cwd: string,
  hooks: PtcSubToolHooks,
  signal?: AbortSignal
): Record<string, unknown> {
  const sandbox: Record<string, unknown> = {
    JSON,
    Math,
    RegExp,
    Array,
    Object,
    Map,
    Set,
    WeakMap,
    WeakSet,
    String,
    Number,
    Boolean,
    BigInt,
    Symbol,
    Date,
    Error,
    TypeError,
    RangeError,
    SyntaxError,
    ReferenceError,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    Promise,
  };

  for (const { definition, handler } of builtins) {
    const name = definition.name;
    sandbox[name] = async (rawArgs: unknown) => {
      if (signal?.aborted) {
        throw new Error("aborted");
      }
      if (rawArgs === null || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
        throw new TypeError(`${name}: arguments must be a plain object`);
      }
      const args = rawArgs as Record<string, unknown>;
      const argsJson = JSON.stringify(args);
      hooks.onSubToolCall(name, argsJson);
      let content: string;
      let isError = false;
      try {
        content = await handler(args, { cwd });
        if (content.length > PTC_SUB_RESULT_MAX_CHARS) {
          content = truncate(content, PTC_SUB_RESULT_MAX_CHARS);
        }
      } catch (e) {
        content = e instanceof Error ? e.message : String(e);
        isError = true;
      }
      hooks.onSubToolResult(name, content, isError);
      return content;
    };
  }

  return sandbox;
}

export async function runBuiltinToolsCode(params: {
  code: string;
  cwd: string;
  builtins: BuiltinToolEntry[];
  hooks: PtcSubToolHooks;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<string> {
  const { code, cwd, builtins, hooks, signal } = params;
  const timeoutMs = params.timeoutMs ?? PTC_DEFAULT_TIMEOUT_MS;

  if (code === undefined || code === null || typeof code !== "string") {
    return "Error: code must be a string";
  }
  if (code.length > PTC_CODE_MAX_CHARS) {
    return `Error: code exceeds maximum length (${PTC_CODE_MAX_CHARS} characters)`;
  }

  const sandbox = buildSandbox(builtins, cwd, hooks, signal);
  vm.createContext(sandbox);

  const wrapped = `"use strict";\n(async () => {\n${code}\n})()`;

  let script: vm.Script;
  try {
    script = new vm.Script(wrapped, { filename: "ptc-user.js" });
  } catch (e) {
    return `Syntax error in PTC script: ${e instanceof Error ? e.message : String(e)}`;
  }

  let completionValue: unknown;
  try {
    completionValue = script.runInNewContext(sandbox);
  } catch (e) {
    return `PTC script error: ${e instanceof Error ? e.message : String(e)}`;
  }

  const runAsync = async () => {
    if (
      completionValue !== null &&
      typeof completionValue === "object" &&
      "then" in completionValue &&
      typeof (completionValue as PromiseLike<unknown>).then === "function"
    ) {
      return await (completionValue as Promise<unknown>);
    }
    return completionValue;
  };

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, rej) => {
    timeoutId = setTimeout(() => {
      rej(new Error(`PTC script timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  const abortPromise = new Promise<never>((_, rej) => {
    if (!signal) return;
    if (signal.aborted) {
      rej(new Error("aborted"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        rej(new Error("aborted"));
      },
      { once: true }
    );
  });

  try {
    const result = await Promise.race([runAsync(), timeoutPromise, abortPromise]);
    return formatScriptResult(result);
  } catch (e) {
    return `PTC script error: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
