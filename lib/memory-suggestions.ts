import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { listAgentMemoryFiles, readAgentMemorySnapshot } from "./agent-memory";
import { normalizeOriginEntryText } from "./memory-origins";

/**
 * 记忆整理助手（纯静态启发式，零模型调用、零新依赖、确定性）。
 *
 * 为什么要有它：工作记录（elenva-worklog 扩展写的 `## …` 条目）里已经躺了大量「踩坑 / 教训 /
 * 小技巧」——它们值得进记忆（长期 / 项目），但**没人去翻**，多数就烂在记录里；反向也存在：
 * 同一条教训同时写在 worklog 和记忆里，无人对照。这里把「值得沉淀」的线索行挑出来，交给人在
 * 记忆页确认后一键存入 —— **只提示，不自动写记忆**，也不改工作记录。
 *
 * 边界（与配额 / 冲突两轮同口径）：
 *  - 只读：工作记录只读；记忆写入走既有 `POST /api/memory`（来源账本自动记 `web-edit`）；
 *  - 「定期」扫描属模块 3（节律），本轮只做按需扫描；
 *  - 启发式：标记词 + 长度 + 与现有记忆去重，宁可少报也不打扰（cap 8）。
 *
 * 《深入理解 AI Agent》ch3 L505 要求证据不足时保留待确认状态、不强行收敛；L202 点出自动
 * UPDATE/DELETE 不可逆 —— 因此这里只产出候选，落不落盘由人决定（本决策属已登记的
 * 「超阈值只提醒不自动整理」偏离的同一族）。
 */

/** 沉淀线索标记词：命中即视为「这行在总结经验 / 提醒后人」。集中管理，按真实误报补词。 */
export const LESSON_MARKERS: readonly string[] = [
  "踩坑",
  "坑点",
  "教训",
  "陷阱",
  "切记",
  "以后不要",
  "不要再",
  "避免",
  "经验",
  "学到",
  "小技巧",
  "注意",
];

/** 一行至少这么长才当线索（短行多是「已修复」「见上」这类碎句） */
export const SUGGESTION_LINE_MIN_LENGTH = 12;
/** 最多扫最近这么多条工作记录 */
export const SUGGESTION_MAX_ENTRIES = 40;
/** 最多提示这么多条候选（一屏看得完，不做全量） */
export const SUGGESTION_MAX_ITEMS = 8;
/** 与记忆比对时取「行首 N 字核心」的长度 */
export const SUGGESTION_CORE_LENGTH = 30;
/** 忽略清单上限：超出按加入顺序淘汰最旧（FIFO） */
export const SUGGESTION_DISMISS_LIMIT = 200;

/** 一条候选：来源（哪份工作记录、哪条、什么时候）+ 线索行原文 */
export interface MemorySuggestion {
  /** sha1(sourceFile + NUL + 归一后的 line)：忽略清单与去重的稳定键 */
  key: string;
  /** 工作记录文件名（basename，如 `elenva.md`） */
  sourceFile: string;
  /** 条目标题（`## <时间> · <标题> · <状态>` 的标题段） */
  sourceTitle: string;
  /** 条目时间（`YYYY-MM-DD HH:mm`）；标题里取不到时为 null */
  sourceDate: string | null;
  /** 线索行原文（trim 后） */
  line: string;
}

/** 空的待办行：「待办：无」「待办：无。（更正…）」—— 没有内容可沉淀 */
const EMPTY_TODO_PATTERN = /^待办[：:]\s*无\s*[。.．]?\s*(?:（[^）]*）|\([^)]*\))?\s*$/;
/** 只有标签没有内容的行：「目标：」「做了什么：」 */
const LABEL_ONLY_PATTERN = /^(?:目标|做了什么|证据|待办|结论|备注)[：:]\s*$/;
/** 严格条目头：`## 2026-10-15 16:55 · 标题 · done` */
const ENTRY_HEAD_PATTERN =
  /^##\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s*·\s*(.+?)\s*·\s*(?:done|doing|blocked)\s*$/;
/** 宽松标题里的前导时间（边界标题兜底） */
const LEADING_DATE_PATTERN = /^(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?)\s*[·\-—:]?\s*/;
/** 行首列表符号：`- ` / `* ` / `1. ` / `1、` / `1) ` */
const LEADING_BULLET_PATTERN = /^(?:[-*•·]|\d+[.、)）])\s+/;

