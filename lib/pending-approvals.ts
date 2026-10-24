/**
 * 待审批的可观测层（模块 3「跨会话任务总览」）。
 *
 * 本模块只做「登记 / 清理 / 读取」，**不改审批语义**：审批仍由
 * `host-guardrails-extension` 决定放行、拒绝还是入队；这里是挂在旁边的一条
 * 记录链，任何一步失败都不得影响审批流程（所有导出函数内部吞异常，绝不抛）。
 *
 * 两种「等待审批」：
 *  - **活审批（live）**：交互式审批弹窗正阻塞在某个会话里。它只存在于服务进程
 *    存活期内，所以用内存 Map 登记；弹窗返回（含超时 / 抛错）后清理。
 *  - **审批队列（queued）**：无人值守会话按 `approvalFallback: "queue"` 落下的
 *    append-only JSONL（`elenva-pending-approvals.jsonl`，由 host-guardrails 的
 *    `enqueuePendingApproval` 写入）。这里只读，取尾部最近若干条。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** 与 host-guardrails-extension.ts 的 enqueuePendingApproval 共用同一文件 */
export const PENDING_APPROVALS_FILE = "elenva-pending-approvals.jsonl";

/** 队列只呈现最近 N 条（工作台是「最近在等我什么」，不是全量审计） */
export const QUEUE_TAIL_LIMIT = 20;

/**
 * 待审批的有效期：超过这个时间不再打扰（该文件 append-only，没有人为它收尾）。
 * 一条 7 天前的「要不要执行 rm」早就没有决策价值了 —— 会话可能已经结束、
 * 操作可能已经用别的方式做过。过期只影响**展示**，文件里的历史行不动
 * （审计痕迹归 `elenva-approval-log.jsonl`，这里只是待办视图）。
 */
export const QUEUED_APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 折叠键：同一会话 + 同一规则视为「同一件事」。节律任务每轮都会为同一条规则
 * 重新入队（上一轮的条目已无意义），只留最新一条；没有 ruleKey 时用 detail 兜底。
 */
function queueKey(q: QueuedApproval): string {
  return `${q.sessionId ?? ""}\u0000${q.ruleKey ?? q.detail ?? ""}`;
}

export type LiveApprovalKind = "tool" | "plan";

export interface PendingApproval {
  sessionId: string;
  kind: LiveApprovalKind;
  /** 为什么等你：工具审批给风险原因，计划审批给「计划待批准」 */
  reason: string;
  /** 等你的具体内容：命令 / 文件 / 计划摘要（展示端再截断） */
  detail: string;
  /** ISO 时间戳 */
  at: string;
}

/** 队列条目的字段口径对齐 enqueuePendingApproval 的写入（多补一个 kind 标记） */
export interface QueuedApproval {
  kind: "queued";
  sessionId?: string;
  at?: string;
  toolName?: string;
  detail?: string;
  reason?: string;
  ruleKey?: string;
  cwd?: string;
}

export interface RegisterPendingApprovalInput {
  sessionId?: string | null;
  kind: LiveApprovalKind;
  reason?: string;
  detail?: string;
  /** 缺省取当前时间；测试可注入固定值 */
  at?: string;
}

/** 进程内注册表：key = sessionId + kind（同 session 同 kind 幂等覆盖）。 */
const liveApprovals = new Map<string, PendingApproval>();

function keyOf(sessionId: string, kind: LiveApprovalKind): string {
  return `${sessionId}\u0000${kind}`;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * 登记一条活审批。sessionId 缺失或 kind 非法时静默跳过（拿不到会话就没法在
 * 工作台上指向它，登记了也无意义）；自身失败不抛，绝不影响审批流程。
 */
export function registerPendingApproval(input: RegisterPendingApprovalInput): void {
  try {
    const sessionId = str(input?.sessionId).trim();
    const kind = input?.kind;
    if (!sessionId) return;
    if (kind !== "tool" && kind !== "plan") return;
    liveApprovals.set(keyOf(sessionId, kind), {
      sessionId,
      kind,
      reason: str(input.reason),
      detail: str(input.detail),
      at: str(input.at) || new Date().toISOString(),
    });
  } catch {
    /* 旁路：登记失败不影响审批 */
  }
}

/** 清理一条活审批（弹窗返回 / 超时 / 抛错都要走到这里）。不抛。 */
export function resolvePendingApproval(sessionId: string | null | undefined, kind: LiveApprovalKind): void {
  try {
    const id = str(sessionId).trim();
    if (!id) return;
    liveApprovals.delete(keyOf(id, kind));
  } catch {
    /* 旁路：清理失败不影响审批 */
  }
}

/** 活审批列表，新 → 旧（同 at 时保持插入顺序）。不抛。 */
export function listPendingApprovals(): PendingApproval[] {
  try {
    return [...liveApprovals.values()].sort((a, b) => b.at.localeCompare(a.at));
  } catch {
    return [];
  }
}

/** 队列文件路径（测试可借 PI_CODING_AGENT_DIR 隔离到临时目录）。 */
export function getPendingApprovalsPath(): string {
  return join(getAgentDir(), PENDING_APPROVALS_FILE);
}

/**
 * 读审批队列 JSONL：文件缺失 = []；损坏行跳过。
 *
 * 读端做三件事（文件自身永不清理，清理代价放在读取这一侧）：
 *  ① 丢弃超过 TTL 的旧条目（at 缺失或非法时**保留** —— 宁可多显示，不吞真待办）；
 *  ② 同一会话 + 同一规则只留最新一条（重复入队不刷屏）；
 *  ③ 按时间新→旧取尾部 QUEUE_TAIL_LIMIT 条。
 *
 * `now` 可注入，便于自检固定时间。任何一步失败都不抛（旁路纪律）。
 */
export function readQueuedApprovals(now: number = Date.now()): QueuedApproval[] {
  let raw: string;
  try {
    raw = readFileSync(getPendingApprovalsPath(), "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const parsed: QueuedApproval[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      parsed.push({
        kind: "queued",
        sessionId: typeof entry.sessionId === "string" ? entry.sessionId : undefined,
        at: typeof entry.at === "string" ? entry.at : undefined,
        toolName: typeof entry.toolName === "string" ? entry.toolName : undefined,
        detail: typeof entry.detail === "string" ? entry.detail : undefined,
        reason: typeof entry.reason === "string" ? entry.reason : undefined,
        ruleKey: typeof entry.ruleKey === "string" ? entry.ruleKey : undefined,
        cwd: typeof entry.cwd === "string" ? entry.cwd : undefined,
      });
    } catch {
      /* 损坏行跳过 */
    }
  }

  // ① TTL：时间戳读不出来就当作「未知」保留，不因为字段脏就吞掉一条待办。
  const fresh = parsed.filter((q) => {
    const t = Date.parse(q.at ?? "");
    return Number.isNaN(t) ? true : now - t <= QUEUED_APPROVAL_TTL_MS;
  });

  // ② 同会话同规则折叠：取 at 更新的一条（at 相同则保留后出现的，等价于后写入）。
  const byKey = new Map<string, QueuedApproval>();
  for (const q of fresh) {
    const prev = byKey.get(queueKey(q));
    if (!prev || (q.at ?? "") >= (prev.at ?? "")) byKey.set(queueKey(q), q);
  }

  // ③ 新 → 旧，封顶 QUEUE_TAIL_LIMIT。
  return [...byKey.values()]
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
    .slice(0, QUEUE_TAIL_LIMIT);
}
