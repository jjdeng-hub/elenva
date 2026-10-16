/**
 * 审批决策日志（模块 5「治理与安全」· 第 1 轮）。
 *
 * 「现在在等你什么」由 `pending-approvals` 负责（活审批 + 待决策队列）；这里是
 * 它的**过去时**：每次审批真正有了结果（批准 / 拒绝 / 超时 / 入队），往
 * append-only JSONL（`elenva-approval-log.jsonl`）追一条。目的只有一个 ——
 * 回看「上次这种操作是什么结果、为什么」，而不是再做一个审计系统。
 *
 * 与队列文件的区别：`elenva-pending-approvals.jsonl` 是「待决策」（决策前），
 * 本文件是「决策历史」（决策后）。
 *
 * 设计上刻意保守（与 pending-approvals 一致）：
 *  · 只追写、不回改：**读的时候**才裁剪到最近 MAX_APPROVAL_LOG_ENTRIES 条；
 *  · 任何一步失败都吞掉、绝不抛 —— 审批流程不能因为一条日志挂掉；
 *  · 坏行跳过，不因为一行脏数据让整段历史看不见。
 */

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const APPROVAL_LOG_FILE = "elenva-approval-log.jsonl";

/** 读取时保留的最近条数（不是写入时的裁剪：写入路径越简单越不容易出错） */
export const MAX_APPROVAL_LOG_ENTRIES = 1000;

/** 摘要上限（命令 / 参数 / 计划正文都可能很长，日志不是存档） */
export const MAX_SUMMARY_CHARS = 200;

export const DEFAULT_HISTORY_LIMIT = 50;
export const MAX_HISTORY_LIMIT = 200;

export type ApprovalDecision = "approved" | "denied" | "timeout" | "queued";
export type ApprovalKind = "tool" | "plan";
/**
 * 决策发生的位置：
 *  · `dialog` —— 有人在看，弹窗里点的（含没人点、等到超时）；
 *  · `queue`  —— 无人值守 / 节律会话按配置入队，本次调用被拦下；
 *  · `auto`   —— 没有确认界面且配置为 `approvalFallback: "reject"`：宿主直接
 *    拒绝，既没有人点、也没有入队。任务书的字段口径只写了 dialog|queue，
 *    但实码里这条拒绝路径同样是个决策落点 —— 记成 dialog 是假的，不记则
 *    「拒绝」历史缺一段，所以单列一个来源并在汇报里说明。
 */
export type ApprovalSource = "dialog" | "queue" | "auto";

export interface ApprovalLogEntry {
  /** ISO 时间戳（决策发生的时刻） */
  ts: string;
  sessionId: string;
  kind: ApprovalKind;
  /** 工具名；计划审批固定为 `present_plan` */
  tool: string;
  /** 命令 / 参数 / 计划摘要（≤ MAX_SUMMARY_CHARS） */
  summary: string;
  decision: ApprovalDecision;
  source: ApprovalSource;
  /** 为什么被拦（拒绝 / 超时时附；计划打回时是批注） */
  reason?: string;
  /**
   * 同类操作的稳定标识（模块 5 · 第 3 轮，additive）：tool 侧取 `tool-risk` 的
   * `ruleKey`，plan 侧固定为 `"plan"`。用来把「同一个危险动作」的历史串起来，
   * 是「拒绝记忆」的匹配键；老条目没有此字段，照常读取（不参与匹配）。
   */
  ruleKey?: string;
}

/** 追写输入：ts 缺省取当前时间；其余按上面的口径收窄 */
export interface ApprovalLogInput {
  sessionId?: string | null;
  kind: ApprovalKind;
  tool?: string;
  summary?: string;
  decision: ApprovalDecision;
  source: ApprovalSource;
  reason?: string;
  /** 同类操作的稳定标识（见 ApprovalLogEntry.ruleKey）；空 / 非法则省略不写 */
  ruleKey?: string;
  /** 测试可注入固定时间 */
  ts?: string;
}

export interface ApprovalLogFilter {
  /** `null` / `"all"` / 非法值 = 不筛 */
  decision?: string | null;
  sessionId?: string | null;
  /** 缺省 DEFAULT_HISTORY_LIMIT，上限 MAX_HISTORY_LIMIT */
  limit?: number | string | null;
}

export interface ApprovalLogResult {
  entries: ApprovalLogEntry[];
  /** 过滤后、截断前的总条数（供「加载更多」判断还有没有） */
  total: number;
}

const DECISIONS: readonly ApprovalDecision[] = ["approved", "denied", "timeout", "queued"];
const KINDS: readonly ApprovalKind[] = ["tool", "plan"];
const SOURCES: readonly ApprovalSource[] = ["dialog", "queue", "auto"];

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isDecision(value: unknown): value is ApprovalDecision {
  return typeof value === "string" && (DECISIONS as readonly string[]).includes(value);
}

function isKind(value: unknown): value is ApprovalKind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}

