/**
 * 节律会话标记（模块 3 · 第 4 轮；第 6 轮增安全档）。
 *
 * 用途：调度器触发出来的无头会话，必须在**审批口径**上和普通会话区别对待——
 * 它没有人在旁边点确认，所以危险操作一律入队而不是拒绝（见
 * `lib/host-guardrails-extension.ts` 的 noUI 分支）。第 6 轮再进一步：任务自带的
 * 安全档（standard / readonly / full）随会话一起登记，护栏按档位决定
 * 「入队 / 直接拦 / 跳过审批」。
 *
 * 用一个进程内注册表把「这条 sessionId 是节律触发的」告诉护栏扩展。守卫
 * 用 `globalThis` + `Symbol.for` 单例——Next 打包可能把同一模块复制进多个
 * chunk，模块级 Map 会各持一份（pending-approvals 的教训）。
 *
 * 登记带过期时间：任务结束 / 超时后调用 `clearScheduledSession`，仍保留
 * 一段**审计窗口**（默认 10 分钟）——期间 `isScheduledSession` 继续为真，
 * 便于工作台把「这条会话是节律跑的」标出来。窗口过后自动失效。
 */

import type { ScheduleSafety } from "./schedule-format";

const REGISTRY_KEY = "elenva/scheduled-sessions/v1";

/** 登记默认有效期（毫秒）：覆盖一次长任务，跑完由 clear 收尾 */
export const SCHEDULED_SESSION_TTL_MS = 10 * 60 * 1000;
/** 清除后保留的审计窗口（毫秒） */
export const SCHEDULED_SESSION_GRACE_MS = 10 * 60 * 1000;

interface ScheduledSessionEntry {
  /** 失效时间戳（ms） */
  expiresAt: number;
  /** 安全档；未指定时回落 standard */
  tier: ScheduleSafety;
}

interface ScheduledSessionsState {
  /** sessionId → 登记项 */
  entries: Map<string, ScheduledSessionEntry>;
}

function getState(): ScheduledSessionsState {
  const store = globalThis as Record<PropertyKey, unknown>;
  const key = Symbol.for(REGISTRY_KEY);
  const existing = store[key] as ScheduledSessionsState | undefined;
  if (existing && existing.entries instanceof Map) return existing;
  const state: ScheduledSessionsState = { entries: new Map() };
  store[key] = state;
  return state;
}

function prune(state: ScheduledSessionsState, now: number): void {
  for (const [sessionId, entry] of state.entries) {
    if (entry.expiresAt <= now) state.entries.delete(sessionId);
  }
}

/** 归一化档位：登记侧只接受合法取值，其余回落 standard。 */
function normalizeTier(tier: unknown): ScheduleSafety {
  return tier === "readonly" || tier === "full" ? tier : "standard";
}

/** 登记一个节律触发的会话。sid 为空时静默跳过。 */
export function markScheduledSession(
  sessionId: string | null | undefined,
  tier: ScheduleSafety = "standard",
  ttlMs = SCHEDULED_SESSION_TTL_MS,
): void {
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!id) return;
  const state = getState();
  const now = Date.now();
  prune(state, now);
  state.entries.set(id, { expiresAt: now + Math.max(0, ttlMs), tier: normalizeTier(tier) });
}

/**
 * 任务结束 / 超时后清除标记：不立即删除，而是收敛为审计窗口——
 * 让工作台仍能把这轮会话认出来，窗口过后自然失效。档位一并保留。
 */
export function clearScheduledSession(sessionId: string | null | undefined, graceMs = SCHEDULED_SESSION_GRACE_MS): void {
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!id) return;
  const state = getState();
  const entry = state.entries.get(id);
  if (!entry) return;
  state.entries.set(id, { ...entry, expiresAt: Date.now() + Math.max(0, graceMs) });
}

/** 这条会话是否是（或近期曾是）节律触发的。 */
export function isScheduledSession(sessionId: string | null | undefined): boolean {
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!id) return false;
  const state = getState();
  const entry = state.entries.get(id);
  if (!entry) return false;
  if (entry.expiresAt <= Date.now()) {
    state.entries.delete(id);
    return false;
  }
  return true;
}

/**
 * 这条会话登记的安全档；未登记 / 已过期 → null（护栏据此回落到普通会话行为）。
 * 与 `isScheduledSession` 同源，不单独改过期语义。
 */
export function getScheduledSessionTier(sessionId: string | null | undefined): ScheduleSafety | null {
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!id) return null;
  const state = getState();
  const entry = state.entries.get(id);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    state.entries.delete(id);
    return null;
  }
  return entry.tier;
}

/** 当前处于标记期内的会话 id（测试 / 调试用）。 */
export function listScheduledSessionIds(): string[] {
  const state = getState();
  prune(state, Date.now());
  return [...state.entries.keys()];
}
