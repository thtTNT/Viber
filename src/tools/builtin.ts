/**
 * Built-in tools for the coding agent.
 * Tool parameters are defined with Zod and converted to JSON Schema for the API.
 */

import {
  readFile,
  writeFile,
  readdir,
  access,
  copyFile,
  rename,
  mkdir,
  stat,
  unlink,
} from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import parseDiff from "parse-diff";
import { applyPatch } from "diff";
import chalk from "chalk";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolDefinition, ToolHandler } from "../types.js";

const execAsync = promisify(exec);

/** Unified-style preview for a single replacement (matches update_file output shape). */
function formatSearchReplacePreview(
  filePath: string,
  content: string,
  replaceStart: number,
  oldStr: string,
  newStr: string
): string {
  const lineStart = content.slice(0, replaceStart).split("\n").length;
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  let preview = chalk.cyan(`\n📄 File: ${filePath}\n`);
  preview += chalk.gray(
    `@@ -${lineStart},${oldLines.length} +${lineStart},${newLines.length} @@\n`
  );
  for (const line of oldLines) {
    preview += chalk.red(`- ${line}\n`);
  }
  for (const line of newLines) {
    preview += chalk.green(`+ ${line}\n`);
  }
  return preview;
}

/** Resolve paths, ensure source is a regular file, destination absent. Returns paths or an error message. */
async function assertCopyMoveReady(
  source: string,
  destination: string,
  cwd: string
): Promise<{ fromPath: string; toPath: string } | string> {
  const fromPath = source.startsWith("/") ? source : resolve(cwd, source);
  const toPath = destination.startsWith("/") ? destination : resolve(cwd, destination);
  if (fromPath === toPath) {
    return `Error: source and destination are the same path: ${fromPath}`;
  }
  try {
    const st = await stat(fromPath);
    if (!st.isFile()) {
      return `Error: source must be a regular file (not a directory): ${source}`;
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return `Error: source not found: ${source}`;
    return `Error: ${(err as Error).message}`;
  }
  try {
    await access(toPath);
    return `Error: destination already exists: ${destination}. Remove it first or choose another path.`;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      return `Error: could not check destination: ${(err as Error).message}`;
    }
  }
  return { fromPath, toPath };
}

/** Build a tool definition and handler from a Zod schema */
function defineTool<T extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: z.ZodObject<T>,
  handler: (args: z.infer<z.ZodObject<T>>, ctx: { cwd: string }) => Promise<string>
): { definition: ToolDefinition; handler: ToolHandler } {
  const jsonSchema = zodToJsonSchema(schema, {
    $refStrategy: "none",
    target: "jsonSchema7",
  }) as { type?: string; properties?: Record<string, unknown>; required?: string[] };
  const parameters: Record<string, unknown> = {
    type: "object",
    properties: jsonSchema.properties ?? {},
    ...(jsonSchema.required && jsonSchema.required.length > 0 ? { required: jsonSchema.required } : {}),
  };
  return {
    definition: { name, description, parameters },
    handler: async (args, ctx) => {
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        return `Error: invalid arguments: ${parsed.error.message}`;
      }
      return handler(parsed.data, ctx);
    },
  };
}

const readFileSchema = z.object({
  path: z.string().describe("File path"),
  line: z.number().optional().describe("Starting line number (1-indexed). If not provided, reads from the beginning."),
  offset: z.number().optional().describe("Number of lines to read after the starting line. If not provided, reads to the end of file."),
});

const writeFileSchema = z.object({
  path: z.string().describe("File path"),
  content: z.string().describe("Content to write"),
});

const copyOrMoveFileSchema = z.object({
  operation: z
    .enum(["copy", "move"])
    .describe("copy: duplicate file (source kept). move: relocate or rename (source removed); cross-device uses copy+delete."),
  source: z.string().describe("Path of the file (absolute or relative to cwd)"),
  destination: z.string().describe("Target path (absolute or relative to cwd); same directory as source = rename when moving"),
});

const listDirSchema = z.object({
  path: z.string().optional().describe("Directory path (default: cwd)"),
});

const runShellSchema = z.object({
  command: z.string().describe("Shell command to run"),
});

const searchSchema = z.object({
  pattern: z.string().describe("Search pattern (text or regex)"),
  path: z.string().optional().describe("Directory or file to search in (default: cwd)"),
  case_sensitive: z.boolean().optional().describe("Case-sensitive search (default: false)"),
  exclude_hidden: z.boolean().optional().describe("Exclude hidden files and directories (default: true)"),
});

const searchReplaceSchema = z.object({
  path: z.string().describe("File path"),
  old_string: z.string().describe("Exact text to find (must match the file exactly; copy from read_file)"),
  new_string: z.string().describe("Replacement text"),
});

const updateFileSchema = z.object({
  path: z.string().describe("File path to update"),
  diff: z.string().describe("Unified diff. Header: --- a/path\\n+++ b/path. Hunk: @@ -start,count +start,count @@. Context lines (space prefix) must exactly match the file."),
});

