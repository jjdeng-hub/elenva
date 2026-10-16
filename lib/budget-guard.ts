/**
 * 预算护栏（模块 5 · 第 4 轮）—— **纯函数**：解析容错 + 超限判定 + 人话提示。
 *
 * 只做「上限 + 提示」，**不拦截、不拒绝任何执行**：硬停留留给将来。
 * 无 `node:*`、无副作用，可被客户端与 `tools/budget-guard-selftest.mjs` 直载。
 */

export interface BudgetSettings {
  /** 每日花费上限（USD）。缺省 / null = 不限。非负有限数才算有效值。 */
  dailyUsd?: number;
  /** 滚动 7 天花费上限（USD，模块 6 第 2 轮增）。缺省 / null = 不限。
   *  向后兼容：旧数据没有这个键，解析后就是不限，无需迁移。 */
  weeklyUsd?: number;
  /** 单会话花费上限（USD）。缺省 / null = 不限。非负有限数才算有效值。 */
  sessionUsd?: number;
}

export type BudgetScope = "daily" | "weekly" | "session";

export interface BudgetExceeded {
  scope: BudgetScope;
  spent: number;
  limit: number;
}

export interface BudgetCheckResult {
  /** 命中的超限项（按 daily → session 固定顺序）；无命中为空数组 */
  exceeded: BudgetExceeded[];
  /** 人话提示（一遍说清全部命中项）；无命中为 null */
  note: string | null;
}

/** 一个合法的上限：非负有限数。（0 也是合法上限：任何花费都超。） */
function isValidLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * 读盘容错：把任意来源的 budgets 归一到 `BudgetSettings`。
 * 非负有限数才收；负数 / NaN / Infinity / 字符串 / 布尔 一律丢弃（视为不限）。
 */
export function parseBudgets(value: unknown): BudgetSettings {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const out: BudgetSettings = {};
  if (isValidLimit(raw.dailyUsd)) out.dailyUsd = raw.dailyUsd;
  if (isValidLimit(raw.weeklyUsd)) out.weeklyUsd = raw.weeklyUsd;
  if (isValidLimit(raw.sessionUsd)) out.sessionUsd = raw.sessionUsd;
  return out;
}

/**
 * 写入前严格校验（路由层用）：`null` / 缺省 = 不限；其余必须是**非负有限数**。
 * 与 `parseBudgets` 的分工：读盘是容错（脏值静默丢弃），写盘是校验（脏值直接 400，
 * 不让非法值静默落盘后又悄悄变成「不限」）。
 */
export function parseBudgetsInput(
  value: unknown,
): { ok: true; budgets: BudgetSettings } | { ok: false; error: string } {
  if (value === null || value === undefined) return { ok: true, budgets: {} };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "预算格式不正确" };
  }
  const raw = value as Record<string, unknown>;
  const out: BudgetSettings = {};
  const LIMIT_LABELS: Record<keyof BudgetSettings, string> = {
    dailyUsd: "日上限必须是非负数字",
    weeklyUsd: "周上限必须是非负数字",
    sessionUsd: "会话上限必须是非负数字",
  };
  for (const key of ["dailyUsd", "weeklyUsd", "sessionUsd"] as const) {
    const v = raw[key];
    if (v === null || v === undefined) continue;
    if (!isValidLimit(v)) {
      return { ok: false, error: LIMIT_LABELS[key] };
    }
    out[key] = v;
  }
  return { ok: true, budgets: out };
}

