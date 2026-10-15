import { getAgentSession } from "./agent-runtime";
import type { AgentSessionWrapper } from "./agent-runtime";
import {
  computeNextRunAt,
  listScheduleTasks,
  mutateScheduleTask,
  nextRunAtForTask,
  recordScheduleRun,
  type ScheduleRunResult,
  type ScheduleTask,
} from "./schedules";
import { clearScheduledSession, markScheduledSession } from "./scheduled-sessions";

/**
 * 节律调度器（模块 3 · 第 4 轮）—— 单例调度循环 + 无头会话执行。
 *
 * 设计取舍：
 *  · **单例**：模块级 + `globalThis`（`Symbol.for`）双保险。Next 打包可能把同一
 *    模块复制进多个 chunk，模块级变量会各持一份，于是出现两个调度循环
 *    （pending-approvals / session-liveness 的同款教训）。
 *  · **惰性**：`ensureSchedulerStarted()` 由服务启动路径或 `/api/schedules`
 *    调用。会话执行走**动态 import**（`lib/session-launch`），所以挂载调度器
 *    本身不会把 pi 内核拉进启动路径。
 *  · **先落盘后执行**：触发前先把 `lastFiredAt` 写进存储，执行过程中进程崩了
 *    也只是少跑一次，不会重复触发。
 *  · **绝不拖垮服务**：tick 全 try/catch，任何一步异常只记日志。
 *
 * 触发 = 一条无头会话（工作台可见、可审计）。任务在跑时用进程内 `runs` 做
 * 重叠保护；结束状态由 30s tick 顺带回收。
 */

const STATE_KEY = "elenva/scheduler/v1";
/** tick 间隔：节律的最小颗粒是分钟，30s 足够不迟到太多，也不浪费。 */
export const SCHEDULER_TICK_MS = 30_000;
/** 刚起会话时的宽限：避免 prompt 还没真正开跑就被判定「已结束」。 */
const RUN_REAP_GRACE_MS = 3_000;

interface TaskRun {
  taskId: string;
  sessionId: string;
  session: AgentSessionWrapper;
  startedAt: number;
  deadlineAt: number | null;
  timeout: number | null;
  abortRequested: "timeout" | null;
  error: string | null;
  unsubscribe: () => void;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
}

interface SchedulerState {
  started: boolean;
  timer: ReturnType<typeof setInterval> | null;
  /** taskId → 正在跑的运行 */
  runs: Map<string, TaskRun>;
}

