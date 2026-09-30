#!/usr/bin/env node
/**
 * 把本扩展装到 pi 的扩展目录：`<agentRoot>/extensions/elenva-todo/`。
 *
 * pi 只从 agent 目录的 `extensions/` 与 settings 的 packages 里发现扩展；仓库里的源码要能被
 * 网页内核与 CLI（飞书守护进程）同时加载，就得进那个目录。复制是单向的（仓库 → agent 目录）。
 *
 * 用法：
 *   node extensions/elenva-todo/install.mjs            # 安装 / 更新
 *   node extensions/elenva-todo/install.mjs --uninstall # 卸载
 *   node extensions/elenva-todo/install.mjs --print-path
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = process.env.PI_CODING_AGENT_DIR
  ? path.resolve(process.env.PI_CODING_AGENT_DIR)
  : path.join(os.homedir(), ".pi", "agent");
const TARGET = path.join(AGENT_ROOT, "extensions", "elenva-todo");

const args = process.argv.slice(2);
if (args.includes("--print-path")) {
  console.log(TARGET);
  process.exit(0);
}
if (args.includes("--uninstall")) {
  fs.rmSync(TARGET, { recursive: true, force: true });
  console.log(`已卸载：${TARGET}`);
  process.exit(0);
}

// 只装运行时要用的文件：*.ts + README（不装 selftest / install 自己，避免递归）
const files = fs.readdirSync(HERE).filter((name) => name.endsWith(".ts") || name === "README.md");

fs.mkdirSync(TARGET, { recursive: true });
for (const existing of fs.readdirSync(TARGET)) {
  if (!files.includes(existing)) fs.rmSync(path.join(TARGET, existing), { recursive: true, force: true });
}
for (const name of files) {
  fs.copyFileSync(path.join(HERE, name), path.join(TARGET, name));
}
console.log(`已安装 ${files.length} 个文件 → ${TARGET}`);