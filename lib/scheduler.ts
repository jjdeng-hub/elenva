import type { AgentSessionWrapper } from "./agent-runtime";
import {
  computeNextRunAt,
  listScheduleTasks,
  mutateScheduleTask,
  nextRunAtForTask,
  recordScheduleRun,
  type ScheduleRunEvidence,
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
/** 工具错误摘要最多留几条（界面展示用，别无限涨） */
const EVIDENCE_SAMPLE_CAP = 3;

/**
 * 会话启动注入点（**仅供测试**）。
 *
 * 生产路径不设置（null），`triggerTask` 照常动态 import `./session-launch`；
 * 测试用它把执行链换成假会话，从而在不创建真实 pi 会话的前提下回归
 * 「并发触发竞争 / 工具出错后恢复 / prompt 错误 / 超时 / 启动失败」。
 */
export type SchedulerSessionLauncher = (
  cwd: string,
  options: { initialModel?: { provider: string; modelId: string } },
) => Promise<{ session: AgentSessionWrapper; realSessionId: string }>;

let sessionLauncherForTest: SchedulerSessionLauncher | null = null;

/** 设置 / 清除测试注入的会话启动器（传 null 恢复生产路径）。 */
export function setSchedulerSessionLauncherForTest(launcher: SchedulerSessionLauncher | null): void {
  sessionLauncherForTest = launcher;
}

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
  /** 工具错误次数（可恢复错误也计入，不把整轮判成失败） */
  toolErrors: number;
  /** 被护栏拦下的调用次数 */
  blockedCount: number;
  /** 工具错误摘要样例 */
  errorSamples: string[];
  /** 检查类命令统计：出现 ≠ 通过 */
  checksRan: number;
  checksFailed: number;
  lastCheckOk: boolean | null;
  /** toolCallId → 是否检查类命令（等 tool_execution_end 回收） */
  pendingChecks: Map<string, true>;
}

interface SchedulerState {
  started: boolean;
  timer: ReturnType<typeof setInterval> | null;
  /** taskId → 正在跑的运行 */
  runs: Map<string, TaskRun>;
  /**
   * taskId → 已经占位、但会话还没建好的运行（模块 3 安全修复 C）。
   * `triggerTask` 是 async：从「检查无重叠」到「写入 runs」之间有好几个 await，
   * 两次同 tick 的触发会双双通过检查 → 各开一条会话。占位后第二次触发直接 skipped。
   */
  pending: Set<string>;
}

function getState(): SchedulerState {
  const store = globalThis as Record<PropertyKey, unknown>;
  const key = Symbol.for(STATE_KEY);
  const existing = store[key] as SchedulerState | undefined;
  if (existing && existing.runs instanceof Map) {
    // 热重载 / 旧结构（无 pending）就地补齐，不让 Set 缺失把占位保护静默关掉
    if (!(existing.pending instanceof Set)) existing.pending = new Set<string>();
    return existing;
  }
  const state: SchedulerState = { started: false, timer: null, runs: new Map(), pending: new Set<string>() };
  store[key] = state;
  return state;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 工具结果里的文本（内核的结果内容形态不稳定，尽量取全） */
function toolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
      ? (part as { text: string }).text
      : ""))
    .join("\n");
}

/**
 * 检查类命令识别（tsc / 测试 / lint / 自检…）。
 * 只是「这轮跑过验证类动作」的事实信号 —— **出现 ≠ 通过**，通过与否看退出码。
 */
const CHECK_COMMAND_RE = /\b(tsc|vue-tsc|typecheck|type-check|jest|vitest|mocha|pytest|eslint|biome|ruff|mypy|go\s+test|cargo\s+test|npm\s+(test|run\s+(test|check|lint|typecheck))|pnpm\s+(test|run\s+(test|check|lint|typecheck))|yarn\s+(test|(run\s+)?(check|lint|typecheck))|bun\s+test|--noEmit|selftest|style-converge)\b/i;
function isCheckCommand(command: unknown): boolean {
  return typeof command === "string" && CHECK_COMMAND_RE.test(command);
}

/** 护栏拦下的工具结果：reason 前缀固定（见 host-guardrails-extension） */
const BLOCKED_RESULT_RE = /\[(只读|审批|计划模式)\]/;

