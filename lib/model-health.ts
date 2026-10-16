/**
 * 模型健康面板数据层 —— 扫近 14 天会话文件，按 (provider/model) 汇总调用数与失败数。
 *
 * 与 lib/usage-aggregate.ts（token/成本）分开：本扫描器只读 assistant 消息的
 * provider/model/stopReason，不碰 usage 与预算面，供模型页「健康 · 近 14 天」节使用。
 *
 * ## 失败口径（2026-10-16 侦察，会话 JSONL 实测）
 *
 * pi 会话把每次 provider 响应落成 `type:"message"` 的 assistant 消息：
 *   成功/正常结束 stopReason = "stop" | "toolUse" | "length"
 *   失败          stopReason = "error"（同时带 errorMessage，如 "Request timed out."）
 *   用户中断      stopReason = "aborted"（非 provider 故障，本扫描器**不计入**调用与失败）
 *
 * 「被自动重试接管的失败」：内核先落盘 error 消息、再以
 * `type:"context_edit" { targetId, replacement: null }` 把它从上下文摘除并重试
 * （实测近 14 天 16 条 context_edit 全部指向 error 消息）。这类失败仍计入 failures，
 * 但另记 recoveredFailures；若一次模型全部失败都被重试接管，状态不判「有故障」。
 *
 * ## 为什么不做延迟
 *
 * 会话里**没有任何**请求耗时字段（durationMs / latency / startedAt / completedAt 全 0 命中）。
 * assistant 消息的 timestamp 是**响应完成时刻**，与上一条消息时间戳的差值混入了工具执行、
 * 用户思考、队列等待，不是可归因到 provider 的 API 延迟。宁可不显示，也不给假数字。
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const MODEL_HEALTH_WINDOW_DAYS = 14;
/** 「近期失败」用于「有故障」判定的口径：窗口内最近 7 天內发生过失败 */
export const MODEL_HEALTH_RECENT_FAILURE_DAYS = 7;
export const MODEL_HEALTH_OK_RATE = 0.98;
export const MODEL_HEALTH_UNSTABLE_RATE = 0.9;

export type ModelHealthStatus = "ok" | "unstable" | "failing";

export interface ModelHealthEntry {
  provider: string;
  model: string;
  /** `${provider}/${model}`，便于前端唯一 key */
  key: string;
  /** 窗口内的 provider 响应次数（不含 aborted） */
  calls: number;
  /** stopReason === "error" 的次数 */
  failures: number;
  /** failures 中被 context_edit 摘除（自动重试接管）的次数 */
  recoveredFailures: number;
  /** (calls - failures) / calls，0..1 */
  successRate: number;
  status: ModelHealthStatus;
  /** 最近一次调用的完成时刻（ISO） */
  lastCallAt: string;
  /** 最近一次失败时刻（ISO），无失败为 null */
  lastFailureAt: string | null;
  /** 最近一次失败的错误信息（截断），无失败为 null */
  lastError: string | null;
}

export interface ModelHealthReport {
  /** 统计基准时刻（ISO） */
  at: string;
  windowDays: number;
  /** 按「故障 → 不稳 → 正常」再按调用数降序 */
  models: ModelHealthEntry[];
  totalCalls: number;
  totalFailures: number;
}

export function hasRecentFailure(entry: ModelHealthEntry, nowMs = Date.now()): boolean {
  if (!entry.lastFailureAt) return false;
  const at = Date.parse(entry.lastFailureAt);
  return Number.isFinite(at) && nowMs - at <= MODEL_HEALTH_RECENT_FAILURE_DAYS * 86400000;
}

/**
 * 纯函数：由成功率与近期失败判状态（可单测）。
 * 正常 ≥98% · 不稳 90–98% · 有故障 <90% 且有近期失败；<90% 但失败全被重试接管 → 退为不稳。
 */
export function classifyModelHealth(entry: ModelHealthEntry, nowMs = Date.now()): ModelHealthStatus {
  if (entry.calls <= 0) return "ok";
  if (entry.successRate >= MODEL_HEALTH_OK_RATE) return "ok";
  if (entry.successRate >= MODEL_HEALTH_UNSTABLE_RATE) return "unstable";
  if (!hasRecentFailure(entry, nowMs)) return "unstable";
  if (entry.failures > 0 && entry.recoveredFailures >= entry.failures) return "unstable";
  return "failing";
}

interface Attempt {
  id?: string;
  provider: string;
  model: string;
  stopReason?: string;
  atMs: number;
  errorMessage?: string;
}

interface FileScan {
  attempts: Attempt[];
  /** context_edit 摘除的目标 entry id（自动重试接管的失败） */
  omitted: Set<string>;
}