type WorklogBlock = {
  sourceFile: string;
  sourceTitle: string;
  sourceDate: string | null;
  /** 正文行（不含标题行） */
  lines: string[];
};

/** 工作记录目录：与 elenva-worklog 扩展同口径（ELENVA_WORKLOG_DIR 优先） */
export function worklogDir(): string {
  const configured = process.env.ELENVA_WORKLOG_DIR?.trim();
  if (configured) return configured;
  return join(getAgentDir(), "worklog");
}

/** 忽略清单路径：`<agentDir>/elenva-memory-suggests.json` */
export function getMemorySuggestsPath(): string {
  return join(getAgentDir(), "elenva-memory-suggests.json");
}

/** 线索行归一：剥尾部元数据注释 → 去行首列表符号 → 空白折叠（去重 / 比对 / key 共用） */
export function normalizeSuggestionLine(text: string): string {
  let out = normalizeOriginEntryText(text);
  // 连续列表符号（`- 1. foo`）也一次剥干净；有界循环，避免正则状态机打转
  for (let i = 0; i < 4 && LEADING_BULLET_PATTERN.test(out); i += 1) {
    out = out.replace(LEADING_BULLET_PATTERN, "");
  }
  return out.replace(/\s+/g, " ").trim();
}

/** 候选键：sha1(sourceFile + NUL + 归一后的 line)，稳定、与忽略清单一致 */
export function suggestionKey(sourceFile: string, line: string): string {
  return createHash("sha1").update(`${sourceFile}\u0000${normalizeSuggestionLine(line)}`, "utf8").digest("hex");
}

/** 是否是要提示的线索行：命中标记词 + 够长 + 不是空待办 / 空标签行 */
export function isLessonLine(line: string): boolean {
  const text = line.trim();
  if (text.length < SUGGESTION_LINE_MIN_LENGTH) return false;
  if (EMPTY_TODO_PATTERN.test(text)) return false;
  if (LABEL_ONLY_PATTERN.test(text)) return false;
  return LESSON_MARKERS.some((marker) => text.includes(marker));
}

/** 标题行 → { title, date }；严格格式不中时退到宽松解析（不丢条目） */
function parseHeading(heading: string): { title: string; date: string | null } {
  const strict = ENTRY_HEAD_PATTERN.exec(heading.trim());
  if (strict) return { title: strict[2], date: strict[1] };
  const rest = heading.replace(/^#+\s*/, "").trim();
  const lead = LEADING_DATE_PATTERN.exec(rest);
  if (!lead) return { title: rest, date: null };
  const title = rest
    .slice(lead[1].length)
    .replace(/^[·\-—:]\s*/, "")
    .replace(/\s*·\s*(?:done|doing|blocked)\s*$/, "")
    .trim();
  return { title: title || rest, date: lead[1] };
}

/** 按 `## ` 切块（每块含标题行）；`###` 不算条目头 */
function splitBlocks(raw: string): string[] {
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const line of raw.split(/\r?\n/)) {
    if (/^##\s/.test(line)) {
      if (current) blocks.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) blocks.push(current);
  return blocks.map((block) => block.join("\n"));
}

function toWorklogBlock(sourceFile: string, block: string): WorklogBlock | null {
  const lines = block.split("\n");
  const heading = lines[0]?.trim() ?? "";
  if (!/^##\s/.test(heading)) return null;
  const { title, date } = parseHeading(heading);
  return { sourceFile, sourceTitle: title, sourceDate: date, lines: lines.slice(1) };
}

/** 工作记录文件（`.md`）按 mtime 新→旧 */
function listWorklogFiles(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: { path: string; mtime: number }[] = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".md")) continue;
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      files.push({ path, mtime: stat.mtimeMs });
    } catch {
      // 读不到的条目直接跳过（工作记录是尽力而为的输入）
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path)).map((f) => f.path);
}

