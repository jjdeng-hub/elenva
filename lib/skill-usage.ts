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
}

const SKILL_RE = /<skill name="([^"]+)"/g;

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

export function aggregateSkillUsage(): SkillUsageReport {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const files: string[] = [];
  collectJsonlFiles(join(getAgentDir(), "sessions"), files);

  const counts = new Map<string, number>();
  const lastUsedAt = new Map<string, number>();
  let total = 0;
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
        counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
        total += 1;
        if (modified > (lastUsedAt.get(match[1]) ?? 0)) lastUsedAt.set(match[1], modified);
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
  };
  cache = { at: Date.now(), value };
  return value;
}
