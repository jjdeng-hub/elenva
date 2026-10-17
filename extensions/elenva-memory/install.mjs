#!/usr/bin/env node
/**
 * 把本扩展（v2 · 已收编 pi-hermes-memory 底座）装到 pi 的扩展目录：
 * `<agentRoot>/extensions/elenva-memory/`。
 *
 * 为什么是「复制」而不是「就地加载」：pi 只从 agent 目录的 `extensions/` 与 settings 的
 * packages 里发现扩展；仓库里的源码要能被网页内核与 CLI（飞书守护进程）同时加载，就得进那个目录。
 * 复制是单向的（仓库 → agent 目录），改完源码重跑本脚本即可。
 *
 * v2 与 v1 的差别：底座 pi-hermes-memory 的源码已搬到 `vendor/`，本脚本会**连同 vendor 一起复制**；
 * 因此不再需要 `settings.packages` 里的第三方包（迁移步骤见本脚本末尾输出）。
 *
 * 用法：
 *   node extensions/elenva-memory/install.mjs            # 安装 / 更新
 *   node extensions/elenva-memory/install.mjs --uninstall # 卸载（删掉 agent 目录里的副本）
 *   node extensions/elenva-memory/install.mjs --print-path
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = process.env.PI_CODING_AGENT_DIR
  ? path.resolve(process.env.PI_CODING_AGENT_DIR)
  : path.join(os.homedir(), ".pi", "agent");
const TARGET = path.join(AGENT_ROOT, "extensions", "elenva-memory");

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

/**
 * 写 hermes 配置：① 双层记忆开关；② **中文纠正识别**。
 *
 * 为什么必须写中文模式：pi-hermes-memory 的内置 CORRECTION_* 全是英文正则
 * （整个包 src/ 里 0 个 CJK 字符），而它的 weak 模式靠 `\b词\b` 判「后面是不是指令」——
 * `\b` 对中文永远不成立，所以中文只能进 strong 列表（直接命中即判定为纠正）。
 * 而配置里的数组是**整体覆盖内置默认值**的，所以英文默认项必须原样搬过来。
 */
const EN_STRONG = ["don'?t do that", "not like that", "^I said\\b", "^I told you\\b", "we already discussed", "^please don'?t", "^that'?s not what I"];
const EN_WEAK = ["^no[,\\.\\s!]", "^wrong[,\\.\\s!]", "^actually[,\\.\\s]", "^stop[,\\.\\s!]"];
const EN_NEGATIVE = ["^no worries", "^no problem", "^no thanks", "^no need", "^actually.{0,10}(looks? great|perfect|good|correct|right)", "^stop.{0,5}(there|here|for now)"];
const ZH_STRONG = [
  "^不对", "不对吧", "不对啊", "还是不对", "完全不对", "这不对", "那不对",
  "不好看", "不好用", "不好使", "不顺手", "不流畅",
  "我说的是", "我指的是", "我要的是", "谁让你", "不是让你",
  "不是这样", "不是这个意思", "不要这样", "不要这么做", "别这样", "别这么做",
  "^错了", "搞错了", "弄错了", "写反了", "弄反了", "理解错了",
  "^重来", "重新来", "重做", "重写一遒", "推倒重来",
  "我上次说过", "我早就说过", "我跟你说过", "已经说过了",
];

