import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { normalizeSafety, parseCronExpr, SAFETY_VALUES, type CronSpec, type Schedule, type ScheduleSafety } from "./schedule-format";

/**
 * 节律（模块 3 · 第 4 轮）—— 任务存储与纯函数层。
 *
 * 摩擦：日报、巡查、复核这类活儿按固定节奏反复发生，现在只能靠人记着去开
 * 会话。节律 = ELENVA 自持调度：每条任务按规则触发一次无头会话（工作台可见、
 * 可审计、可续聊）。本文件只管「存什么」和「下次何时该跑」——纯函数，可单测，
 * 不碰调度循环与执行（那些在 lib/scheduler.ts）。
 *
 * 存储：`<agentDir>/elenva-schedules.json`，`{version:1, tasks:[...]}`，原子写 +
 * 0600；读取容错——坏任务逐条丢弃，不因为一条脏数据让整份规则失效。
 *
 * 时区：computeNextRunAt 一律按**本地时区**计算（用户按自己的钟点设时间点）。
 */

// ============================================================================
// 常量与类型
// ============================================================================

/** 任务数上限：够日常节律用，又不至于让调度循环无界。 */
export const MAX_SCHEDULES = 50;
/** 任务名长度（trim 后 1–40 字） */
export const SCHEDULE_NAME_MAX = 40;
/** 任务内容长度（trim 后 1–4000 字） */
export const SCHEDULE_PROMPT_MAX = 4000;
/** 触发规则文件 */
export const SCHEDULES_FILE = "elenva-schedules.json";
/** 运行历史最多保留多少条（新→旧，超限丢最旧） */
export const RUN_HISTORY_CAP = 20;

/** cron 求值最多向前找 5 年，超出即认为该规则永不命中。 */
const CRON_MAX_DAYS = 366 * 5;

// 触发规则类型与 cron 解析的实现在 lib/schedule-format.ts（纯函数层，客户端可导入）；
// 这里 re-export，保证既有 `@/lib/schedules` 导入点不变。
export type { Schedule, ScheduleSafety } from "./schedule-format";
export { parseCronExpr, describeSchedule, cronExprError, WEEKDAY_NAMES, describeSafety, normalizeSafety, SAFETY_TIER_META, SAFETY_VALUES } from "./schedule-format";

export type ScheduleRunResult = "ok" | "failed" | "skipped" | "timeout";

export interface ScheduleLastRun {
  at: string;
  sessionId: string;
  result: ScheduleRunResult;
  note?: string;
  /** 本轮运行时长（ms）；additive，旧记录 / 取不到时省略 */
  durationMs?: number;
  /**
   * 本轮执行链的可观测信号（additive，模块 3 安全修复 C）。
   *
   * 存在的理由：`result: "ok"` 只表示「会话正常跑完」，**不等于任务验收通过** ——
   * 工具报错、被护栏拦下、压根没跑检查，都可能是一轮「正常结束」。
   * 这里把这三类信号分开存，界面显示「执行结束」而不是「成功」。
   */
  evidence?: ScheduleRunEvidence;
}

/** 执行链证据：只记**观测到的事实**，绝不推断「通过」 */
export interface ScheduleRunEvidence {
  /** 工具调用出错次数（可恢复错误也计入，不把整轮判成失败） */
  toolErrors: number;
  /** 被护栏拦下的调用次数（只读档 / 审批入队 / 计划模式） */
  blocked: number;
  /** 本轮出现过的「检查类命令」次数（出现 ≠ 通过） */
  checksRan: number;
  /** 其中失败的次数 */
  checksFailed: number;
  /** 最近一次检查类命令是否成功；没跑过任何检查则为 null */
  lastCheckOk: boolean | null;
  /** 工具错误摘要样例（≤3 条） */
  sample?: string[];
}

/** 运行历史条目：与 lastRun 同形（UI 逐条展示） */
export type ScheduleRunEntry = ScheduleLastRun;