export function getBuiltinTools(): Array<{ definition: ToolDefinition; handler: ToolHandler }> {
  return [
    defineTool(
      "read_file",
      "Read the full contents of a file. Path can be absolute or relative to cwd. Use line and offset to read specific line ranges.",
      readFileSchema,
      async ({ path: filePath, line, offset }, { cwd }) => {
        const fullPath = filePath.startsWith("/") ? filePath : join(cwd, filePath);
        const content = await readFile(fullPath, "utf-8");

        if (line === undefined) {
          return content;
        }

        const lines = content.split("\n");
        const startLine = Math.max(1, line) - 1;
        if (startLine >= lines.length) return "";
        const endLine = offset !== undefined ? startLine + offset : lines.length;
        return lines.slice(startLine, endLine).join("\n");
      }
    ),
    defineTool(
      "write_file",
      "Write content to a new file. Creates parent dirs if needed. Path can be absolute or relative to cwd. IMPORTANT: This tool can only create new files, not modify existing files. Use update_file to modify existing files.",
      writeFileSchema,
      async ({ path: filePath, content }, { cwd }) => {
        const fullPath = filePath.startsWith("/") ? filePath : join(cwd, filePath);
        try {
          await access(fullPath);
          return `Error: File "${fullPath}" already exists. Cannot overwrite existing files with write_file. To modify an existing file, use the update_file tool with a diff instead.`;
        } catch (err: unknown) {
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code !== "ENOENT") {
            return `Error: Could not access file "${fullPath}": ${(err as Error).message}`;
          }
        }
        const { mkdir } = await import("node:fs/promises");
        await mkdir(join(fullPath, ".."), { recursive: true });
        await writeFile(fullPath, content, "utf-8");
        return `Wrote ${fullPath}`;
      }
    ),
    defineTool(
      "copy_or_move_file",
      "Copy or move a regular file. Creates parent directories. Fails if destination already exists. Directories are not supported. move: rename when destination is in the same directory; cross-volume rename uses copy then delete source.",
      copyOrMoveFileSchema,
      async ({ operation, source, destination }, { cwd }) => {
        const ready = await assertCopyMoveReady(source, destination, cwd);
        if (typeof ready === "string") return ready;
        const { fromPath, toPath } = ready;
        try {
          await mkdir(dirname(toPath), { recursive: true });
          if (operation === "copy") {
            await copyFile(fromPath, toPath);
            return `Copied ${source} → ${destination}`;
          }
          try {
            await rename(fromPath, toPath);
          } catch (renameErr: unknown) {
            const code = (renameErr as NodeJS.ErrnoException)?.code;
            if (code === "EXDEV") {
              await copyFile(fromPath, toPath);
              await unlink(fromPath);
            } else {
              throw renameErr;
            }
          }
          return `Moved ${source} → ${destination}`;
        } catch (err: unknown) {
          return `Error: ${(err as Error).message}`;
        }
      }
    ),
    defineTool(
      "list_dir",
      "List entries in a directory. Path can be absolute or relative to cwd.",
      listDirSchema,
      async ({ path: dirPath }, { cwd }) => {
        const p = dirPath ?? ".";
        const fullPath = p.startsWith("/") ? p : join(cwd, p);
        const entries = await readdir(fullPath, { withFileTypes: true });
        return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n");
      }
    ),
    defineTool(
      "run_shell",
      "Run a shell command in the workspace. Use for building, tests, git, etc.",
      runShellSchema,
      async ({ command }, { cwd }) => {
        const { stdout, stderr } = await execAsync(command, { cwd, maxBuffer: 2 * 1024 * 1024 });
        if (stderr) return `stderr:\n${stderr}\nstdout:\n${stdout}`;
        return stdout.trim() || "(no output)";
      }
    ),
    defineTool(
      "search",
      "Search for text in files using ripgrep (rg). Returns matching lines with file paths and line numbers.",
      searchSchema,
      async ({ pattern, path: searchPath, case_sensitive, exclude_hidden }, { cwd }) => {
        const excludeHidden = exclude_hidden ?? true;
        const argsList: string[] = ["--no-heading", "--line-number", "--no-messages"];
        if (case_sensitive === false) argsList.push("--ignore-case");
        else if (case_sensitive === true) argsList.push("--case-sensitive");
        if (excludeHidden === false) argsList.push("--hidden");
        argsList.push("--glob", "!node_modules", "--glob", "!*/node_modules", "--glob", "!.git", "--glob", "!*/.git");
        argsList.push(pattern);
        const p = searchPath ?? ".";
        const fullPath = p.startsWith("/") ? p : join(cwd, p);
        argsList.push(fullPath);
        const command = `rg ${argsList.map((arg) => `'${arg.replace(/'/g, "'\"'\"'")}'`).join(" ")}`;
        try {
          const { stdout, stderr } = await execAsync(command, {
            cwd,
            maxBuffer: 2 * 1024 * 1024,
            shell: "/bin/bash",
            timeout: 30000,
          });
          if (stderr) return `Search error: ${stderr}\n${stdout || "(no results)"}`;
          return stdout.trim() || "No matches found.";
        } catch (error: unknown) {
          const e = error as { code?: number; stdout?: string; stderr?: string; message?: string };
          if (e.code === 1 && e.stdout === "" && e.stderr === "") return "No matches found.";
          if (e.code === 1 && e.stderr?.includes("Permission denied")) {
            if (e.stdout?.trim()) return e.stdout.trim();
            return "No matches found (some files were inaccessible).";
          }
          return `Search failed: ${e.message ?? String(error)}`;
        }
      }
    ),
    defineTool(
      "search_replace",
      "Replace the first occurrence of old_string with new_string in a file. Use for small, precise edits. Copy old_string exactly from read_file (including newlines and spaces). More reliable than update_file for one or two line changes.",
      searchReplaceSchema,
      async ({ path: filePath, old_string: oldStr, new_string: newStr }, { cwd }) => {
        const fullPath = filePath.startsWith("/") ? filePath : join(cwd, filePath);
        try {
          const content = await readFile(fullPath, "utf-8");
          const firstIndex = content.indexOf(oldStr);
          if (firstIndex === -1) {
            const snippet = content.slice(0, 500).split("\n").slice(0, 20).map((l, i) => `${i + 1}: ${l}`).join("\n");
            return `Error: old_string was not found in the file. Copy the exact text from read_file (watch for spaces and newlines). File preview:\n${snippet}`;
          }
          const result = content.replace(oldStr, newStr);
          if (result === content) return `Error: replacement produced no change (old_string equals new_string?).`;
          const diffPreview = formatSearchReplacePreview(
            filePath,
            content,
            firstIndex,
            oldStr,
            newStr
          );
          console.log(diffPreview);
          await writeFile(fullPath, result, "utf-8");
          return `✅ Replaced 1 occurrence in ${filePath}\n\n📝 Diff preview:\n${diffPreview}`;
        } catch (err: unknown) {
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code === "ENOENT") return `Error: File not found: ${filePath}.`;
          return `Error: ${(err as Error).message}`;
        }
      }
    ),
    defineTool(
      "update_file",
      "Apply a unified diff patch to a file. Prefer search_replace for one or two line changes (more reliable). For update_file: use at least 3 lines of context, and copy exact lines from read_file—do not guess. If the patch fails, try search_replace with the exact old_string from the file.",
      updateFileSchema,
      async ({ path: filePath, diff: diffContent }, { cwd }) => {
        const fullPath = filePath.startsWith("/") ? filePath : join(cwd, filePath);
        try {
          const currentContent = await readFile(fullPath, "utf-8");
          const files = parseDiff(diffContent);
          if (files.length === 0) {
            return `Error: Could not parse the diff. Please provide a valid unified diff format. Example:
--- a/filename
+++ b/filename
@@ -1,5 +1,5 @@
 old line
-new line

For small edits, use the search_replace tool instead (more reliable).`;
          }
          if (files.length > 1) {
            return `Error: The diff contains changes for ${files.length} files, but only single-file patches are supported. Please provide a diff for only one file.`;
          }
          const file = files[0]!;
          let diffPreview = chalk.cyan(`\n📄 File: ${filePath}\n`);
          for (const chunk of file.chunks) {
            diffPreview += chalk.gray(`@@ -${chunk.oldStart},${chunk.oldLines} +${chunk.newStart},${chunk.newLines} @@\n`);
            for (const change of chunk.changes) {
              const line = change.content;
              if (change.type === "add") diffPreview += chalk.green(`+ ${line}\n`);
              else if (change.type === "del") diffPreview += chalk.red(`- ${line}\n`);
              else diffPreview += chalk.gray(`  ${line}\n`);
            }
          }
          console.log(diffPreview);
          const result = applyPatch(currentContent, diffContent, { fuzzFactor: 2 });
          if (!result) {
            return `Error: Could not apply the patch. Tips:
1. Copy the exact lines from read_file for context—do not retype or guess.
2. Use at least 3 lines of context; ensure no trailing space differences.
3. For single-block edits, prefer search_replace(old_string, new_string)—it is more reliable.

Current file preview (first 50 lines):
${currentContent.split("\n").slice(0, 50).map((line, i) => `${i + 1}: ${line}`).join("\n")}`;
          }
          await writeFile(fullPath, result, "utf-8");
          return `✅ Successfully applied patch to ${filePath}\n\n📝 Diff preview:\n${diffPreview}`;
        } catch (error: unknown) {
          const e = error as NodeJS.ErrnoException;
          if (e?.code === "ENOENT") return `Error: File not found: ${filePath}. Please check the file path and create the file if needed.`;
          return `Error: ${(error as Error).message}. Please fix your diff format and try again. Make sure to use valid unified diff format with sufficient context lines.`;
        }
      }
    ),
  ];
}
