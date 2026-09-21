import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { aggregateSkillUsage } from "./skill-usage";
import type { SkillInfo } from "./api-types";

/**
 * 技能生命周期 —— 「装了但没用过」的能力得有个去处。
 *
 * 借鉴 Hermes Agent 的 curator，但刻意只抄一半：
 *  · 抄：状态分层（active / stale / unused）、**永不删除只归档**、可恢复；
 *  · 不抄：空闲时自动改写用户文件。没人会去审计一个后台写手，
 *    自动归档一个他上周刚装的技能只会变成「我的技能不见了」。
 *    所以状态是自动算的，动作（归档 / 恢复）由人点。
 *
 * 归档去向刻意放在 skills 根目录**之外**（`<agentDir>/elenva-skill-archive/`）：
 * 放在 `<skillsRoot>/.archive/` 里，pi 的资源加载器照样会扫到它，归档就等于没归。
 */

export type SkillState = "active" | "stale" | "unused";

export interface SkillLifecycleEntry {
  name: string;
  filePath: string;
  baseDir: string;
  source: string;
  scope: string;
  useCount: number;
  lastUsedAt: string | null;
  /** 技能文件最后修改时间（用来判断「刚装还没机会用」） */
  addedAt: string | null;
  state: SkillState;
  reason: string;
}

export interface ArchivedSkill {
  id: string;
  name: string;
  /** 归档前的技能目录 */
  originalDir: string;
  archivedAt: string;
  reason: string;
}

export interface SkillLifecycleReport {
  entries: SkillLifecycleEntry[];
  archived: ArchivedSkill[];
  /** 分层阈值（天），供界面说明用 */
  thresholds: { staleDays: number; unusedDays: number };
}

const STALE_DAYS = 14;
const UNUSED_DAYS = 30;

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  return (Date.now() - at) / (24 * 60 * 60 * 1000);
}

export function archiveRoot(agentDir = getAgentDir()): string {
  return join(agentDir, "elenva-skill-archive");
}

function readArchived(agentDir?: string): ArchivedSkill[] {
  const root = archiveRoot(agentDir);
  if (!existsSync(root)) return [];
  const out: ArchivedSkill[] = [];
  for (const name of readdirSync(root)) {
    const metaPath = join(root, name, "meta.json");
    if (!existsSync(metaPath)) continue;
    try {
      out.push(JSON.parse(readFileSync(metaPath, "utf8")) as ArchivedSkill);
    } catch {
      /* 跳过坏记录 */
    }
  }
  return out.sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
}

export function buildSkillLifecycle(skills: readonly SkillInfo[], agentDir?: string): SkillLifecycleReport {
  const usage = aggregateSkillUsage();
  const counts = new Map(usage.skills.map((skill) => [skill.name, skill.count]));
  const entries: SkillLifecycleEntry[] = skills.map((skill) => {
    const useCount = counts.get(skill.name) ?? 0;
    const lastUsedAt = usage.lastUsed[skill.name] ?? null;
    let addedAt: string | null = null;
    try {
      addedAt = skill.filePath && existsSync(skill.filePath)
        ? new Date(statSync(skill.filePath).mtimeMs).toISOString()
        : null;
    } catch {
      addedAt = null;
    }
    const sinceUsed = daysSince(lastUsedAt);
    const sinceAdded = daysSince(addedAt);

    let state: SkillState = "active";
    let reason = useCount > 0 ? `用过 ${useCount} 次` : "尚未使用";
    if (useCount === 0) {
      // 刚装还没机会用的不算「没用过」—— 给它一个宽限期
      if (sinceAdded !== null && sinceAdded >= STALE_DAYS) {
        state = "unused";
        reason = `装了 ${Math.floor(sinceAdded)} 天，一次都没调用过`;
      }
    } else if (sinceUsed !== null && sinceUsed >= UNUSED_DAYS) {
      state = "unused";
      reason = `已有 ${Math.floor(sinceUsed)} 天没调用过`;
    } else if (sinceUsed !== null && sinceUsed >= STALE_DAYS) {
      state = "stale";
      reason = `已有 ${Math.floor(sinceUsed)} 天没调用过`;
    }

    return {
      name: skill.name,
      filePath: skill.filePath,
      baseDir: skill.baseDir,
      source: skill.sourceInfo?.source ?? "",
      scope: skill.sourceInfo?.scope ?? "",
      useCount,
      lastUsedAt,
      addedAt,
      state,
      reason,
    };
  });

  return {
    entries,
    archived: readArchived(agentDir),
    thresholds: { staleDays: STALE_DAYS, unusedDays: UNUSED_DAYS },
  };
}

/**
 * 归档：把技能目录整体搬走（`baseDir` 是技能自己的目录，含 SKILL.md 与附属文件）。
 * 绝不删除，恢复就是把目录放回去。
 */
export function archiveSkill(entry: { name: string; baseDir: string }, reason: string, agentDir?: string): ArchivedSkill {
  if (!entry.baseDir || !existsSync(entry.baseDir)) throw new Error("技能目录不存在，可能已被手工移动");
  const archiveDir = join(archiveRoot(agentDir), `${entry.name.replace(/[^a-zA-Z0-9._-]/g, "_")}-${Date.now().toString(36)}`);
  if (existsSync(archiveDir)) throw new Error("归档目录已存在，请重试");
  mkdirSync(dirname(archiveDir), { recursive: true });

  const meta: ArchivedSkill = {
    id: basename(archiveDir),
    name: entry.name,
    originalDir: entry.baseDir,
    archivedAt: new Date().toISOString(),
    reason,
  };
  try {
    renameSync(entry.baseDir, archiveDir);
  } catch {
    // 跨盘符时 rename 会失败：退化成拷贝 + 删除，但仍然先拷再删
    cpSync(entry.baseDir, archiveDir, { recursive: true });
    rmSync(entry.baseDir, { recursive: true, force: true });
  }
  writePrivateFileAtomicSync(join(archiveDir, "meta.json"), JSON.stringify(meta, null, 2));
  return meta;
}

export function restoreSkill(id: string, agentDir?: string): ArchivedSkill {
  const archiveDir = join(archiveRoot(agentDir), id);
  const metaPath = join(archiveDir, "meta.json");
  if (!existsSync(metaPath)) throw new Error("找不到该归档记录");
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as ArchivedSkill;
  if (existsSync(meta.originalDir)) throw new Error(`原位置已有同名技能：${meta.originalDir}`);
  mkdirSync(dirname(meta.originalDir), { recursive: true });

  // meta.json 是归档记录，不该混进恢复后的技能目录
  const tempTarget = `${archiveDir}.restore`;
  rmSync(tempTarget, { recursive: true, force: true });
  cpSync(archiveDir, tempTarget, { recursive: true });
  rmSync(join(tempTarget, "meta.json"), { force: true });
  try {
    renameSync(tempTarget, meta.originalDir);
  } catch {
    // 跨盘符时 rename 会失败
    cpSync(tempTarget, meta.originalDir, { recursive: true });
    rmSync(tempTarget, { recursive: true, force: true });
  }
  rmSync(archiveDir, { recursive: true, force: true });
  return meta;
}

/** 删掉一条归档记录（技能本体早已不在，这里清的是元数据与残留文件） */
export function dropArchived(id: string, agentDir?: string): void {
  const archiveDir = join(archiveRoot(agentDir), id);
  if (!existsSync(archiveDir)) return;
  rmSync(archiveDir, { recursive: true, force: true });
}