function normalizeSpent(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** 各 scope 的口语称呼（与 formatBudgetNote / formatApproachNote 共用，保证说法一致） */
const SCOPE_LABELS: Record<BudgetScope, string> = {
  daily: "今日",
  weekly: "近 7 天",
  session: "本会话",
};

/**
 * 把超限项拼成人话（一遍说清）；空数组 / null 返回 null。
 * 顺序即传入顺序（checkBudgets 固定 daily → session）。
 */
export function formatBudgetNote(exceeded: readonly BudgetExceeded[] | null | undefined): string | null {
  if (!exceeded || exceeded.length === 0) return null;
  return exceeded
    .map((item) =>
      `${SCOPE_LABELS[item.scope]}已花费 ${usd(item.spent)}，超过设定上限 ${usd(item.limit)}`)
    .join("；");
}

/**
 * 超限判定 + 生成人话提示。
 *
 * 边界口径：`spent > limit` 才算超（**精确等于上限不算超**，测试里钉死）。
 * 上限缺省 / 非法一律视为「不限」，此时该项永不命中。
 */
export function checkBudgets(input: {
  dailySpent: number;
  /** 滚动 7 天花费（含今日）。缺省按 0（不命中）；调用方从聚合报告取近 7 天。 */
  weeklySpent?: number;
  sessionSpent: number;
  budgets: BudgetSettings | null | undefined;
}): BudgetCheckResult {
  const budgets = parseBudgets(input.budgets);
  const dailySpent = normalizeSpent(input.dailySpent);
  const weeklySpent = normalizeSpent(input.weeklySpent);
  const sessionSpent = normalizeSpent(input.sessionSpent);
  const exceeded: BudgetExceeded[] = [];

  // 固定顺序 daily → weekly → session（自测钉死）；周包含今日，所以周排日后面
  if (budgets.dailyUsd !== undefined && dailySpent > budgets.dailyUsd) {
    exceeded.push({ scope: "daily", spent: dailySpent, limit: budgets.dailyUsd });
  }
  if (budgets.weeklyUsd !== undefined && weeklySpent > budgets.weeklyUsd) {
    exceeded.push({ scope: "weekly", spent: weeklySpent, limit: budgets.weeklyUsd });
  }
  if (budgets.sessionUsd !== undefined && sessionSpent > budgets.sessionUsd) {
    exceeded.push({ scope: "session", spent: sessionSpent, limit: budgets.sessionUsd });
  }

  return { exceeded, note: formatBudgetNote(exceeded) };
}

/**
 * 推送去重用的「档位」：刚超 = `over`；再超 50%（spent ≥ limit × 1.5）= `far`。
 * 单调不减，所以「同会话同 scope 同档只推一次」等价于「每跨一档各推一次」。
 */
export function budgetBucket(spent: number, limit: number): "over" | "far" {
  const s = normalizeSpent(spent);
  return isValidLimit(limit) && limit > 0 && s >= limit * 1.5 ? "far" : "over";
}

/**
 * 接近上限（借鉴 LiteLLM 的 80% 分级告警）：达到上限的 80% 但尚未超过。
 * **纯提示**，不属于「超限」；已超的 scope 不在此列（交给 checkBudgets，避免同轮两条重复）。
 */
export const BUDGET_NEAR_RATIO = 0.8;

export interface BudgetApproach {
  scope: BudgetScope;
  spent: number;
  limit: number;
  /** 使用比例（spent / limit），用于「已达 …%」文案 */
  ratio: number;
}

export function approachingBudgets(input: {
  dailySpent: number;
  weeklySpent?: number;
  sessionSpent: number;
  budgets: BudgetSettings | null | undefined;
}): BudgetApproach[] {
  const budgets = parseBudgets(input.budgets);
  const out: BudgetApproach[] = [];
  const consider = (scope: BudgetScope, spentRaw: number | undefined, limit: number | undefined) => {
    // 上限 0 没有「接近」语义（任何花费都是超），跳过
    if (limit === undefined || limit <= 0) return;
    const spent = normalizeSpent(spentRaw);
    if (spent > limit) return; // 已超 → 由 checkBudgets 负责
    if (spent >= limit * BUDGET_NEAR_RATIO) {
      out.push({ scope, spent, limit, ratio: spent / limit });
    }
  };
  consider("daily", input.dailySpent, budgets.dailyUsd);
  consider("weekly", input.weeklySpent, budgets.weeklyUsd);
  consider("session", input.sessionSpent, budgets.sessionUsd);
  return out;
}

/** 接近上限的人话（与 formatBudgetNote 同口语径，但不说「超过」而说「已达 …%」）。 */
export function formatApproachNote(items: readonly BudgetApproach[] | null | undefined): string | null {
  if (!items || items.length === 0) return null;
  return items
    .map((item) => `${SCOPE_LABELS[item.scope]}已花费 ${usd(item.spent)}，`
      + `已达设定上限 ${usd(item.limit)} 的 ${Math.round(item.ratio * 100)}%`)
    .join("；");
}
