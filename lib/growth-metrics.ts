/**
 * 成长仪表数据层 —— 扫近 8 周会话 JSONL，按「项目 × 周」分桶给出四类趋势指标。
 *
 * 存在动机：会话列表回答「我做过什么」，用量分析回答「我花了多少」，但没有一层回答
 * **「我在变顺还是变钝」**。这里把「任务量 / 失败率 / 轮数 / 工具调用」按周摊开，
 * 让趋势一眼可读（参考 GitHub contributions / WakaTime 的「少而准」呈现法）。
 *
 * ## 口径（2026-10-16 侦察真实会话 JSONL 后定）
 *
 * - **轮次（turn）**：一条 `role:"user"` 的 message 开启一轮，到下一个 user message 前结束。
 * - **失败轮次**：该轮内出现 assistant 消息 `stopReason === "error"`
 *   （实测 errorMessage 只落在 `stopReason:"error"` 与 `aborted` 两种响应上；
 *   `aborted` 是用户主动中断、不是 provider 故障，**不计失败** —— 与 `lib/model-health.ts` 口径一致）。
 * - **工具调用**：assistant 消息 content 里 `type:"toolCall"` 块计数（与 session-stats / turn-trends 同源）。
 * - **任务（task）**：一次会话。周桶里的「会话数」= 该周**有轮次**的会话去重计数
 *   （会话可跨周续写，续写部分计入其发生周，不整场塞进开始周）。
 * - **项目**：会话头的 cwd（粗粒度，与 `lib/usage-aggregate.ts` 的 projects 同口径）。
 *   不在 lib 里做 repoRoot / worktree 归并（那要跑 git，lib/ 禁 spawn）；展示层取末段。
 * - **不做「任务类型」**：分类太虚且无可靠标签，用「项目 × 周」的粗分组代替（见汇报取舍）。
 *
 * ## 为什么不做耗时
 *
 * 与 model-health 同因：会话里没有可归因到「任务」的耗时字段，assistant timestamp 是
 * 完成时刻，差值混入工具执行与思考。宁可不显示，也不给假数字。
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const GROWTH_WINDOW_WEEKS = 8;
/** 失败率变化 <1 个百分点视为「持平」（避免把噪声读成趋势） */
export const GROWTH_FLAT_THRESHOLD = 0.01;

export type GrowthVerdict = "smoother" | "blunter" | "flat" | "new" | "empty";

/** 一组指标（周桶 / 项目合计共用） */
export interface GrowthBucket {
  /** 该周有轮次的会话去重数 */
  sessions: number;
  /** 用户轮次 */
  turns: number;
  /** 含 provider 错误的轮次 */
  failedTurns: number;
  /** assistant toolCall 块计数 */
  toolCalls: number;
  /** failedTurns / turns，0..1；turns=0 时为 0 */
  failureRate: number;
  /** turns / sessions；sessions=0 时为 0 */
  turnsPerSession: number;
  /** toolCalls / sessions；sessions=0 时为 0 */
  toolCallsPerSession: number;
}

export interface GrowthWeek extends GrowthBucket {
  /** 该周周一（本地日历）YYYY-MM-DD */
  weekStart: string;
  /** "M/D"（周一那天），柱下标签用 */
  label: string;
  /** 是否本周（可能不完整） */
  isCurrent: boolean;
}

export interface GrowthProject {
  /** 完整 cwd（未知为 "unknown"） */
  project: string;
  /** 展示名：cwd 末段 */
  label: string;
  weeks: GrowthWeek[];
  totals: GrowthBucket;
}

export interface GrowthHeadline {
  verdict: GrowthVerdict;
  /** 规则生成的一句话读图（不上模型） */
  text: string;
}

export interface GrowthReport {
  /** 统计基准时刻（ISO） */
  at: string;
  windowWeeks: number;
  /** 总览周桶，旧 → 新（最后一个是本周） */
  weeks: GrowthWeek[];
  totals: GrowthBucket;
  /** 按轮次降序（粗粒度，展示层取 Top N） */
  projects: GrowthProject[];
  headline: GrowthHeadline;
}

/* ------------------------------------------------------------------ */
/* 日历：本地周一为一周起点                                            */
/* ------------------------------------------------------------------ */