function patchHermesConfig() {
  const configPath = path.join(AGENT_ROOT, "hermes-memory-config.json");
  if (!fs.existsSync(configPath)) {
    console.log(`（未找到 ${configPath}，跳过配置合并；桌面/飞书首次启动后会生成，再跑一次即完成）`);
    return;
  }
  const raw = fs.readFileSync(configPath, "utf8");
  const config = JSON.parse(raw);
  const changed = [];

  if (config.memoryMode !== "policy-only") {
    config.memoryMode = "policy-only";
    changed.push("memoryMode → policy-only（常驻内容交给本扩展的索引层）");
  }

  const desiredStrong = [...EN_STRONG, ...ZH_STRONG];
  if (JSON.stringify(config.correctionStrongPatterns) !== JSON.stringify(desiredStrong)) {
    config.correctionStrongPatterns = desiredStrong;
    changed.push(`correctionStrongPatterns → ${desiredStrong.length} 条（补上中文纠正）`);
  }
  if (JSON.stringify(config.correctionWeakPatterns) !== JSON.stringify(EN_WEAK)) {
    config.correctionWeakPatterns = EN_WEAK;
    changed.push("correctionWeakPatterns → 内置英文默认项（中文不适用 weak，见注释）");
  }
  if (JSON.stringify(config.correctionNegativePatterns) !== JSON.stringify(EN_NEGATIVE)) {
    config.correctionNegativePatterns = EN_NEGATIVE;
    changed.push("correctionNegativePatterns → 内置英文默认项");
  }

  if (changed.length === 0) {
    console.log("hermes 配置已是最新（无需改动）");
    return;
  }
  fs.copyFileSync(configPath, `${configPath}.bak-preinstall`);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  console.log(`hermes 配置已更新（备份 ${path.basename(configPath)}.bak-preinstall）：`);
  for (const line of changed) console.log(`  · ${line}`);
}

/** 递归复制目录（vendor 里有子目录与 .mjs，必须整棵带走）。 */
function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const source = path.join(src, entry.name);
    const target = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(source, target);
    else if (entry.isFile()) fs.copyFileSync(source, target);
  }
}

function countFiles(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) total += countFiles(path.join(dir, entry.name));
    else if (entry.isFile()) total += 1;
  }
  return total;
}

patchHermesConfig();

// 只装运行时要用的文件：顶层 *.ts + README.md + vendor/（递归）。
// 不装 selftest*.mjs / install.mjs / tidy-cli.mjs（不进 agent 目录，避免递归与噪声）。
fs.rmSync(TARGET, { recursive: true, force: true });
fs.mkdirSync(TARGET, { recursive: true });
let copied = 0;
for (const name of fs.readdirSync(HERE)) {
  const source = path.join(HERE, name);
  const target = path.join(TARGET, name);
  if (name === "vendor" && fs.statSync(source).isDirectory()) {
    copyTree(source, target);
    copied += countFiles(target);
  } else if (name.endsWith(".ts") || name === "README.md") {
    fs.copyFileSync(source, target);
    copied += 1;
  }
}
console.log(`已安装 ${copied} 个文件 → ${TARGET}`);

/**
 * 共存 → 替换迁移步骤（R1b 切换时照着做）。
 * 旧的第三方包与本扩展会同时注册 memory_add/replace/remove/search、session_search、skill_manage
 * 等同名工具——必须先移除旧包再启动，否则会出现双注册。
 */
function reportLegacyPackage() {
  const settingsPath = path.join(AGENT_ROOT, "settings.json");
  let configured = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    if (Array.isArray(parsed.packages)) configured = parsed.packages;
  } catch {
    /* 没 settings 或读不动，按未配置处理 */
  }
  const legacy = configured.filter((item) => typeof item === "string" && item.includes("pi-hermes-memory"));
  const npmDir = path.join(AGENT_ROOT, "npm", "node_modules", "pi-hermes-memory");
  const installed = fs.existsSync(npmDir);

  if (legacy.length === 0 && !installed) return;
  console.log("\n⚠️ 检测到旧的第三方底座 pi-hermes-memory 仍在本机：");
  if (legacy.length > 0) console.log(`   · settings.packages 里仍有：${legacy.join(", ")}`);
  if (installed) console.log(`   · npm 目录里仍有：${npmDir}`);
  console.log(" 共存会同时注册同名工具（双注册）。切换到本扩展（R1b）时按顺序做：");
  console.log("   1) 从 settings.packages 删掉 pi-hermes-memory；");
  console.log(`   2) 可选：删除 ${npmDir}（不影响本扩展读取已有记忆文件）；`);
  console.log("   3) 重跑本脚本；4) 重启 pi / 网页内核，确认工具面只有一套 memory_* / session_search / skill_manage。");
}

reportLegacyPackage();
