/**
 * Interactive CLI wizard: BASE_URL, API_KEY, BASE_MODEL → ~/.viber/config.json
 */

import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { getConfigPath, loadConfig, saveConfig } from "../config.js";

export async function runBoardingWizard(): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  try {
    output.write("\n╭─ Viber 配置向导 ─────────────────────────────────────────────\n");
    output.write("│ 将写入: " + getConfigPath() + "\n");
    output.write("│\n");

    const before = loadConfig();
    const envUrl = before.BASE_URL || process.env.OPENAI_BASE_URL || "";
    const envModel =
      before.MODEL || process.env.OPENAI_MODEL || process.env.BASE_MODEL || "";

    const baseUrlHint = envUrl ? `当前/环境: ${envUrl}` : "回车跳过则使用默认（api.openai.com）";
    const baseUrl = (await rl.question(`│ BASE_URL\n│   (${baseUrlHint})\n│   > `)).trim();

    const apiKey = (await rl.question("│ API_KEY（必填）\n│   > ")).trim();
    if (!apiKey) {
      output.write("│\n│ 未填写 API_KEY，已取消。\n");
      output.write("╰──────────────────────────────────────────────────────────────\n\n");
      return false;
    }

    const modelHint = envModel ? `当前/环境: ${envModel}` : "回车跳过（可设环境变量 OPENAI_MODEL）";
    const model = (await rl.question(`│ BASE_MODEL（与 OPENAI_MODEL 相同，保存为 MODEL）\n│   (${modelHint})\n│   > `)).trim();

    const next = { ...loadConfig(), API_KEY: apiKey };
    if (baseUrl) {
      next.BASE_URL = baseUrl;
    }
    if (model) {
      next.MODEL = model;
    }
    saveConfig(next);

    output.write("│\n│ ✓ 已保存。运行 viber 进入交互；/status 可查看当前模型与 URL。\n");
    output.write("╰──────────────────────────────────────────────────────────────\n\n");
    return true;
  } finally {
    rl.close();
  }
}
