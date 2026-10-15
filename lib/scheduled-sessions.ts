/**
 * 节律会话标记（模块 3 · 第 4 轮）。
 *
 * 用途：调度器触发出来的无头会话，必须在**审批口径**上和普通会话区别对待——
 * 它没有人在旁边点确认，所以危险操作一律入队而不是拒绝（见
 * `lib/host-guardrails-extension.ts` 的 noUI 分支）。
 *
 * 用一个进程内注册表把「这条 sessionId 是节律触发的」告诉护栏扩展。守卫
 * 用 `globalThis` + `Symbol.for` 单例——Next 打包可能把同一模块复制进多个
 * chunk，模块级 Map 会各持一份（pending-approvals 的教训）。
 *
 * 登记带过期时间：任务结束 / 超时后调用 `clearScheduledSession`，仍保留
 * 一段**审计窗口**（默认 10 分钟）——期间 `isScheduledSession` 继续为真，
 * 便于工作台把「这条会话是节律跑的」标出来。窗口过后自动失效。
 */

const REGISTRY_KEY = "elenva/scheduled-sessions/v1";

/** 登记默认有效期（毫秒）：覆盖一次长任务，跑完由 clear 收尾 */
export const SCHEDULED_SESSION_TTL_MS = 10 * 60 * 1000;
/** 清除后保留的审计窗口（毫秒） */
export const SCHEDULED_SESSION_GRACE_MS = 10 * 60 * 1000;

interface ScheduledSessionsState {
  /** sessionId → 失效时间戳（ms） */
  entries: Map<string, number>;
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
  for (const [sessionId, expiresAt] of state.entries) {
    if (expiresAt <= now) state.entries.delete(sessionId);
  }
}

/** 登记一个节律触发的会话。sid 为空时静默跳过。 */
export function markScheduledSession(sessionId: string | null | undefined, ttlMs = SCHEDULED_SESSION_TTL_MS): void {
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!id) return;
  const state = getState();
  const now = Date.now();
  prune(state, now);
  state.entries.set(id, now + Math.max(0, ttlMs));
}

/**
 * 任务结束 / 超时后清除标记：不立即删除，而是收敛为审计窗口——
 * 让工作台仍能把这轮会话认出来，窗口过后自然失效。
 */
export function clearScheduledSession(sessionId: string | null | undefined, graceMs = SCHEDULED_SESSION_GRACE_MS): void {
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!id) return;
  const state = getState();
  if (!state.entries.has(id)) return;
  state.entries.set(id, Date.now() + Math.max(0, graceMs));
}

/** 这条会话是否是（或近期曾是）节律触发的。 */
export function isScheduledSession(sessionId: string | null | undefined): boolean {
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!id) return false;
  const state = getState();
  const expiresAt = state.entries.get(id);
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) {
    state.entries.delete(id);
    return false;
  }
  return true;
}

/** 当前处于标记期内的会话 id（测试 / 调试用）。 */
export function listScheduledSessionIds(): string[] {
  const state = getState();
  prune(state, Date.now());
  return [...state.entries.keys()];
}
