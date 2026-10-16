#!/usr/bin/env node
/**
 * 把本扩展装到 pi 的扩展目录：`<agentRoot>/extensions/elenva-host-guard/`，
 * 并把身份段同步进 `<agentRoot>/APPEND_SYSTEM.md` 的受管段。
 *
 * 与其它 elenva-* 扩展同一套 install 约定（复制式安装：仓库 → agent 目录），
 * 额外做一件 A 侧的事：调用 `sync-identity.mjs`（只碰受管段）。
 *
 * 用法：
 *   node extensions/elenva-host-guard/install.mjs                  # 安装 / 更新 + 同步身份段
 *   node extensions/elenva-host-guard/install.mjs --no-identity    # 只装扩展，不动 APPEND_SYSTEM.md
 *   node extensions/elenva-host-guard/install.mjs --uninstall      # 卸载扩展（不动 APPEND_SYSTEM.md）
 *   node extensions/elenva-host-guard/install.mjs --print-path
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { syncIdentity } from "./sync-identity.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = process.env.PI_CODING_AGENT_DIR
  ? path.resolve(process.env.PI_CODING_AGENT_DIR)
  : path.join(os.homedir(), ".pi", "agent");
const TARGET = path.join(AGENT_ROOT, "extensions", "elenva-host-guard");

const args = process.argv.slice(2);
if (args.includes("--print-path")) {
  console.log(TARGET);
  process.exit(0);
}
if (args.includes("--uninstall")) {
  fs.rmSync(TARGET, { recursive: true, force: true });
  console.log(`已卸载：${TARGET}`);
  console.log("（APPEND_SYSTEM.md 的受管段未动 —— 需要清掉的话删掉 begin/end 两行之间即可）");
  process.exit(0);
}

// 只装运行时要用的文件：*.ts + README（不装 selftest / install / sync-identity 自己）
const files = fs.readdirSync(HERE).filter((name) => name.endsWith(".ts") || name === "README.md");

fs.mkdirSync(TARGET, { recursive: true });
for (const existing of fs.readdirSync(TARGET)) {
  if (!files.includes(existing)) fs.rmSync(path.join(TARGET, existing), { recursive: true, force: true });
}
for (const name of files) {
  fs.copyFileSync(path.join(HERE, name), path.join(TARGET, name));
}
console.log(`已安装 ${files.length} 个文件 → ${TARGET}`);

if (!args.includes("--no-identity")) {
  const { path: appendPath, action } = syncIdentity({ agentRoot: AGENT_ROOT });
  const labels = { created: "已创建", appended: "已追加受管段", updated: "已更新受管段", unchanged: "无变化" };
  console.log(`身份段（${labels[action] ?? action}）：${appendPath}`);
}
