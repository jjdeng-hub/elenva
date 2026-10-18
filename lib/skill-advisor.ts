import type { SkillLifecycleEntry, SkillLifecycleReport } from "./skill-lifecycle";
import type { SkillScope, SkillUsageReport } from "./skill-usage";

/**
 * 技能用量顾问 —— 「该归档谁」的读数与建议。
 *
 * 与 skill-lifecycle（分层）和整理助手（memory-suggestions）同一族先例：
 * **建议只提示，动作由人点**——这里只产出读数与候选，归档永远走既有
 * 的确认流（skill-lifecycle.archiveSkill，绝不删除）。
 *
 * 纯函数：只消费 buildSkillLifecycle / aggregateSkillUsage 的产物，
 * 不做 IO、不起进程 —— 界面与服务端都能直接组装。
 */

export interface SkillAdvisorOverview {
  /** 技能总数（未归档） */
  totalSkills: number;
  /** active 数 */
  active: number;
  /** stale（久未使用）数 */
  stale: number;
  /** unused（从未使用 / 超 30 天未调）数 */
  unused: number;
  /** 吃灰数（idle 清单条数：分层标记吃灰 且 窗口内零调用） */
  idle: number;
  /** 会话历史里的调用总次数 */
  totalCalls: number;
  /** 近 7 天总调用 */
  calls7: number;
  /** 近 30 天总调用 */
  calls30: number;
}

/** 高频榜条目 */
export interface SkillHotItem {
  name: string;
  /**
   * 2026-10-18 增（模块 4 尾巴轮 · 归因）：归因键，additive。
   * `global:<名>` / `workspace:<名>` / `project:<项目>:<名>` / `unknown:<名>` ——
   * 全局与项目同名时靠它区分，不会把读数混在一起。老数据缺此字段。
   */
  key?: string;
  /** additive：来源域；缺省表示老数据（只按名字归并、未归因） */
  scope?: SkillScope;
  /** additive：scope === "project" 时的项目标识（`projects-memory/<项目>` 的 `<项目>`） */
  project?: string;
  /** 历史总调用次数 */
  count: number;
  /** 近 7 天调用次数 */
  count7: number;
  /** 近 30 天调用次数 */
  count30: number;
  /** 最近一次使用（近似时间，取会话文件 mtime） */
  lastUsedAt: string | null;
}

/** 吃灰清单条目 */
export interface SkillIdleItem {
  name: string;
  state: "stale" | "unused";
  /** 生成分层时的原因原文，界面直接展示 */
  reason: string;
  lastUsedAt: string | null;
  addedAt: string | null;
  suggestedAction: "archive";
}

export interface SkillAdvisorReport {
  overview: SkillAdvisorOverview;
  /** 调用次数降序，含最近使用 */
  hot: SkillHotItem[];
  /** 吃灰清单：state ∈ stale/unused 且 近 30 天 0 调用 */
  idle: SkillIdleItem[];
}

/** 高频榜长度上限（一屏看得完；沿用整理助手 cap 的口径） */
export const HOT_LIMIT = 8;

/**
 * 30 天窗口内零调用 = 天窗口径下真正的吃灰：
 * stale 但近 30 天偶尔还用一次的，说明还有残值，不进归档建议。
 * older usage（无 recent 字段的老数据）时退化为「全量分层一致的吃灰」。
 */
function windowCalls(
  skill: string,
  usage: Pick<SkillUsageReport, "recent">,
): { c7: number; c30: number } {
  const recent = usage.recent;
  if (!recent) return { c7: 0, c30: 0 };
  return { c7: recent.days7[skill] ?? 0, c30: recent.days30[skill] ?? 0 };
}

export function buildSkillAdvisorReport(
  lifecycle: Pick<SkillLifecycleReport, "entries">,
  usage: Pick<SkillUsageReport, "total" | "recent"> & Partial<Pick<SkillUsageReport, "entries">>,
): SkillAdvisorReport {
  const entries = lifecycle.entries;

  let active = 0;
  let stale = 0;
  let unused = 0;
  for (const entry of entries) {
    if (entry.state === "active") active += 1;
    else if (entry.state === "stale") stale += 1;
    else if (entry.state === "unused") unused += 1;
  }

  // 高频榜：优先用**与 total 同口径**的 usage.entries（按 (scope,name) 拆分），
  // 这样项目技能（不在已安装技能分层的枚举里）也能上榜；entries 缺省时（老数据 /
  // 老路由）退回「只从当前装着的技能里取」的历史口径。
  //
  // 注：新口径下，历史里调过但当前已归档/删除的技能也会上榜（entries 是使用记录，
  // 不是安装清单）—— 符合「高频榜 = 读数」的定位；归档按钮只在 idle 清单里出现。
  const hot: SkillHotItem[] = usage.entries && usage.entries.length > 0
    ? [...usage.entries]
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
        .slice(0, HOT_LIMIT)
        .map((entry) => ({
          name: entry.name,
          key: entry.key,
          scope: entry.scope,
          ...(entry.project !== undefined ? { project: entry.project } : {}),
          count: entry.count,
          count7: entry.count7,
          count30: entry.count30,
          lastUsedAt: entry.lastUsedAt,
        }))
    : entries
        .filter((entry) => entry.useCount > 0)
        .sort((a, b) => b.useCount - a.useCount)
        .slice(0, HOT_LIMIT)
        .map((entry) => {
          const win = windowCalls(entry.name, usage);
          return {
            name: entry.name,
            count: entry.useCount,
            count7: win.c7,
            count30: win.c30,
            lastUsedAt: entry.lastUsedAt,
          };
        });

  const idle: SkillIdleItem[] = entries
    .filter((entry): entry is SkillLifecycleEntry & { state: "stale" | "unused" } => entry.state !== "active")
    .filter((entry) => windowCalls(entry.name, usage).c30 === 0)
    .map((entry) => ({
      name: entry.name,
      state: entry.state,
      reason: entry.reason,
      lastUsedAt: entry.lastUsedAt,
      addedAt: entry.addedAt,
      suggestedAction: "archive" as const,
    }));

  return {
    overview: {
      totalSkills: entries.length,
      active,
      stale,
      unused,
      idle: idle.length,
      totalCalls: usage.total,
      calls7: usage.recent?.total7 ?? 0,
      calls30: usage.recent?.total30 ?? 0,
    },
    hot,
    idle,
  };
}
