import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * 技能调用统计 —— 离线扫描全部会话文件。
 *
 * pi 内核在用户消息里以 <skill name="..." location="..."> 块记录技能调用
 * （parseSkillBlock 解析的正是这个格式），因此对 JSONL 的用户消息行做
 * 计数即可得到调用排行，无需内核钩子。
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

/**
 * skill 块的落盘双形态：pi 把块拼进用户消息后整体 JSON 序列化写盘，块内引号是**转义**的
 * （`<skill name="x\" location="…\">`，见内核 dist/core/agent-session.js 的 skillBlock 拼装）——
 * 只认未转义引号的老正则对真实会话目录扫出 total=0（2026-10-16 实测，本轮修复的点）；
 * 未转义形态向后兼容早期手工夹具。要求 location= 紧邻跟随，把对话里引用源码的伪调用
 * 误报压到低（toolResult 行 role 不同，本就不在扫描范围）。
 */
const SKILL_RE = /<skill name=(?:"|\\")([^"\\]+?)(?:"|\\") location=(?:"|\\")/g;

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

/** 消息行外层对象带 timestamp（pi 会话格式）：`{"type":"message","timestamp":"…"…}` */
const TIMESTAMP_RE = /"timestamp"\s*:\s*"([^"]+)"/;
/** 行上拿不到 timestamp 时的口径：退化用会话文件 mtime（近似，宁可粗一点也不丢事件） */
function lineTimestampMs(line: string, fallbackMs: number): number {
  const m = TIMESTAMP_RE.exec(line);
  if (m) {
    const at = Date.parse(m[1]);
    if (Number.isFinite(at)) return at;
  }
  return fallbackMs;
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
      // 只扫用户消息行——skill 块只出现在用户消息里，避免误匹配
      if (!line.includes('"role":"user"') && !line.includes('"role": "user"')) continue;
      for (const match of line.matchAll(SKILL_RE)) {
        const name = match[1];
        const atMs = lineTimestampMs(line, modified);
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