function localYmd(ms: number): string {
  const d = new Date(ms);
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** 该时刻所在周的周一 00:00（本地） */
function weekStartOf(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // 周一 = getDay() 1
  return d.getTime();
}

function weekLabel(weekStart: string): string {
  const [, m, day] = weekStart.split("-");
  return `${Number(m)}/${Number(day)}`;
}

/** 末 8 周（含本周）的周一 00:00，旧 → 新 */
function windowWeekStarts(nowMs: number): number[] {
  const base = new Date(weekStartOf(nowMs));
  const starts: number[] = [];
  for (let i = GROWTH_WINDOW_WEEKS - 1; i >= 0; i--) {
    const d = new Date(base);
    d.setDate(d.getDate() - i * 7);
    starts.push(d.getTime());
  }
  return starts;
}

/* ------------------------------------------------------------------ */
/* 扫描单会话文件                                                      */
/* ------------------------------------------------------------------ */

interface Turn {
  atMs: number;
  failed: boolean;
  toolCalls: number;
}

interface SessionScan {
  id: string;
  cwd: string;
  turns: Turn[];
}

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

function countToolCalls(message: Record<string, unknown>): number {
  const content = message.content;
  if (!Array.isArray(content)) return 0;
  return content.filter((block) => asRecord(block)?.type === "toolCall").length;
}

/**
 * 解析单个会话文件：切轮 + 标记失败轮 + 计工具调用；脏行 / 半截行容错跳过。
 *
 * 用户消息之前的内容（理论上不应有）不归属任何轮：其工具调用不计（任务量按轮次算）。
 * 没有 cwd 的旧文件归 "unknown"；id 缺失时由调用方按文件名兜底。
 */
function scanSessionFile(filePath: string, fallbackMs: number): SessionScan {
  const turns: Turn[] = [];
  let id = "";
  let cwd = "";
  let current: Turn | null = null;

  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return { id, cwd, turns };
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
    if (type === "session") {
      if (typeof entry.id === "string") id = entry.id;
      if (typeof entry.cwd === "string" && entry.cwd) cwd = entry.cwd;
      continue;
    }
    if (type !== "message") continue;

    const message = asRecord(entry.message);
    if (!message) continue;
    if (message.role === "user") {
      current = { atMs: entryTimeMs(entry, fallbackMs), failed: false, toolCalls: 0 };
      turns.push(current);
      continue;
    }
    if (!current) continue; // 首轮之前：不归属任何轮
    if (message.role === "assistant") {
      current.toolCalls += countToolCalls(message);
      if (message.stopReason === "error") current.failed = true;
    }
  }

  return { id, cwd, turns };
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

/* ------------------------------------------------------------------ */
/* 聚合                                                                */
/* ------------------------------------------------------------------ */

interface Acc {
  sessions: Set<string>;
  turns: number;
  failedTurns: number;
  toolCalls: number;
}

const emptyAcc = (): Acc => ({ sessions: new Set(), turns: 0, failedTurns: 0, toolCalls: 0 });

/** 把多个周桶合并成合计（会话按 id 去重；跨周的同一会话只算一个任务） */
function mergeAccs(accs: Acc[]): Acc {
  const sum = emptyAcc();
  for (const acc of accs) {
    for (const id of acc.sessions) sum.sessions.add(id);
    sum.turns += acc.turns;
    sum.failedTurns += acc.failedTurns;
    sum.toolCalls += acc.toolCalls;
  }
  return sum;
}

function finishBucket(acc: Acc): GrowthBucket {
  const sessions = acc.sessions.size;
  return {
    sessions,
    turns: acc.turns,
    failedTurns: acc.failedTurns,
    toolCalls: acc.toolCalls,
    failureRate: acc.turns > 0 ? acc.failedTurns / acc.turns : 0,
    turnsPerSession: sessions > 0 ? acc.turns / sessions : 0,
    toolCallsPerSession: sessions > 0 ? acc.toolCalls / sessions : 0,
  };
}

function projectLabelOf(cwd: string): string {
  if (!cwd || cwd === "unknown") return "未知";
  return cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || cwd;
}

/** 本地短日期（真机与自测都用它，避免各自实现） */
export function formatWeekLabel(weekStart: string): string {
  return weekLabel(weekStart);
}

/**
 * 规则生成的一句话读图（纯函数，可单测；不上模型）。
 *
 * 判据只看**失败率**的环比：↓ ≥1pt → 变顺，↑ ≥1pt → 变钝，其余持平。
 * 本周可能不完整（周一就只剩一两天），故文案里明写「本周」并在口径说明里提示。
 */
export function summarizeGrowth(weeks: GrowthWeek[]): GrowthHeadline {
  if (weeks.length === 0) return { verdict: "empty", text: "还没有可读的会话记录。" };
  const cur = weeks[weeks.length - 1];
  const prev = weeks.length >= 2 ? weeks[weeks.length - 2] : undefined;

  const load = (b: GrowthBucket) =>
    `每任务均 ${b.turnsPerSession.toFixed(1)} 轮、${b.toolCallsPerSession.toFixed(1)} 次工具调用`;
  const pct = (rate: number) => `${(rate * 100).toFixed(1)}%`;

  if (cur.turns === 0) {
    if (!prev || prev.turns === 0) return { verdict: "empty", text: "近 8 周还没有可读的会话记录。" };
    return {
      verdict: "empty",
      text: `本周还没有会话记录（上周 ${prev.sessions} 个任务 / ${prev.turns} 轮，失败率 ${pct(prev.failureRate)}）。`,
    };
  }

  if (!prev || prev.turns === 0) {
    return {
      verdict: "new",
      text: `本周 ${cur.sessions} 个任务 / ${cur.turns} 轮，失败率 ${pct(cur.failureRate)}；上周无记录，暂无可比；${load(cur)}。`,
    };
  }

  const deltaPt = (cur.failureRate - prev.failureRate) * 100;
  const verdict: GrowthVerdict =
    deltaPt <= -GROWTH_FLAT_THRESHOLD * 100 ? "smoother" : deltaPt >= GROWTH_FLAT_THRESHOLD * 100 ? "blunter" : "flat";
  const move = verdict === "flat" ? "与上周持平" : `较上周 ${deltaPt < 0 ? "↓" : "↑"} ${Math.abs(deltaPt).toFixed(1)} 个百分点`;
  return {
    verdict,
    text: `本周 ${cur.sessions} 个任务 / ${cur.turns} 轮，失败率 ${pct(cur.failureRate)}（${move}，上周 ${pct(prev.failureRate)}）；${load(cur)}。`,
  };
}

let cache: { at: number; value: GrowthReport } | null = null;
const CACHE_TTL_MS = 60_000;

/** 仅供自测用：清掉内存缓存强制重扫（jiti 模块注册表跨实例共享，新实例拿的是同一份缓存） */
export function resetGrowthCacheForTest(): void {
  cache = null;
}

export function aggregateGrowth(nowMs = Date.now()): GrowthReport {
  if (cache && nowMs - cache.at < CACHE_TTL_MS) return cache.value;

  const weekStarts = windowWeekStarts(nowMs);
  const weekIndex = new Map<string, number>();
  weekStarts.forEach((ms, i) => weekIndex.set(localYmd(ms), i));
  const windowStartMs = weekStarts[0];

  const overall = weekStarts.map(() => emptyAcc());
  const byProject = new Map<string, Acc[]>();

  const files: string[] = [];
  collectJsonlFiles(join(getAgentDir(), "sessions"), files);

  for (const file of files) {
    // 文件 mtime 是最近写入时间：8 周没动过的会话不可能含窗口内轮次，跳过省 IO。
    let modifiedMs: number;
    try {
      modifiedMs = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (modifiedMs < windowStartMs) continue;

    const scan = scanSessionFile(file, modifiedMs);
    const id = scan.id || (file.replace(/\\/g, "/").split("/").pop() ?? file).replace(/\.jsonl$/i, "");
    const project = scan.cwd || "unknown";
    let projectWeeks = byProject.get(project);
    if (!projectWeeks) {
      projectWeeks = weekStarts.map(() => emptyAcc());
      byProject.set(project, projectWeeks);
    }

    for (const turn of scan.turns) {
      const idx = weekIndex.get(localYmd(weekStartOf(turn.atMs)));
      if (idx === undefined) continue; // 窗口外（或未来时间戳）：不丢账，只是不进这 8 周
      for (const acc of [overall[idx], projectWeeks[idx]]) {
        acc.sessions.add(id);
        acc.turns += 1;
        acc.toolCalls += turn.toolCalls;
        if (turn.failed) acc.failedTurns += 1;
      }
    }
  }

  const currentKey = localYmd(weekStarts[weekStarts.length - 1]);
  const toWeeks = (accs: Acc[]): GrowthWeek[] =>
    accs.map((acc, i) => {
      const weekStart = localYmd(weekStarts[i]);
      return { weekStart, label: weekLabel(weekStart), isCurrent: weekStart === currentKey, ...finishBucket(acc) };
    });

  const projects: GrowthProject[] = [...byProject.entries()]
    .map(([project, accs]) => ({
      project,
      label: projectLabelOf(project),
      weeks: toWeeks(accs),
      totals: finishBucket(mergeAccs(accs)),
    }))
    .sort((a, b) => b.totals.turns - a.totals.turns || a.project.localeCompare(b.project));

  const weeks = toWeeks(overall);
  const value: GrowthReport = {
    at: new Date(nowMs).toISOString(),
    windowWeeks: GROWTH_WINDOW_WEEKS,
    weeks,
    totals: finishBucket(mergeAccs(overall)),
    projects,
    headline: summarizeGrowth(weeks),
  };
  cache = { at: nowMs, value };
  return value;
}