function isSource(value: unknown): value is ApprovalSource {
  return typeof value === "string" && (SOURCES as readonly string[]).includes(value);
}

/** 超长摘要截断到 MAX_SUMMARY_CHARS（末位换成省略号，总长不超上限）。 */
export function truncateSummary(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= MAX_SUMMARY_CHARS) return text;
  return `${text.slice(0, MAX_SUMMARY_CHARS - 1)}…`;
}

/** 日志文件路径（测试可借 PI_CODING_AGENT_DIR 隔离到临时目录）。 */
export function getApprovalLogPath(): string {
  return join(getAgentDir(), APPROVAL_LOG_FILE);
}

/**
 * 追写一条决策日志。不抛：审批流程绝不能因为写日志失败而中断。
 * kind / decision / source 非法时静默跳过（写进去也只会被读取端当坏行丢掉）。
 */
export function appendApprovalLog(input: ApprovalLogInput): void {
  try {
    if (!isKind(input?.kind) || !isDecision(input?.decision) || !isSource(input?.source)) return;
    const entry: ApprovalLogEntry = {
      ts: str(input.ts) || new Date().toISOString(),
      sessionId: str(input.sessionId).trim(),
      kind: input.kind,
      tool: str(input.tool).trim(),
      summary: truncateSummary(str(input.summary)),
      decision: input.decision,
      source: input.source,
    };
    const reason = truncateSummary(str(input.reason));
    if (reason) entry.reason = reason;
    const ruleKey = str(input.ruleKey).trim();
    if (ruleKey) entry.ruleKey = ruleKey;
    appendFileSync(getApprovalLogPath(), `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    /* 旁路：写日志失败不影响审批 */
  }
}

/** 解析 JSONL 文本：坏行 / 结构不对的行直接跳过；保持文件顺序（旧 → 新）。不抛。 */
export function parseApprovalLog(raw: string): ApprovalLogEntry[] {
  const out: ApprovalLogEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      if (!isDecision(parsed.decision) || !isKind(parsed.kind)) continue;
      // source 缺失 / 非法按「弹窗」兜底：多数决策来自弹窗，且不该因为一个
      // 老版本的枚举值把整条记录丢掉
      const source: ApprovalSource = isSource(parsed.source) ? parsed.source : "dialog";
      const entry: ApprovalLogEntry = {
        ts: str(parsed.ts),
        sessionId: str(parsed.sessionId),
        kind: parsed.kind,
        tool: str(parsed.tool),
        summary: str(parsed.summary),
        decision: parsed.decision,
        source,
      };
      const reason = str(parsed.reason);
      if (reason) entry.reason = reason;
      // additive：老条目没有 ruleKey 就留空，读端不受影响
      const ruleKey = str(parsed.ruleKey).trim();
      if (ruleKey) entry.ruleKey = ruleKey;
      out.push(entry);
    } catch {
      /* 坏行跳过 */
    }
  }
  return out;
}

/** 归一化 limit：非法 / 缺省 → DEFAULT，超过上限 → 上限，<1 → 1。 */
export function normalizeLimit(value: number | string | null | undefined): number {
  const raw = typeof value === "string" ? Number.parseInt(value, 10) : value;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return DEFAULT_HISTORY_LIMIT;
  return Math.min(Math.floor(raw), MAX_HISTORY_LIMIT);
}

/**
 * 过滤纯函数（供 API 与自测复用）：`decision` 取已知取值才筛，
 * `"all"` / 缺省 / 非法值一律不筛；sessionId 精确匹配（trim 后）。
 * 无副作用、不改输入顺序。
 */
export function filterApprovalEntries(
  entries: readonly ApprovalLogEntry[],
  filter: ApprovalLogFilter = {},
): ApprovalLogEntry[] {
  const decision = str(filter.decision).trim();
  const sessionId = str(filter.sessionId).trim();
  const only = isDecision(decision) ? decision : null;
  return entries.filter((entry) => {
    if (only && entry.decision !== only) return false;
    if (sessionId && entry.sessionId !== sessionId) return false;
    return true;
  });
}

/**
 * 读审批历史：文件缺失 = 空；坏行跳过；先裁到最近 MAX_APPROVAL_LOG_ENTRIES 条，
 * 再过滤，返回**新 → 旧**、最多 limit 条，并给出过滤后的总数（total 供前端判断
 * 「还有没有更多」）。不抛。
 */
export function readApprovalLog(filter: ApprovalLogFilter = {}): ApprovalLogResult {
  let raw: string;
  try {
    raw = readFileSync(getApprovalLogPath(), "utf8");
  } catch {
    return { entries: [], total: 0 };
  }
  const recent = parseApprovalLog(raw).slice(-MAX_APPROVAL_LOG_ENTRIES);
  const matched = filterApprovalEntries(recent, filter);
  const ordered = matched.slice().reverse();
  const limit = normalizeLimit(filter.limit);
  return { entries: ordered.slice(0, limit), total: matched.length };
}