export interface ScheduleTask {
  id: string;
  name: string;
  enabled: boolean;
  schedule: Schedule;
  prompt: string;
  /** 绝对路径，且创建/编辑时必须已存在 */
  cwd: string;
  /** 缺省 = 系统默认模型 */
  model?: { provider: string; modelId: string };
  /** 本轮只实现 standard（危险操作入队）；readonly/full 留字段，下轮实现 */
  safety: ScheduleSafety;  /** 服务未运行时错过的触发是否补跑一次（默认 false = 只记 skipped） */
  catchUp: boolean;
  /** 单次执行超时（分钟）；null / 缺省 = 不限时 */
  timeoutMinutes: number | null;
  /** 上次触发（含补跑 / 跳过）的时间，用于推算下一次 */
  lastFiredAt?: string;
  lastRun?: ScheduleLastRun;
  /** 运行历史（新→旧，cap RUN_HISTORY_CAP）；additive，旧任务没有此字段照常工作 */
  runHistory?: ScheduleRunEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateScheduleInput {
  name: string;
  schedule: Schedule;
  prompt: string;
  cwd: string;
  enabled?: boolean;
  model?: { provider: string; modelId: string } | null;
  safety?: ScheduleSafety;
  catchUp?: boolean;
  timeoutMinutes?: number | null;
}

/** 用户可编辑的字段（lastFiredAt / lastRun 由调度器写，不在此列） */
export type ScheduleTaskPatch = Partial<Pick<
  ScheduleTask,
  "name" | "enabled" | "schedule" | "prompt" | "cwd" | "model" | "safety" | "catchUp" | "timeoutMinutes"
>>;

// ============================================================================
// cron 求值（解析在 lib/schedule-format.ts）
// ============================================================================

/** 周内某天是否命中：标准 cron —— 日 / 周都受限时取「或」，否则取受限的那一个。 */
function cronDayMatches(date: Date, spec: CronSpec): boolean {
  const domOk = spec.doms.has(date.getDate());
  const dowOk = spec.dows.has(date.getDay());
  if (!spec.domRestricted && !spec.dowRestricted) return true;
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk;
  return spec.domRestricted ? domOk : dowOk;
}

function nextCronRun(expr: string, from: Date): Date {
  const spec = parseCronExpr(expr);
  const hours = [...spec.hours].sort((a, b) => a - b);
  const minutes = [...spec.minutes].sort((a, b) => a - b);
  // 严格晚于 from，最小颗粒 = 分钟
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  for (let day = 0; day < CRON_MAX_DAYS; day++) {
    if (spec.months.has(cursor.getMonth() + 1) && cronDayMatches(cursor, spec)) {
      const startHour = cursor.getHours();
      const startMinute = cursor.getMinutes();
      for (const hour of hours) {
        if (hour < startHour) continue;
        for (const minute of minutes) {
          if (hour === startHour && minute < startMinute) continue;
          const candidate = new Date(cursor.getTime());
          candidate.setHours(hour, minute, 0, 0);
          if (candidate.getTime() > from.getTime()) return candidate;
        }
      }
    }
    cursor.setDate(cursor.getDate() + 1);
    cursor.setHours(0, 0, 0, 0);
  }
  throw new Error(`cron 在 5 年内没有可运行的时间：${expr}`);
}

// ============================================================================
// 时间点工具
// ============================================================================

function parseAt(at: string, label: string): { hours: number; minutes: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(typeof at === "string" ? at.trim() : "");
  if (!match) throw new Error(`${label}时间点格式应为 HH:MM`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw new Error(`${label}时间点超出范围：${at}`);
  return { hours, minutes };
}

function toDate(fromISO: string): Date {
  const date = new Date(fromISO);
  if (Number.isNaN(date.getTime())) throw new Error(`起点时间不合法：${fromISO}`);
  return date;
}

/**
 * 计算 schedule 在 fromISO **之后**的第一次运行时间（本地时区，纯函数）。
 * 返回 ISO 字符串。schedule 非法或 cron 永不命中时抛错。
 */
export function computeNextRunAt(schedule: Schedule, fromISO: string): string {
  if (!schedule || typeof schedule !== "object") throw new Error("触发规则不合法");
  const from = toDate(typeof fromISO === "string" && fromISO ? fromISO : new Date().toISOString());

  switch (schedule.kind) {
    case "hourly": {
      const minute = schedule.minute;
      if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
        throw new Error(`每小时的分钟数应在 0-59：${String(minute)}`);
      }
      const date = new Date(from.getTime());
      date.setMinutes(minute, 0, 0);
      if (date.getTime() <= from.getTime()) date.setHours(date.getHours() + 1);
      return date.toISOString();
    }
    case "daily": {
      const { hours, minutes } = parseAt(schedule.at, "每天");
      const date = new Date(from.getTime());
      date.setHours(hours, minutes, 0, 0);
      if (date.getTime() <= from.getTime()) date.setDate(date.getDate() + 1);
      return date.toISOString();
    }
    case "weekly": {
      const weekday = schedule.weekday;
      if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
        throw new Error(`每周的星期几应在 0-6（0=周日）：${String(weekday)}`);
      }
      const { hours, minutes } = parseAt(schedule.at, "每周");
      const date = new Date(from.getTime());
      date.setHours(hours, minutes, 0, 0);
      const offset = ((weekday - date.getDay()) + 7) % 7;
      date.setDate(date.getDate() + offset);
      if (date.getTime() <= from.getTime()) date.setDate(date.getDate() + 7);
      return date.toISOString();
    }
    case "cron": {
      if (typeof schedule.expr !== "string" || !schedule.expr.trim()) {
        throw new Error("cron 表达式不能为空");
      }
      return nextCronRun(schedule.expr, from).toISOString();
    }
    default:
      throw new Error(`未知的触发规则类型：${String((schedule as { kind?: unknown }).kind)}`);
  }
}