function summarizeToolError(toolName: unknown, text: string): string {
  const name = typeof toolName === "string" ? toolName : "tool";
  const firstLine = text.split("\n").map((line) => line.trim()).find(Boolean) ?? "工具调用出错";
  return `${name}: ${firstLine.slice(0, 160)}`;
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
  // 重叠保护必须在**同步阶段**就占位：下面的 startTriggeredRun 里有好几个 await，
  // 两次同 tick 的触发会双双通过 runs 检查 → 各开一条会话。实测复现见
  // tools/scheduler-runs-selftest.mjs 的「重复立即运行竞争」用例。
  if (existing || state.pending.has(task.id)) {
    const note = existing ? "上轮未结束" : "上轮正在启动";
    const skipped = {
      at: options.nowISO,
      sessionId: existing?.sessionId ?? "",
      result: "skipped" as ScheduleRunResult,
      note,
    };
    if (options.advanceSchedule) {
      mutateScheduleTask(task.id, (current) => ({ ...current, lastFiredAt: options.nowISO, lastRun: skipped }));
    } else {
      recordScheduleRun(task.id, skipped);
    }
    return { started: false, sessionId: skipped.sessionId, note };
  }
  state.pending.add(task.id);
  try {
    return await startTriggeredRun(task, options);
  } finally {
    // 会话建好时会写进 runs；这里只清占位（幂等，早退 / 抛错也会走到）
    state.pending.delete(task.id);
  }
}

/** 真正建会话并提交 prompt。调用前任务已在 `pending` 里占位（见 triggerTask）。 */
async function startTriggeredRun(task: ScheduleTask, options: TriggerOptions): Promise<TriggerResult> {
  const state = getState();

  // 先落盘（推进 lastFiredAt）后执行：执行前崩了也不会重复触发。
  if (options.advanceSchedule) {
    try {
      mutateScheduleTask(task.id, (current) => ({ ...current, lastFiredAt: options.nowISO }));
    } catch (error) {
      console.error("[elenva] failed to persist lastFiredAt:", errorMessage(error));
    }
  }

  // 懒加载：只有真要跑任务时才把会话执行链（进而 pi 内核）拉进来。
  // 测试注入会话启动器时跳过动态 import（见 setSchedulerSessionLauncherForTest）。
  let startNewAgentSession: typeof import("./session-launch").startNewAgentSession | null = null;
  if (!sessionLauncherForTest) {
    try {
      ({ startNewAgentSession } = await import("./session-launch"));
    } catch (error) {
      const note = `无法加载会话执行链：${errorMessage(error)}`;
      recordScheduleRun(task.id, { at: new Date().toISOString(), sessionId: "", result: "failed", note });
      return { started: false, note };
    }
  }

  let session: AgentSessionWrapper;
  let realSessionId: string;
  const launchOptions = { ...(task.model ? { initialModel: task.model } : {}) };
  try {
    if (sessionLauncherForTest) {
      ({ session, realSessionId } = await sessionLauncherForTest(task.cwd, launchOptions));
    } else {
      ({ session, realSessionId } = await startNewAgentSession!(task.cwd, launchOptions));
    }
  } catch (error) {
    const note = `创建会话失败：${errorMessage(error)}`;
    recordScheduleRun(task.id, { at: new Date().toISOString(), sessionId: "", result: "failed", note });
    return { started: false, note };
  }

  markScheduledSession(realSessionId, task.safety);

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
    toolErrors: 0,
    blockedCount: 0,
    errorSamples: [],
    checksRan: 0,
    checksFailed: 0,
    lastCheckOk: null,
    pendingChecks: new Map(),
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
      return;
    }
    // 执行链证据（模块 3 安全修复 C）：分开记「工具出错」「被护栏拦下」
    // 「跑过什么检查」——它们都不等于任务验收通过，所以要能被单独看见。
    if (event.type === "tool_execution_start") {
      const args = event.args as Record<string, unknown> | undefined;
      if ((event.toolName === "bash" || event.toolName === "powershell") && isCheckCommand(args?.command)) {
        run.pendingChecks.set(String(event.toolCallId ?? ""), true);
      }
      return;
    }
    if (event.type !== "tool_execution_end") return;
    const failed = event.isError === true;
    if (run.pendingChecks.delete(String(event.toolCallId ?? ""))) {
      run.checksRan += 1;
      if (failed) run.checksFailed += 1;
      run.lastCheckOk = !failed;
    }
    if (!failed) return;
    const text = toolResultText(event.result);
    if (BLOCKED_RESULT_RE.test(text)) {
      run.blockedCount += 1;
      return;
    }
    run.toolErrors += 1;
    if (run.errorSamples.length < EVIDENCE_SAMPLE_CAP) {
      run.errorSamples.push(summarizeToolError(event.toolName, text));
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
      durationMs: Date.now() - run.startedAt,
      ...(note ? { note } : {}),
      evidence: {
        toolErrors: run.toolErrors,
        blocked: run.blockedCount,
        checksRan: run.checksRan,
        checksFailed: run.checksFailed,
        lastCheckOk: run.lastCheckOk,
        ...(run.errorSamples.length > 0 ? { sample: run.errorSamples } : {}),
      },
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

/** 该任务是否正在跑（含刚占位、会话还没建好的那一段）。 */
export function isScheduleTaskRunning(taskId: string): boolean {
  const state = getState();
  return state.runs.has(taskId) || state.pending.has(taskId);
}

/** 正在跑的任务 id 集合（含占位中的）。 */
export function getRunningScheduleTaskIds(): Set<string> {
  const state = getState();
  return new Set([...state.runs.keys(), ...state.pending]);
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