const MAX_ERROR_LEN = 200;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** entry 级时间戳（ISO 字符串或毫秒数），拿不到退回文件 mtime（近似，不丢事件） */
function entryTimeMs(entry: Record<string, unknown>, fallbackMs: number): number {
  const raw = entry.timestamp;
  if (typeof raw === "string") {
    const at = Date.parse(raw);
    if (Number.isFinite(at)) return at;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  return fallbackMs;
}

/** 解析单个会话文件：收集 assistant 尝试与 context_edit 摘除目标；脏行直接跳过 */
function scanSessionFile(filePath: string, fallbackMs: number): FileScan {
  const attempts: Attempt[] = [];
  const omitted = new Set<string>();
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return { attempts, omitted };
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const record = asRecord(parsed);
      if (!record) continue;
      entry = record;
    } catch {
      continue; // 半截行 / 损坏行：容错跳过
    }
    const type = entry.type;
    if (type === "context_edit") {
      const targetId = entry.targetId;
      if (typeof targetId === "string" && entry.replacement === null) omitted.add(targetId);
      continue;
    }
    if (type !== "message") continue;
    const message = asRecord(entry.message);
    if (!message || message.role !== "assistant") continue;
    attempts.push({
      id: typeof entry.id === "string" ? entry.id : undefined,
      provider: typeof message.provider === "string" ? message.provider : "",
      model: typeof message.model === "string" ? message.model : "",
      stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
      atMs: entryTimeMs(entry, fallbackMs),
      errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
    });
  }
  return { attempts, omitted };
}

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
    collectJsonlFiles(full, out); // 目录递归；对文件 readdirSync 抛错由上方 catch 吞掉
  }
}

interface Acc {
  provider: string;
  model: string;
  calls: number;
  failures: number;
  recoveredFailures: number;
  lastCallMs: number;
  lastFailureMs: number;
  lastError: string | null;
}

let cache: { at: number; value: ModelHealthReport } | null = null;
const CACHE_TTL_MS = 60_000;

/** 仅供自测用：清掉内存缓存强制重扫（jiti 模块注册表跨实例共享，新实例拿的是同一份缓存） */
export function resetModelHealthCacheForTest(): void {
  cache = null;
}

export function aggregateModelHealth(nowMs = Date.now()): ModelHealthReport {
  if (cache && nowMs - cache.at < CACHE_TTL_MS) return cache.value;

  const windowStartMs = nowMs - MODEL_HEALTH_WINDOW_DAYS * 86400000;
  const files: string[] = [];
  collectJsonlFiles(join(getAgentDir(), "sessions"), files);

  const byModel = new Map<string, Acc>();
  for (const file of files) {
    // 文件 mtime 是最近写入时间：14 天没动过的会话不可能含窗口内消息，跳过省 IO。
    let modifiedMs: number;
    try {
      modifiedMs = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (modifiedMs < windowStartMs) continue;
    const { attempts, omitted } = scanSessionFile(file, modifiedMs);
    for (const attempt of attempts) {
      if (attempt.atMs < windowStartMs) continue;
      if (attempt.stopReason === "aborted") continue; // 用户中断，非 provider 故障
      const provider = attempt.provider || "?";
      const model = attempt.model || "?";
      const key = `${provider}/${model}`;
      let acc = byModel.get(key);
      if (!acc) {
        acc = {
          provider,
          model,
          calls: 0,
          failures: 0,
          recoveredFailures: 0,
          lastCallMs: 0,
          lastFailureMs: 0,
          lastError: null,
        };
        byModel.set(key, acc);
      }
      acc.calls += 1;
      if (attempt.atMs > acc.lastCallMs) acc.lastCallMs = attempt.atMs;
      if (attempt.stopReason === "error") {
        acc.failures += 1;
        if (attempt.id && omitted.has(attempt.id)) acc.recoveredFailures += 1;
        if (attempt.atMs > acc.lastFailureMs) {
          acc.lastFailureMs = attempt.atMs;
          acc.lastError = attempt.errorMessage ? attempt.errorMessage.slice(0, MAX_ERROR_LEN) : null;
        }
      }
    }
  }

  const models: ModelHealthEntry[] = [...byModel.values()].map((acc) => {
    const successRate = acc.calls > 0 ? (acc.calls - acc.failures) / acc.calls : 1;
    const entry: ModelHealthEntry = {
      provider: acc.provider,
      model: acc.model,
      key: `${acc.provider}/${acc.model}`,
      calls: acc.calls,
      failures: acc.failures,
      recoveredFailures: acc.recoveredFailures,
      successRate,
      status: "ok",
      lastCallAt: new Date(acc.lastCallMs).toISOString(),
      lastFailureAt: acc.lastFailureMs > 0 ? new Date(acc.lastFailureMs).toISOString() : null,
      lastError: acc.lastError,
    };
    entry.status = classifyModelHealth(entry, nowMs);
    return entry;
  });

  const STATUS_RANK: Record<ModelHealthStatus, number> = { failing: 0, unstable: 1, ok: 2 };
  models.sort(
    (a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      b.calls - a.calls ||
      b.failures - a.failures ||
      a.key.localeCompare(b.key),
  );

  const value: ModelHealthReport = {
    at: new Date(nowMs).toISOString(),
    windowDays: MODEL_HEALTH_WINDOW_DAYS,
    models,
    totalCalls: models.reduce((sum, m) => sum + m.calls, 0),
    totalFailures: models.reduce((sum, m) => sum + m.failures, 0),
  };
  cache = { at: nowMs, value };
  return value;
}