/** 一次触发之后的下次运行：等于从 lastFiredAt（缺省 createdAt）推算。 */
export function nextRunAtForTask(task: ScheduleTask, fromISO?: string): string {
  return computeNextRunAt(task.schedule, fromISO ?? task.lastFiredAt ?? task.createdAt);
}

// ============================================================================
// 校验
// ============================================================================

/** 归一化并校验触发规则；非法即抛错。 */
export function validateSchedule(schedule: unknown): Schedule {
  if (!schedule || typeof schedule !== "object") throw new Error("触发规则不能为空");
  const raw = schedule as Record<string, unknown>;
  switch (raw.kind) {
    case "hourly": {
      const minute = Number(raw.minute);
      if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
        throw new Error("每小时触发的分钟数应在 0-59");
      }
      return { kind: "hourly", minute };
    }
    case "daily": {
      const at = String(raw.at ?? "");
      parseAt(at, "每天");
      return { kind: "daily", at };
    }
    case "weekly": {
      const weekday = Number(raw.weekday);
      if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
        throw new Error("每周触发需要 weekday 在 0-6（0=周日）");
      }
      const at = String(raw.at ?? "");
      parseAt(at, "每周");
      return { kind: "weekly", weekday, at };
    }
    case "cron": {
      const expr = typeof raw.expr === "string" ? raw.expr.trim() : "";
      parseCronExpr(expr);
      return { kind: "cron", expr };
    }
    default:
      throw new Error("触发规则 kind 必须是 hourly / daily / weekly / cron");
  }
}

function validateName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw new Error("任务名称不能为空");
  if (name.length > SCHEDULE_NAME_MAX) throw new Error(`任务名称最长 ${SCHEDULE_NAME_MAX} 字`);
  return name;
}

function validatePrompt(value: unknown): string {
  const prompt = typeof value === "string" ? value.trim() : "";
  if (!prompt) throw new Error("任务内容不能为空");
  if (prompt.length > SCHEDULE_PROMPT_MAX) throw new Error(`任务内容最长 ${SCHEDULE_PROMPT_MAX} 字`);
  return prompt;
}

