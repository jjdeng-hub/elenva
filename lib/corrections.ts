import { createHash } from "node:crypto";
import { listAgentMemoryFiles, parseMemoryEntries, readAgentMemorySnapshot } from "./agent-memory";
import { CONFLICT_DUPLICATE_THRESHOLD, jaccard, terms } from "./memory-conflicts";
import { getMemoryOrigin, normalizeOriginEntryText, type MemoryOrigin } from "./memory-origins";

/**
 * 「纠正 → 规则」流水线的纯逻辑层（解析 + 相似度 + 草稿生成），以及只读的纠正集读取。
 *
 * 侦察结论（2026-10-16，只读翻了本机 pi-hermes-memory 落盘）：用户纠错由
 * pi-hermes-memory 的 correction-detector 在 `turn_end` 触发，经模型 `memory_add` 落成
 * **failures.md 里以 `[correction]` 开头的条目**（尾部带 `<!-- created=…, last=… -->`，
 * 条目间 `§` 分隔）。因此「纠正痕迹」可稳定识别：标签 + 条目元数据。机器可读的
 * `[correction]` 前缀就是我们的筛选口径；部分条目正文里还有 Agent 自己加的
 * `— Failed: <原因>` 段，解析时单独抽出。
 *
 * **没有「已处理/未处理」状态**——这正是 `lib/corrections-state.ts` 要补的 sidecar。
 *
 * 升格规则（纠正陈述 → 「今后怎么做」的规则正文）在本地用确定性启发式生成（加「今后：」
 * 前缀 + 来源标注），**只是草稿**，UI 里可编辑后再落盘；为什么不做模型改写：本机无可靠的
 * 常驻小模型通道、且这层要可回归（与 AGENTS.md「确定性截断」同款取舍）。
 *
 * 复发追踪：新纠正与已升格规则的**规则本体**做 bigram Jaccard 相似度对照，阈值沿用
 * `lib/memory-conflicts.ts` 的 `CONFLICT_DUPLICATE_THRESHOLD`（0.33，真实记忆校准的先例）。
 * 命中只标「可能复发」chip，**不自动改/撤任何规则**（《深入理解 AI Agent》ch3 L505/L511：
 * 证据不足保留待确认、变更走人工审核）。
 */

/** 纠正条目的标签（pi-hermes-memory 落盘时的分类前缀） */
export const CORRECTION_TAG = "[correction]";

/** 复发对照阈值：沿用记忆冲突的「高度重复」刻度 0.33（真实记忆校准，见 memory-conflicts.ts） */
export const CORRECTION_RECURRENCE_THRESHOLD = CONFLICT_DUPLICATE_THRESHOLD;

/** 规则正文尾部的来源标注：相似度对照时要剥掉（只比规则本体） */
const RULE_ANNOTATION_PATTERN = /\s*（纠正升格 ·[^）]*）\s*$/;

/** 条目正文里的 Agent 自加理由段：`— Failed: …`（em dash / en dash 都收） */
const FAILURE_REASON_PATTERN = /\s*[—–]\s*Failed:\s*/;

/** 一个纠正条目（从记忆文件解析出来 + 生成的草稿，尚未叠加处理状态） */
export interface CorrectionItem {
  /** 稳定标识：sha1(归一正文) 前 16 位；正文被改写会变（视作新纠正） */
  id: string;
  /** 所在记忆文件标识：failures | project/<项目名> */
  file: string;
  /** 展示名：failures.md / <项目>/MEMORY.md */
  label: string;
  /** 完整原文（含 `[correction]` 前缀与可能的 `— Failed:` 段） */
  text: string;
  /** 纠正陈述：剥掉标签与理由段后的正文 */
  core: string;
  /** `— Failed: <原因>` 里的原因；没有则 null */
  failureReason: string | null;
  /** 条目元数据里的创建日期（YYYY-MM-DD）；缺元数据为 null */
  createdAt: string | null;
  /** 条目元数据里的最近日期（YYYY-MM-DD）；缺元数据为 null */
  lastAt: string | null;
  /** 来源账本记录（sessionId / cwd / via）；旧条目大概率没有 */
  origin: MemoryOrigin | null;
  /** 升格规则草稿（确定性生成，可编辑） */
  ruleDraft: string;
  /** 追加进 AGENTS.md 的规则建议草稿（只出文本，绝不自动写） */
  agentsDraft: string;
}

