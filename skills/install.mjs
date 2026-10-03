#!/usr/bin/env node
/**
 * 把本仓库的内置起步技能装到 pi 的技能目录：`<agentRoot>/skills/<name>/`。
 *
 * pi 从 agent 目录的 `skills/`（以及 `.pi/skills/`、包、settings）发现技能；
 * 仓库里的源码要能被网页内核与 CLI 同时加载，就得进那个目录。
 * 复制是单向的（仓库 → agent 目录），与 extensions 的 install.mjs 同一套路。
 *
 * 用法：
 *   node skills/install.mjs            # 安装 / 更新全部
 *   node skills/install.mjs --uninstall # 卸载（只删本仓库管理的这几个）
 *   node skills/install.mjs --print-path
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = process.env.PI_CODING_AGENT_DIR
  ? path.resolve(process.env.PI_CODING_AGENT_DIR)
  : path.join(os.homedir(), ".pi", "agent");
const TARGET_ROOT = path.join(AGENT_ROOT, "skills");

const skills = fs
  .readdirSync(HERE)
  .filter((name) => fs.existsSync(path.join(HERE, name, "SKILL.md")));

const args = process.argv.slice(2);
if (args.includes("--print-path")) {
  console.log(TARGET_ROOT);
  process.exit(0);
}
if (args.includes("--uninstall")) {
  for (const name of skills) {
    fs.rmSync(path.join(TARGET_ROOT, name), { recursive: true, force: true });
  }
  console.log(`已卸载 ${skills.length} 个技能（仅限本仓库管理的）→ ${TARGET_ROOT}`);
  process.exit(0);
}

fs.mkdirSync(TARGET_ROOT, { recursive: true });
for (const name of skills) {
  const src = path.join(HERE, name);
  const dst = path.join(TARGET_ROOT, name);
  fs.cpSync(src, dst, { recursive: true, force: true });
}
console.log(`已安装 ${skills.length} 个技能 → ${TARGET_ROOT}`);
for (const name of skills) console.log(`  · ${name}`);