function validateCwd(value: unknown): string {
  const cwd = typeof value === "string" ? value.trim() : "";
  if (!cwd) throw new Error("工作区路径不能为空");
  if (!isAbsolute(cwd)) throw new Error("工作区必须是绝对路径");
  if (!existsSync(cwd)) throw new Error(`工作区目录不存在：${cwd}`);
  return cwd;
}

function validateModel(value: unknown): { provider: string; modelId: string } | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") throw new Error("模型参数不合法");
  const { provider, modelId } = value as { provider?: unknown; modelId?: unknown };
  if (typeof provider !== "string" || !provider.trim() || typeof modelId !== "string" || !modelId.trim()) {
    throw new Error("模型需要 provider 与 modelId");
  }
  return { provider: provider.trim(), modelId: modelId.trim() };
}

function validateSafety(value: unknown): ScheduleSafety {
  if (value === undefined) return "standard";
  if (typeof value !== "string" || !SAFETY_VALUES.includes(value as ScheduleSafety)) {
    throw new Error("safety 只能是 standard / readonly / full");
  }
  return value as ScheduleSafety;
}

function validateTimeout(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) {
    throw new Error("超时时间应是 1 分钟 ~ 1440 分钟的数值（或留空）");
  }
  return Math.round(minutes);
}

function validateCatchUp(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new Error("catchUp 必须是布尔值");
  return value;
}

/**
 * 「下一分钟」启发式 sanity：能算出下一跳、且它严格晚于 now，才算可用。
 * 例：daily at=25:00 在 parseAt 就被拒；`0 0 31 2 *` 这类永不命中的 cron
 * 会在这里被拒（computeNextRunAt 抛「5 年内没有可运行的时间」）。
 */
export function assertScheduleRunnable(schedule: Schedule, nowISO = new Date().toISOString()): void {
  const next = computeNextRunAt(schedule, nowISO);
  if (!(new Date(next).getTime() > new Date(nowISO).getTime())) {
    throw new Error("该规则算出的下一次运行时间不在将来");
  }
}

// ============================================================================
// 存储
// ============================================================================

interface StoredFile {
  version: 1;
  tasks: ScheduleTask[];
}

export function getSchedulesPath(agentDir = getAgentDir()): string {
  return join(agentDir, SCHEDULES_FILE);
}

function validIsoOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** 运行历史容错归一：坏条目逐条丢弃，只留合法项，最多 RUN_HISTORY_CAP 条。 */
function normalizeRunHistory(value: unknown): ScheduleRunEntry[] {
  if (!Array.isArray(value)) return [];
  const out: ScheduleRunEntry[] = [];
  for (const item of value) {
    const entry = normalizeLastRun(item);
    if (entry) out.push(entry);
    if (out.length >= RUN_HISTORY_CAP) break;
  }
  return out;
}

function normalizeLastRun(value: unknown): ScheduleLastRun | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const result = raw.result;
  if (result !== "ok" && result !== "failed" && result !== "skipped" && result !== "timeout") return undefined;
  if (typeof raw.at !== "string" || typeof raw.sessionId !== "string") return undefined;
  const durationMs = typeof raw.durationMs === "number" && Number.isFinite(raw.durationMs) && raw.durationMs >= 0
    ? Math.round(raw.durationMs)
    : undefined;
  return {
    at: raw.at,
    sessionId: raw.sessionId,
    result,
    ...(typeof raw.note === "string" && raw.note ? { note: raw.note } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(normalizeRunEvidence(raw.evidence) ? { evidence: normalizeRunEvidence(raw.evidence) } : {}),
  };
}

