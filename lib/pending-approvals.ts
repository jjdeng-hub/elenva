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
 * 读审批队列 JSONL：文件缺失 = []；损坏行跳过；最多取尾部最近 QUEUE_TAIL_LIMIT 条，
 * 返回新 → 旧；每条补 `kind: "queued"` 作为来源标记。不抛。
 */
export function readQueuedApprovals(): QueuedApproval[] {
  let raw: string;
  try {
    raw = readFileSync(getPendingApprovalsPath(), "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const out: QueuedApproval[] = [];
  for (const line of lines.slice(-QUEUE_TAIL_LIMIT)) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      out.push({
        kind: "queued",
        sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
        at: typeof parsed.at === "string" ? parsed.at : undefined,
        toolName: typeof parsed.toolName === "string" ? parsed.toolName : undefined,
        detail: typeof parsed.detail === "string" ? parsed.detail : undefined,
        reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
        ruleKey: typeof parsed.ruleKey === "string" ? parsed.ruleKey : undefined,
        cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
      });
    } catch {
      /* 损坏行跳过 */
    }
  }
  return out.reverse();
}
