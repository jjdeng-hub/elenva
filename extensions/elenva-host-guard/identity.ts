/**
 * CLI / 飞书侧身份段的**同源读取**（模块 7 修复轮 · 2026-10-19）。
 *
 * ## 它修的是什么
 *
 * 改造前：CLI / 飞书侧的身份段来自安装时写进 `<agentDir>/APPEND_SYSTEM.md` 的
 * **写死短版**（`sync-identity.mjs` 的 `IDENTITY_BLOCK`），与身份编辑器维护的
 * `<agentDir>/elenva-identity.json`（Web 侧装配源）**不同源** —— 用户在「身份」页改了
 * 人格，Web 会变、CLI / 飞书永远不变。
 *
 * 现在：`index.ts` 在每次 agent 启动前（`before_agent_start`）调用本模块，
 * **现场读** `elenva-identity.json` 并把身份段写进系统提示词 —— 与 Web 侧
 * `lib/host-prompt.ts` 读的是同一份文件、同一套口径（标题不注入、空段跳过）。
 *
 * ## 与 APPEND_SYSTEM.md 的关系（兜底，不是主路）
 *
 * `APPEND_SYSTEM.md` 的受管段仍由 `sync-identity.mjs` 在**安装时**写入一份短版种子。
 * 本模块在场时，会**就地替换**受管段里的内容为文件最新值（避免种子与文件重复注入）；
 * 身份文件缺失 / 损坏时本模块**不动**提示词，于是安装期种子作为兜底继续生效。
 * 取舍：把安装脚本里那份降级为「首次安装的种子值」——保底可用，但不再是有效身份源。
 *
 * ## 同口径约束
 *
 * `readIdentityText()` 的拼装口径必须与 `lib/identity.ts` 的 `buildIdentityText()` 一致：
 * 固定标题 + 各段 `body`（空行分隔；`title` 只进编辑界面，不注入）。`extensions/elenva-host-guard/`
 * 的自检里有一项「与 lib 口径逐字一致」的对照。
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const IDENTITY_FILE_NAME = "elenva-identity.json";
/** 身份块的固定标题（注入提示词时拼在正文之前；段落标题不注入） */
export const IDENTITY_HEADING = "## 你是谁";
export const IDENTITY_BEGIN_MARK = "<!-- elenva-host:begin -->";
export const IDENTITY_END_MARK = "<!-- elenva-host:end -->";

/** 清洗出各段正文（与 lib/identity.ts 的 normalizeSections 同口径的「只要 body」子集） */
function normalizeBodies(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const bodies: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "object" || raw === null) continue;
    const body = (raw as { body?: unknown }).body;
    if (typeof body === "string" && body.trim()) bodies.push(body.trim());
  }
  return bodies;
}

/** 由身份文档拼身份正文；形状非法或没有有效段落时返回 null */
export function buildIdentityTextFromDocument(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const bodies = normalizeBodies((input as { sections?: unknown }).sections);
  if (bodies.length === 0) return null;
  return `${IDENTITY_HEADING}\n\n${bodies.join("\n\n")}`;
}

/** 读 `<agentDir>/elenva-identity.json` 拼身份段；文件缺失 / 损坏 / 无有效段落 → null（交给种子兜底） */
export function readIdentityText(agentDir: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(agentDir, IDENTITY_FILE_NAME), "utf8");
  } catch {
    return null;
  }
  try {
    return buildIdentityTextFromDocument(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * 把最新身份段写进系统提示词：
 *  · 有受管段（`<!-- elenva-host:begin/end -->`）→ **只替换段内**，段外逐字节保留；
 *  · 无受管段 → 追加到末尾（保留原有内容，不覆盖）。
 * 内容已一致时原样返回（调用方据此避免无谓的 `forceSystemPrompt`）。
 */
export function injectIdentitySection(systemPrompt: string, identityText: string): string {
  const text = identityText.trim();
  if (!text) return systemPrompt;
  const begin = systemPrompt.indexOf(IDENTITY_BEGIN_MARK);
  const end = systemPrompt.indexOf(IDENTITY_END_MARK);
  if (begin !== -1 && end !== -1 && end > begin) {
    const next = `${systemPrompt.slice(0, begin + IDENTITY_BEGIN_MARK.length)}\n${text}\n${systemPrompt.slice(end)}`;
    return next === systemPrompt ? systemPrompt : next;
  }
  if (systemPrompt.includes(text)) return systemPrompt;
  return `${systemPrompt.replace(/\s+$/, "")}\n\n${text}\n`;
}