/** 证据容错归一：字段缺失 / 类型不对就保守归零，坏数据不能把整条记录带垮 */
function normalizeRunEvidence(value: unknown): ScheduleRunEvidence | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const count = (input: unknown): number =>
    typeof input === "number" && Number.isFinite(input) && input >= 0 ? Math.round(input) : 0;
  const sample = Array.isArray(raw.sample)
    ? raw.sample.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, 3)
    : [];
  return {
    toolErrors: count(raw.toolErrors),
    blocked: count(raw.blocked),
    checksRan: count(raw.checksRan),
    checksFailed: count(raw.checksFailed),
    lastCheckOk: typeof raw.lastCheckOk === "boolean" ? raw.lastCheckOk : null,
    ...(sample.length > 0 ? { sample } : {}),
  };
}

/** 单条容错归一：任一关键字段坏了就返回 null（调用方逐条丢弃）。 */
function normalizeStoredTask(value: unknown, now: string): ScheduleTask | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !raw.id) return null;
  let schedule: Schedule;
  try {
    schedule = validateSchedule(raw.schedule);
  } catch {
    return null;
  }
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
  const cwd = typeof raw.cwd === "string" ? raw.cwd.trim() : "";
  if (!name || !prompt || !cwd) return null;
  const model = (() => {
    try {
      return validateModel(raw.model);
    } catch {
      return undefined;
    }
  })();
  const safety = normalizeSafety(raw.safety);
  const timeout = (() => {
    try {
      return validateTimeout(raw.timeoutMinutes);
    } catch {
      return null;
    }
  })();
  const runHistory = normalizeRunHistory(raw.runHistory);
  return {
    id: raw.id,
    name,
    enabled: raw.enabled !== false,
    schedule,
    prompt,
    cwd,
    ...(model ? { model } : {}),
    safety,
    catchUp: raw.catchUp === true,
    timeoutMinutes: timeout,
    ...(validIsoOrUndefined(raw.lastFiredAt) ? { lastFiredAt: raw.lastFiredAt as string } : {}),
    ...(normalizeLastRun(raw.lastRun) ? { lastRun: normalizeLastRun(raw.lastRun) as ScheduleLastRun } : {}),
    ...(runHistory.length > 0 ? { runHistory } : {}),
    createdAt: typeof raw.createdAt === "string" && raw.createdAt ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === "string" && raw.updatedAt ? raw.updatedAt : now,
  };
}

/** 读全量任务；缺失 / 损坏 → 空 / 逐条丢弃。不抛。 */
export function listScheduleTasks(agentDir?: string): ScheduleTask[] {
  const path = getSchedulesPath(agentDir);
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const tasks = (parsed as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) return [];
  const now = new Date().toISOString();
  const out: ScheduleTask[] = [];
  for (const item of tasks) {
    const task = normalizeStoredTask(item, now);
    if (task) out.push(task);
  }
  return out;
}

function writeScheduleTasks(tasks: ScheduleTask[], agentDir?: string): void {
  const path = getSchedulesPath(agentDir);
  mkdirSync(dirname(path), { recursive: true });
  const payload: StoredFile = { version: 1, tasks };
  writePrivateFileAtomicSync(path, JSON.stringify(payload, null, 2));
}

export function getScheduleTask(id: string, agentDir?: string): ScheduleTask | undefined {
  return listScheduleTasks(agentDir).find((task) => task.id === id);
}