/** 读最近 `limit` 条工作记录（文件按 mtime 新→旧，文件内新→旧） */
export function readRecentWorklogBlocks(limit = SUGGESTION_MAX_ENTRIES): WorklogBlock[] {
  const out: WorklogBlock[] = [];
  for (const path of listWorklogFiles(worklogDir())) {
    let raw = "";
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const sourceFile = basename(path);
    for (const block of splitBlocks(raw)) {
      if (out.length >= limit) return out;
      const parsed = toWorklogBlock(sourceFile, block);
      if (parsed) out.push(parsed);
    }
  }
  return out;
}

/** 现有记忆的条目正文（归一后），用于「已经记过了」的排除 */
function existingMemoryEntries(): string[] {
  const out: string[] = [];
  for (const file of listAgentMemoryFiles().files) {
    const snapshot = readAgentMemorySnapshot(file.id);
    for (const entry of snapshot.entries) {
      const normalized = normalizeSuggestionLine(entry.text);
      if (normalized) out.push(normalized);
    }
  }
  return out;
}

/** 线索行是否已经在某条记忆里（整行包含，或行首 30 字核心包含） */
export function isAlreadyInMemory(line: string, corpus: readonly string[]): boolean {
  const normalized = normalizeSuggestionLine(line);
  if (!normalized) return true;
  const core = normalized.length > SUGGESTION_CORE_LENGTH ? normalized.slice(0, SUGGESTION_CORE_LENGTH) : null;
  return corpus.some((text) => text.includes(normalized) || (core !== null && text.includes(core)));
}

/* ============================ 忽略清单 ============================ */

interface SuggestsStore {
  version: 1;
  dismissed: string[];
}

/** 读忽略清单（文件缺失 / 损坏 / 结构非法 → 空数组，不抛）；加入顺序（旧→新） */
export function listDismissed(): string[] {
  let raw: string;
  try {
    raw = readFileSync(getMemorySuggestsPath(), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return [];
    const dismissed = (parsed as { dismissed?: unknown }).dismissed;
    if (!Array.isArray(dismissed)) return [];
    return dismissed.filter((key): key is string => typeof key === "string" && key.trim().length > 0);
  } catch {
    return [];
  }
}

export function isDismissed(key: string): boolean {
  if (typeof key !== "string" || !key) return false;
  return listDismissed().includes(key);
}

/**
 * 记一条忽略（读-改-写，后写胜；重复 key 只保留最新位置）。
 * 超过 `SUGGESTION_DISMISS_LIMIT` 时按加入顺序淘汰最旧（FIFO）。返回是否成功落盘。
 */
export function dismissSuggestion(key: string): boolean {
  if (typeof key !== "string" || !key.trim()) return false;
  const keys = listDismissed().filter((existing) => existing !== key);
  keys.push(key);
  const trimmed = keys.length > SUGGESTION_DISMISS_LIMIT ? keys.slice(keys.length - SUGGESTION_DISMISS_LIMIT) : keys;
  const store: SuggestsStore = { version: 1, dismissed: trimmed };
  try {
    const path = getMemorySuggestsPath();
    mkdirSync(dirname(path), { recursive: true });
    writePrivateFileAtomicSync(path, `${JSON.stringify(store, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/* ============================ 候选 ============================ */

/**
 * 扫工作记录 → 提取沉淀线索 → 去重 / 排除已在记忆中的 / 排除已忽略的 → 按来源新→旧，cap 8。
 * 工作记录空 / 无候选 → `[]`。**只读，不写任何东西**（忽略清单是唯一的写路径，且只在 dismiss 时）。
 */
export function listMemorySuggestions(options: { limit?: number } = {}): MemorySuggestion[] {
  const limit = Math.max(0, options.limit ?? SUGGESTION_MAX_ITEMS);
  if (limit === 0) return [];

  const blocks = readRecentWorklogBlocks();
  const corpus = existingMemoryEntries();
  const dismissed = new Set(listDismissed());
  const seen = new Set<string>();
  const out: MemorySuggestion[] = [];

  for (const block of blocks) {
    for (const raw of block.lines) {
      if (!isLessonLine(raw)) continue;
      const normalized = normalizeSuggestionLine(raw);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      const key = suggestionKey(block.sourceFile, raw);
      if (dismissed.has(key)) continue;
      if (isAlreadyInMemory(normalized, corpus)) continue;
      out.push({
        key,
        sourceFile: block.sourceFile,
        sourceTitle: block.sourceTitle,
        sourceDate: block.sourceDate,
        line: raw.trim(),
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}