function getState(): SchedulerState {
  const store = globalThis as Record<PropertyKey, unknown>;
  const key = Symbol.for(STATE_KEY);
  const existing = store[key] as SchedulerState | undefined;
  if (existing && existing.runs instanceof Map) return existing;
  const state: SchedulerState = { started: false, timer: null, runs: new Map() };
  store[key] = state;
  return state;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 本地时间的会话标题：节律 · {name} · {MM-DD HH:mm} */
function sessionTitle(task: ScheduleTask, atISO: string): string {
  const date = new Date(atISO);
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return `节律 · ${task.name} · ${stamp}`;
}

// ============================================================================
// 执行
// ============================================================================

interface TriggerOptions {
  /** true = 按计划触发（推进 lastFiredAt）；false = 立即运行（不改计划） */
  advanceSchedule: boolean;
  nowISO: string;
}

export interface TriggerResult {
  started: boolean;
  sessionId?: string;
  note?: string;
}

/**
 * 触发一次任务。重叠保护在这里统一处理：任务已在跑 → 记 skipped 并返回，
 * 不创建第二条会话。`advanceSchedule` 为真时先落盘再执行。
 */
async function triggerTask(task: ScheduleTask, options: TriggerOptions): Promise<TriggerResult> {
  const state = getState();
  const existing = state.runs.get(task.id);
  if (existing) {
    const skipped = {
      at: options.nowISO,
      sessionId: existing.sessionId,
      result: "skipped" as ScheduleRunResult,
      note: "上轮未结束",
    };
    if (options.advanceSchedule) {
      mutateScheduleTask(task.id, (current) => ({ ...current, lastFiredAt: options.nowISO, lastRun: skipped }));
    } else {
      recordScheduleRun(task.id, skipped);
    }
    return { started: false, sessionId: existing.sessionId, note: "上轮未结束" };
  }

  // 先落盘（推进 lastFiredAt）后执行：执行前崩了也不会重复触发。
  if (options.advanceSchedule) {
    try {
      mutateScheduleTask(task.id, (current) => ({ ...current, lastFiredAt: options.nowISO }));
    } catch (error) {
      console.error("[elenva] failed to persist lastFiredAt:", errorMessage(error));
    }
  }

  // 懒加载：只有真要跑任务时才把会话执行链（进而 pi 内核）拉进来。
  let startNewAgentSession: typeof import("./session-launch").startNewAgentSession;
  try {
    ({ startNewAgentSession } = await import("./session-launch"));
  } catch (error) {
    const note = `无法加载会话执行链：${errorMessage(error)}`;
    recordScheduleRun(task.id, { at: new Date().toISOString(), sessionId: "", result: "failed", note });
    return { started: false, note };
  }

  let session: AgentSessionWrapper;
  let realSessionId: string;
  try {
    ({ session, realSessionId } = await startNewAgentSession(task.cwd, {
      ...(task.model ? { initialModel: task.model } : {}),
    }));
  } catch (error) {
    const note = `创建会话失败：${errorMessage(error)}`;
    recordScheduleRun(task.id, { at: new Date().toISOString(), sessionId: "", result: "failed", note });
    return { started: false, note };
  }

  markScheduledSession(realSessionId);

  const run: TaskRun = {
    taskId: task.id,
    sessionId: realSessionId,
    session,
    startedAt: Date.now(),
    deadlineAt: null,
    timeout: task.timeoutMinutes ?? null,
    abortRequested: null,
    error: null,
    unsubscribe: () => {},
    timeoutTimer: null,
  };

  // 会话标题：内核支持 set_session_name 就设，失败只是没标题，不影响执行。
  try {
    await session.send({ type: "set_session_name", name: sessionTitle(task, options.nowISO) });
  } catch (error) {
    console.error("[elenva] failed to set scheduled session title:", errorMessage(error));
  }

  run.unsubscribe = session.onEvent((event) => {
    if (event.type === "prompt_error") {
      run.error = typeof event.errorMessage === "string" ? event.errorMessage : "执行失败";
    }
  });

  if (run.timeout) {
    run.deadlineAt = run.startedAt + run.timeout * 60_000;
    run.timeoutTimer = setTimeout(() => requestTimeout(run), run.timeout * 60_000);
    run.timeoutTimer.unref?.();
  }

  state.runs.set(task.id, run);

  try {
    await session.send({ type: "prompt", message: task.prompt });
  } catch (error) {
    const note = `会话未接受任务：${errorMessage(error)}`;
    finishRun(run, "failed", note);
    return { started: false, sessionId: realSessionId, note };
  }

  return { started: true, sessionId: realSessionId };
}

/** 超时：请求中止会话（内核 abort），结果由下一次 tick 回收。 */
function requestTimeout(run: TaskRun): void {
  if (run.abortRequested) return;
  run.abortRequested = "timeout";
  void run.session.send({ type: "abort" }).catch((error) => {
    console.error("[elenva] scheduled session abort failed:", errorMessage(error));
    finishRun(run, "timeout", "执行超时（中止会话失败）");
  }).finally(() => {
    // abort 通常会很快结束运行；给一点时间后主动回收一次，免得等满一个 tick。
    const followUp = setTimeout(() => { void reconcileRuns(); }, 2_500);
    followUp.unref?.();
  });
}

function finishRun(run: TaskRun, result: ScheduleRunResult, note?: string): void {
  const state = getState();
  if (state.runs.get(run.taskId) !== run) return;
  state.runs.delete(run.taskId);
  if (run.timeoutTimer) clearTimeout(run.timeoutTimer);
  try {
    run.unsubscribe();
  } catch {
    /* 旁路：取消订阅失败不影响收尾 */
  }
  clearScheduledSession(run.sessionId);
  try {
    recordScheduleRun(run.taskId, {
      at: new Date().toISOString(),
      sessionId: run.sessionId,
      result,
      ...(note ? { note } : {}),
    });
  } catch (error) {
    console.error("[elenva] failed to record scheduled run:", errorMessage(error));
  }
}

// ============================================================================
// tick
// ============================================================================

/** 回收已结束的运行（任务结束 / 超时）。 */
export async function reconcileRuns(): Promise<void> {
  const state = getState();
  const now = Date.now();
  for (const run of [...state.runs.values()]) {
    if (run.deadlineAt && now > run.deadlineAt && run.abortRequested !== "timeout") {
      requestTimeout(run);
    }
    if (now - run.startedAt < RUN_REAP_GRACE_MS) continue;
    if (run.session.isRunning()) continue;
    if (run.abortRequested === "timeout") {
      finishRun(run, "timeout", `执行超过 ${run.timeout} 分钟，已中止`);
    } else if (run.error) {
      finishRun(run, "failed", run.error);
    } else {
      finishRun(run, "ok", "执行结束（未捕获错误信号）");
    }
  }
}

/** 到点的任务依次触发。 */
async function fireDueTasks(): Promise<void> {
  const now = new Date();
  const nowISO = now.toISOString();
  for (const task of listScheduleTasks()) {
    if (!task.enabled) continue;
    let next: string;
    try {
      next = nextRunAtForTask(task);
    } catch (error) {
      console.error(`[elenva] schedule ${task.id} next-run failed:`, errorMessage(error));
      continue;
    }
    if (new Date(next).getTime() > now.getTime()) continue;
    await triggerTask(task, { advanceSchedule: true, nowISO });
  }
}

/**
 * 启动时处理「服务未运行期间错过」的触发：catchUp=false 的任务落一条
 * skipped 并把 lastFiredAt 推到 now；catchUp=true 的交给紧接着的 tick 补跑。
 */
function skipMissedRuns(): void {
  const now = new Date();
  const nowISO = now.toISOString();
  for (const task of listScheduleTasks()) {
    if (!task.enabled || task.catchUp) continue;
    let next: string;
    try {
      next = nextRunAtForTask(task);
    } catch {
      continue;
    }
    if (new Date(next).getTime() > now.getTime()) continue;
    try {
      mutateScheduleTask(task.id, (current) => ({
        ...current,
        lastFiredAt: nowISO,
        lastRun: { at: nowISO, sessionId: "", result: "skipped", note: "错过（服务未运行）" },
      }));
    } catch (error) {
      console.error("[elenva] failed to record missed schedule:", errorMessage(error));
    }
  }
}

async function runTick(): Promise<void> {
  try {
    await reconcileRuns();
  } catch (error) {
    console.error("[elenva] scheduler reconcile failed:", errorMessage(error));
  }
  try {
    await fireDueTasks();
  } catch (error) {
    console.error("[elenva] scheduler tick failed:", errorMessage(error));
  }
}

// ============================================================================
// 生命周期
// ============================================================================

/**
 * 启动单例调度循环（幂等）。首个调用者启动；服务启动路径与
 * `/api/schedules` 都可调，重复调用是空操作。
 */
export function ensureSchedulerStarted(): void {
  const state = getState();
  if (state.started) return;
  state.started = true;
  try {
    skipMissedRuns();
  } catch (error) {
    console.error("[elenva] scheduler catch-up scan failed:", errorMessage(error));
  }
  state.timer = setInterval(() => { void runTick(); }, SCHEDULER_TICK_MS);
  state.timer.unref?.();
  void runTick();
}

/** 主动跑一次 tick（测试 / 手动催发用）。 */
export async function runSchedulerTickOnce(): Promise<void> {
  await runTick();
}

/** 立即运行某任务（无视 nextRunAt；enabled=false 也可；仍受重叠保护）。 */
export async function runScheduleTaskNow(taskId: string): Promise<TriggerResult> {
  const task = listScheduleTasks().find((item) => item.id === taskId);
  if (!task) throw new Error("找不到该节律任务");
  // 手动触发不应改动计划：用 createdAt/lastFiredAt 的既有推算不动，只执行一次。
  return triggerTask(task, { advanceSchedule: false, nowISO: new Date().toISOString() });
}

/** 该任务是否正在跑（getter 供 API 标记 running）。 */
export function isScheduleTaskRunning(taskId: string): boolean {
  return getState().runs.has(taskId);
}

/** 正在跑的任务 id 集合。 */
export function getRunningScheduleTaskIds(): Set<string> {
  return new Set(getState().runs.keys());
}

/** 正在跑的运行快照（调试 / 测试用）。 */
export function getScheduleRuns(): Array<{ taskId: string; sessionId: string; startedAt: number; deadlineAt: number | null }> {
  return [...getState().runs.values()].map((run) => ({
    taskId: run.taskId,
    sessionId: run.sessionId,
    startedAt: run.startedAt,
    deadlineAt: run.deadlineAt,
  }));
}

// 供 store 层复用的纯函数再导出（API / 测试常一起用）。
export { computeNextRunAt, nextRunAtForTask };
