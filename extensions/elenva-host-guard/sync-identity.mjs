/**
 * ELENVA 身份段 → `<agentDir>/APPEND_SYSTEM.md` 的**受管段**同步器（模块 5 · 第 5 轮 A）。
 *
 * ## 为什么需要它
 *
 * ELENVA Web 的身份段走 `lib/host-prompt.ts` 的 `appendSystemPrompt`（在进程内注入）；
 * 独立 `pi` 进程（CLI / 飞书 `pi --mode rpc`）拿不到它，只能靠 pi 自己的用户级插槽
 * `~/.pi/agent/APPEND_SYSTEM.md`（`docs/host-prompt.md` 第一节）。本同步器负责把
 * **身份背景**写进那个文件。
 *
 * ## 受管段规则（只碰自己的段）
 *
 * ```
 * <!-- elenva-host:begin -->   ← 本工具拥有这一段（含标记行）
 * ## 你是谁 …
 * <!-- elenva-host:end -->
 * ```
 *
 * | 情况 | 行为 |
 * |---|---|
 * | 文件不存在 / 空 | 整文件 = 受管段 |
 * | 有标记 | **只替换段内**，段外逐字节保留 |
 * | 无标记但有内容 | 追加到末尾（段外内容一个字不动） |
 *
 * 绝不清空、绝不覆盖用户写在段外的内容。重复跑是幂等的（内容一致 → `unchanged`）。
 *
 * ## 口径来源
 *
 * `lib/host-prompt.ts` 的 `id: "identity"`（同步点）+ `docs/host-prompt.md` 第二节。
 * CLI 场景**只取身份骨干 + 一句护栏说明**，不搬运整份宿主提示词（「没有终端交互」
 * 「改动有快照」这些是 Web 宿主事实，对 CLI 不成立甚至误导）。
 *
 * ## 定位（2026-10-19 修复轮起）：降级为**安装期种子**
 *
 * 有效身份源已是身份编辑器维护的 `<agentDir>/elenva-identity.json`：扩展
 * `elenva-host-guard` 在每次 agent 启动前（`before_agent_start`）读它并就地替换本受管段
 * （`identity.ts`），与 Web 侧 `lib/host-prompt.ts` 同源。本脚本仍把 `IDENTITY_BLOCK`
 * 作为**首次安装的种子**写进去，仅当扩展未安装 / 文件缺失时充当兜底 —— 不再是有效身份源，
 * 所以不随身份页编辑而变化（“同源分叉”已消除：两侧现在读同一份文件）。
 *
 * 用法：
 *   node extensions/elenva-host-guard/sync-identity.mjs            # 同步
 *   node extensions/elenva-host-guard/sync-identity.mjs --print    # 只看会写成什么
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const BEGIN_MARK = "<!-- elenva-host:begin -->";
export const END_MARK = "<!-- elenva-host:end -->";

/**
 * 身份段正文（CLI / 飞书侧版本）。
 * 同步点：`lib/host-prompt.ts` 的 identity 段 —— 改那边时回来对齐口径，
 * 但这里**不照抄**：允许的差别是「Web 宿主专属事实」那一类。
 */
export const IDENTITY_BLOCK = [
  "## 你是谁",
  "",
  "你是 **ELENVA**（昵称 **Elen**）—— 一个以 pi 为内核的 agent。",
  "你的主职是编码；记忆、技能、护栏都是你的零件，不是外部系统。",
  "",
  "做不到的时候，说清楚缺哪一类，不要笼统地说「做不到」：",
  "- 记不住 → 现在写进记忆",
  "- 每次都要重新查 → 沉淀成技能",
  "- 缺外部数据或操作 → 需要插件 / MCP",
  "- 重复犯错 → 升级成规则，或提议加护栏",
  "",
  "**危险操作会被拦下**：删除、强推、装依赖、改凭据、越界写入会被宿主护栏拒绝执行，",
  "并登记到 ELENVA 工作台「等你处理」。被拦下时不要原样重试 —— 换办法，或说明为什么必须这样做。",
].join("\n");

export const MANAGED_SECTION = `${BEGIN_MARK}\n${IDENTITY_BLOCK}\n${END_MARK}`;

function ensureTrailingNewline(text) {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * 把 `section` 合并进 `existing`：纯函数，返回 { content, action }。
 * action ∈ created | appended | updated | unchanged。
 */
export function mergeManagedSection(existing, section = MANAGED_SECTION) {
  const text = typeof existing === "string" ? existing : "";
  if (text.trim() === "") {
    return { content: ensureTrailingNewline(section.trim() ? section : ""), action: "created" };
  }
  const begin = text.indexOf(BEGIN_MARK);
  const end = text.indexOf(END_MARK);
  if (begin !== -1 && end !== -1 && end > begin) {
    const before = text.slice(0, begin);
    const after = text.slice(end + END_MARK.length);
    const content = `${before}${section}${after}`;
    return { content, action: content === text ? "unchanged" : "updated" };
  }
  // 无标记：追加，段外内容逐字节保留
  const base = text.endsWith("\n") ? text : `${text}\n`;
  return { content: `${base}\n${section}\n`, action: "appended" };
}

/** agent 目录：显式传入 > PI_CODING_AGENT_DIR > ~/.pi/agent（与 install.mjs 同口径） */
export function resolveAgentRoot(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.PI_CODING_AGENT_DIR) return path.resolve(process.env.PI_CODING_AGENT_DIR);
  return path.join(os.homedir(), ".pi", "agent");
}

/**
 * 同步身份段到 `<agentRoot>/APPEND_SYSTEM.md`。
 * 写失败会抛（安装流程需要知道失败）；返回 { path, action }。
 */
export function syncIdentity({ agentRoot, section = MANAGED_SECTION } = {}) {
  const root = resolveAgentRoot(agentRoot);
  const target = path.join(root, "APPEND_SYSTEM.md");
  let existing;
  try {
    existing = fs.readFileSync(target, "utf8");
  } catch {
    existing = "";
  }
  const { content, action } = mergeManagedSection(existing, section);
  if (action !== "unchanged") {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }
  return { path: target, action };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.argv.includes("--print")) {
    console.log(MANAGED_SECTION);
  } else {
    const { path: target, action } = syncIdentity();
    const labels = { created: "已创建", appended: "已追加受管段", updated: "已更新受管段", unchanged: "无变化" };
    console.log(`${labels[action] ?? action}：${target}`);
  }
}
