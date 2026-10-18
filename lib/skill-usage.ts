import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { getAgentDir, parseSkillBlock } from "@earendil-works/pi-coding-agent";

/**
 * 技能调用统计 —— 离线扫描全部会话文件。
 *
 * pi 内核在用户消息里以 <skill name="..." location="..."> 块记录技能调用
 * （parseSkillBlock 解析的正是这个格式），因此对 JSONL 的用户消息行做
 * 计数即可得到调用排行，无需内核钩子。
 *
 * 2026-10-18（模块 4 R1）：从「字面 includes + 正则计数」改为**真正解析 JSON 行**
 * + 内核 parseSkillBlock 定位。旧写法有两处误计：
 *   · 用户在消息里**引用/讨论** skill 块（不在文本起始）也被计入；
 *   · 非 JSON 的损坏行只要含有字面 `"role":"user"` 就参与计数。
 * 现在：行 JSON 解析失败直接跳过；且 skill 块必须位于该消息**文本起始**
 * （parseSkillBlock 的正则就是 `^<skill …>`），位置不对即为引用，不是调用。
 */

export interface SkillUsageReport {
  /** 全部会话中的技能调用总次数 */
  total: number;
  /** 按调用次数降序 */
  skills: { name: string; count: number }[];
  /** 技能名 → 最近一次出现在会话里的时间（取会话文件 mtime，近似值） */
  lastUsed: Record<string, string>;
  /**
   * 2026-10-16 增（模块 4 R5）：调用时间窗口统计。在同一次全量扫描里顺带算出，
   * 老客户端可整体忽略本字段，既有字段均不变（向后兼容只增不改）。
   */
  recent: SkillUsageWindows;
}

export interface SkillUsageWindows {
  /** 统计基准时间（ISO） */
  at: string;
  /** 近 7 天（含今天）各技能调用次数 */
  days7: Record<string, number>;
  /** 近 30 天各技能调用次数 */
  days30: Record<string, number>;
  total7: number;
  total30: number;
}

function collectJsonlFiles(dir: string, out: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const full = join(dir, name);
    if (name.endsWith(".jsonl")) {
      out.push(full);
      continue;
    }
    collectJsonlFiles(full, out); // 目录递归；对文件 readdirSync 会抛错，由上方 catch 吞掉
  }
}

let cache: { at: number; value: SkillUsageReport } | null = null;
const CACHE_TTL_MS = 30_000;

/** 仅供自测用：清掉内存缓存强制重扫（jiti 的模块注册表跨实例共享，新实例也拿同一份缓存） */
export function resetSkillUsageCacheForTest(): void {
  cache = null;
}

/** 消息行外层对象带 timestamp（pi 会话格式）：{"type":"message","timestamp":"…",…} */
function timestampMs(value: unknown, fallbackMs: number): number {
  if (typeof value === "string") {
    const at = Date.parse(value);
    if (Number.isFinite(at)) return at;
  }
  return fallbackMs;
}

/** 用户消息的文本块：content 可能是裸字符串，也可能是 [{type:"text",text}] */
function textBlocks(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    if (
      block !== null &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      out.push((block as { text: string }).text);
    }
  }
  return out;
}

/**
 * 取出文本**起始**处的 skill 块名（可链式：一个消息里连着多个 /skill: 调用）。
 * 用内核自己的 parseSkillBlock —— 它的正则以 `^<skill name="…" location="…">` 开头，
 * 天然满足「位置不对即引用」的判据，也避免我们与内核格式漂移。
 * 尾部空白先行去掉：parseSkillBlock 的 `$` 只认输入末尾，消息末尾多一个换行不该让它失配。
 */
function leadingSkillNames(text: string): string[] {
  const names: string[] = [];
  let cursor = text.replace(/\s+$/, "");
  for (;;) {
    const block = parseSkillBlock(cursor);
    if (!block) break;
    names.push(block.name);
    if (!block.userMessage) break;
    cursor = block.userMessage;
  }
  return names;
}

export function aggregateSkillUsage(): SkillUsageReport {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const files: string[] = [];
  collectJsonlFiles(join(getAgentDir(), "sessions"), files);

  const counts = new Map<string, number>();
  const lastUsedAt = new Map<string, number>();
  const days7 = new Map<string, number>();
  const days30 = new Map<string, number>();
  let total = 0;
  let total7 = 0;
  let total30 = 0;
  const nowMs = Date.now();
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
  for (const file of files) {
    let text: string;
    let modified = 0;
    try {
      text = readFileSync(file, "utf8");
      modified = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const entry = parseLine(line);
      if (!entry) continue;
      const message = entry.message as { role?: unknown; content?: unknown } | undefined;
      if (!message || typeof message !== "object" || message.role !== "user") continue;
      const atMs = timestampMs(entry.timestamp, modified);
      for (const textBlock of textBlocks(message.content)) {
        for (const name of leadingSkillNames(textBlock)) {
          counts.set(name, (counts.get(name) ?? 0) + 1);
          total += 1;
          if (atMs >= nowMs - WEEK_MS) {
            days7.set(name, (days7.get(name) ?? 0) + 1);
            total7 += 1;
          }
          if (atMs >= nowMs - MONTH_MS) {
            days30.set(name, (days30.get(name) ?? 0) + 1);
            total30 += 1;
          }
          if (modified > (lastUsedAt.get(name) ?? 0)) lastUsedAt.set(name, modified);
        }
      }
    }
  }

  const value: SkillUsageReport = {
    total,
    skills: [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    lastUsed: Object.fromEntries(
      [...lastUsedAt.entries()].map(([name, at]) => [name, new Date(at).toISOString()]),
    ),
    recent: {
      at: new Date(nowMs).toISOString(),
      days7: Object.fromEntries(days7),
      days30: Object.fromEntries(days30),
      total7,
      total30,
    },
  };
  cache = { at: Date.now(), value };
  return value;
}

/** 解析一行会话 JSONL；损坏行（非 JSON）返回 null —— 不再靠字面匹配放行 */
function parseLine(line: string): { timestamp?: unknown; message?: unknown } | null {
  if (!line.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed === null || typeof parsed !== "object") return null;
    return parsed as { timestamp?: unknown; message?: unknown };
  } catch {
    return null;
  }
}