function newScheduleId(): string {
  return `sched-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

export function createScheduleTask(input: CreateScheduleInput, agentDir?: string): ScheduleTask {
  const name = validateName(input?.name);
  const prompt = validatePrompt(input?.prompt);
  const cwd = validateCwd(input?.cwd);
  const schedule = validateSchedule(input?.schedule);
  assertScheduleRunnable(schedule);
  const model = validateModel(input?.model);
  const safety = validateSafety(input?.safety);
  const catchUp = validateCatchUp(input?.catchUp);
  const timeoutMinutes = validateTimeout(input?.timeoutMinutes);
  const enabled = input?.enabled === undefined ? true : Boolean(input.enabled);

  const tasks = listScheduleTasks(agentDir);
  if (tasks.length >= MAX_SCHEDULES) {
    throw new Error(`节律任务最多 ${MAX_SCHEDULES} 个，先删掉一些再建`);
  }
  const now = new Date().toISOString();
  const task: ScheduleTask = {
    id: newScheduleId(),
    name,
    enabled,
    schedule,
    prompt,
    cwd,
    ...(model ? { model } : {}),
    safety,
    catchUp,
    timeoutMinutes,
    createdAt: now,
    updatedAt: now,
  };
  writeScheduleTasks([...tasks, task], agentDir);
  return task;
}

/**
 * 底层改一条任务：读 → mutate → 写。mutate 返回 null 表示「不改」（例如
 * 任务已不存在 / 正在跑的重叠判定），此时不写盘。返回改动后的任务或 undefined。
 */
export function mutateScheduleTask(
  id: string,
  mutate: (task: ScheduleTask) => ScheduleTask | null,
  agentDir?: string,
): ScheduleTask | undefined {
  const tasks = listScheduleTasks(agentDir);
  const index = tasks.findIndex((task) => task.id === id);
  if (index < 0) return undefined;
  const next = mutate(tasks[index]);
  if (!next) return tasks[index];
  const updated = { ...next, updatedAt: next.updatedAt || tasks[index].updatedAt };
  const copy = [...tasks];
  copy[index] = updated;
  writeScheduleTasks(copy, agentDir);
  return updated;
}

export function updateScheduleTask(id: string, patch: ScheduleTaskPatch, agentDir?: string): ScheduleTask {
  const tasks = listScheduleTasks(agentDir);
  const existing = tasks.find((task) => task.id === id);
  if (!existing) throw new Error("找不到该节律任务");

  const next: ScheduleTask = { ...existing };
  if (patch.name !== undefined) next.name = validateName(patch.name);
  if (patch.prompt !== undefined) next.prompt = validatePrompt(patch.prompt);
  if (patch.cwd !== undefined) next.cwd = validateCwd(patch.cwd);
  if (patch.schedule !== undefined) {
    const schedule = validateSchedule(patch.schedule);
    assertScheduleRunnable(schedule);
    next.schedule = schedule;
  }
  if (patch.model !== undefined) {
    const model = validateModel(patch.model);
    if (model) next.model = model;
    else delete next.model;
  }
  if (patch.safety !== undefined) next.safety = validateSafety(patch.safety);
  if (patch.catchUp !== undefined) next.catchUp = validateCatchUp(patch.catchUp);
  if (patch.timeoutMinutes !== undefined) next.timeoutMinutes = validateTimeout(patch.timeoutMinutes);
  if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
  next.updatedAt = new Date().toISOString();

  const copy = tasks.map((task) => (task.id === id ? next : task));
  writeScheduleTasks(copy, agentDir);
  return next;
}

export function deleteScheduleTask(id: string, agentDir?: string): void {
  const tasks = listScheduleTasks(agentDir);
  const next = tasks.filter((task) => task.id !== id);
  if (next.length === tasks.length) throw new Error("找不到该节律任务");
  writeScheduleTasks(next, agentDir);
}

/** 触发前先落盘：把 lastFiredAt 推进到 now（执行崩了也不会重复触发）。 */
export function markScheduleFired(id: string, atISO: string, agentDir?: string): ScheduleTask | undefined {
  return mutateScheduleTask(id, (task) => ({ ...task, lastFiredAt: atISO }), agentDir);
}

/** 记录一次运行结果（结束时写回）：写 lastRun（兼容）并追加到 runHistory 头部（cap RUN_HISTORY_CAP）。 */
export function recordScheduleRun(id: string, lastRun: ScheduleLastRun, agentDir?: string): ScheduleTask | undefined {
  return mutateScheduleTask(id, (task) => ({
    ...task,
    lastRun,
    runHistory: [lastRun, ...(task.runHistory ?? [])].slice(0, RUN_HISTORY_CAP),
  }), agentDir);
}