export function sha1Hex(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex");
}

/** 纠正 id：NaN 安全且与记忆来源账本的归一化同口径（先剥尾部元数据注释再 trim） */
export function correctionIdOf(text: string): string {
  return sha1Hex(normalizeOriginEntryText(text)).slice(0, 16);
}

/** 规则稳定标识：规则正文的 hash（升格时记录，供复发对照与去重） */
export function ruleHashOf(ruleText: string): string {
  return sha1Hex(normalizeOriginEntryText(ruleText)).slice(0, 16);
}

/** 是否纠正条目（pu-hermes-memory 的分类标签口径） */
export function isCorrectionText(text: string): boolean {
  return /^\[correction\]/i.test(text.trim());
}

/** 剥掉可能重复的 `[correction]` 标签前缀 */
export function stripCorrectionTag(text: string): string {
  return text.replace(/^(?:\[correction\]\s*)+/i, "").trim();
}

/** 抽出 `— Failed: <原因>` 段，返回 [陈述, 原因|null] */
export function splitFailureReason(text: string): [string, string | null] {
  const match = FAILURE_REASON_PATTERN.exec(text);
  if (!match) return [text.trim(), null];
  const core = text.slice(0, match.index).trim();
  const reason = text.slice(match.index + match[0].length).trim();
  return [core, reason || null];
}

/** 规则正文的头部（未编辑的草稿形态）：统一「今后：」开头，已带前缀则不重复加 */
export function ruleHead(core: string): string {
  const trimmed = core.trim();
  return /^今后[：:]/.test(trimmed) ? trimmed : `今后：${trimmed}`;
}

/** 从规则正文剥掉来源标注，得到相似度对照用的规则本体 */
export function ruleCoreOf(ruleText: string): string {
  return ruleText.replace(RULE_ANNOTATION_PATTERN, "").trim();
}

/** 来源标注串：`纠正升格 · 来源：failures.md · 2026-10-16` */
function sourceNote(item: Pick<CorrectionItem, "label" | "createdAt" | "origin">): string {
  const parts = [`来源：${item.label}`];
  if (item.createdAt) parts.push(item.createdAt);
  if (item.origin?.sessionId) parts.push(`会话 ${item.origin.sessionId.slice(0, 8)}`);
  return `纠正升格 · ${parts.join(" · ")}`;
}

/** 升格规则草稿：`今后：<陈述>（纠正升格 · 来源：…）` */
export function buildRuleDraft(item: Pick<CorrectionItem, "core" | "label" | "createdAt" | "origin">): string {
  return `${ruleHead(item.core)}（${sourceNote(item)}）`;
}

/** AGENTS.md 规则建议草稿：一段可直接粘进 AGENTS.md 的 bullet + 注释提示（只出文本） */
export function buildAgentsDraft(
  item: Pick<CorrectionItem, "core" | "failureReason" | "label" | "createdAt" | "origin">,
): string {
  const lines = [
    "<!-- 「纠正收件箱」生成的规则建议草稿：AGENTS.md 是受保护文件，这里不会自动写入；请人工确认后合入合适的小节。 -->",
    `- ${ruleHead(item.core)}`,
  ];
  if (item.failureReason) lines.push(`  - 由来：${item.failureReason}`);
  const src = [item.label, item.createdAt].filter(Boolean).join(" · ");
  const session = item.origin?.sessionId ? ` · 会话 ${item.origin.sessionId}` : "";
  lines.push(`  - 来源：${src}${session}`);
  return lines.join("\n");
}

/**
 * 从一段记忆原文解析出纠正条目（纯函数，不碰磁盘）。
 * `file` / `label` 只用于标注来源；`origin` 未提供则条目的 origin 为 null。
 */
export function parseCorrectionItems(
  file: string,
  label: string,
  raw: string,
  origins: { get?: (text: string) => MemoryOrigin | undefined } = {},
): CorrectionItem[] {
  const items: CorrectionItem[] = [];
  for (const entry of parseMemoryEntries(raw)) {
    // R2r2：已失效的纠正条目已退场，不再进收件箱（否则会把「已推翻的教训」当成待处理项）。
    if (entry.invalidated) continue;
    if (!isCorrectionText(entry.text)) continue;
    const core = stripCorrectionTag(entry.text);
    const [statement, failureReason] = splitFailureReason(core);
    const base = {
      id: correctionIdOf(entry.text),
      file,
      label,
      text: entry.text,
      core: statement,
      failureReason,
      createdAt: entry.created,
      lastAt: entry.last,
      origin: origins.get?.(entry.text) ?? null,
    };
    items.push({
      ...base,
      ruleDraft: buildRuleDraft(base),
      agentsDraft: buildAgentsDraft(base),
    });
  }
  return items;
}

/** 只读扫描所有记忆文件里的纠正条目；按创建时间倒序（缺日期的排最后） */
export function listCorrections(): CorrectionItem[] {
  const items: CorrectionItem[] = [];
  for (const file of listAgentMemoryFiles().files) {
    const snapshot = readAgentMemorySnapshot(file.id);
    if (snapshot.entries.length === 0) continue;
    items.push(
      ...parseCorrectionItems(file.id, file.label, snapshot.raw, {
        get: (text) => getMemoryOrigin(file.id, text),
      }),
    );
  }
  items.sort((a, b) => {
    const at = a.createdAt ?? "";
    const bt = b.createdAt ?? "";
    if (at !== bt) return bt.localeCompare(at);
    return a.file.localeCompare(b.file, "zh");
  });
  return items;
}

/* ============================== 复发追踪 ============================== */

/** 已升格规则（从 sidecar 的 promoted 状态还原） */
export interface PromotedRule {
  /** 规则来源的纠正 id（对照时排除它本身） */
  sourceCorrectionId: string;
  ruleHash: string;
  ruleCore: string;
  /** 升格时间（ISO） */
  at: string;
  memoryFile?: string;
}

/** 一次复发命中 */
export interface RecurrenceMatch {
  ruleHash: string;
  ruleCore: string;
  score: number;
  memoryFile?: string;
}

export interface RecurrenceResult {
  /** 纠正 id → 命中的最相似的已升格规则（无命中则不在表里） */
  byCorrection: Record<string, RecurrenceMatch>;
  /** 规则 hash → 之后的命中的纠正列表（按分数降序） */
  byRule: Record<string, { correctionId: string; score: number }[]>;
}

/** 纠正是否发生在规则升格「之后」；日期缺失时不过滤（宁可见也不漏） */
function isLater(correctionCreatedAt: string | null, ruleAt: string): boolean {
  if (!correctionCreatedAt || !ruleAt) return true;
  return correctionCreatedAt >= ruleAt.slice(0, 10);
}

/**
 * 复发对照：每个纠正找最相似的已升格规则（≥ threshold 才算命中）。
 * 排除「规则自己来源的那条纠正」；只对照规则升格之后的纠正。
 * 纯函数、确定性（同分取先出现的规则）。
 */
export function matchRecurrences(
  corrections: readonly { id: string; core: string; createdAt: string | null }[],
  rules: readonly PromotedRule[],
  threshold: number = CORRECTION_RECURRENCE_THRESHOLD,
): RecurrenceResult {
  const byCorrection: Record<string, RecurrenceMatch> = {};
  const byRule: Record<string, { correctionId: string; score: number }[]> = {};
  if (rules.length === 0) return { byCorrection, byRule };

  for (const correction of corrections) {
    const correctionTerms = terms(correction.core);
    if (correctionTerms.size === 0) continue;
    let best: { rule: PromotedRule; score: number } | null = null;
    for (const rule of rules) {
      if (rule.sourceCorrectionId === correction.id) continue;
      if (!rule.ruleCore) continue;
      if (!isLater(correction.createdAt, rule.at)) continue;
      const score = jaccard(correctionTerms, terms(rule.ruleCore));
      if (score < threshold) continue;
      if (!best || score > best.score) best = { rule, score };
    }
    if (!best) continue;
    byCorrection[correction.id] = {
      ruleHash: best.rule.ruleHash,
      ruleCore: best.rule.ruleCore,
      score: best.score,
      ...(best.rule.memoryFile ? { memoryFile: best.rule.memoryFile } : {}),
    };
    (byRule[best.rule.ruleHash] ??= []).push({ correctionId: correction.id, score: best.score });
  }

  for (const list of Object.values(byRule)) list.sort((a, b) => b.score - a.score);
  return { byCorrection, byRule };
}
