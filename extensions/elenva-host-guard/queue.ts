/**
 * 审批队列写入端（CLI / 飞书侧那一路）。
 *
 * 结构与 web 侧 `enqueuePendingApproval`（`lib/host-guardrails-extension.ts`）
 * **逐字段一致**，读端仍是 `lib/pending-approvals.ts:readQueuedApprovals`
 * （工作台「等你处理」）。所以本文件不发明格式，只是同一文件（
 * `<agentDir>/elenva-pending-approvals.jsonl`）的第二个写入者。
 *
 * 纪律同 web：**旁路，绝不抛**。入队失败只 stderr 一行，不影响「拒绝执行」这个主行为。
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";

/** 与 lib/pending-approvals.ts:PENDING_APPROVALS_FILE 同值 */
export const PENDING_APPROVALS_FILE = "elenva-pending-approvals.jsonl";

export interface HostApprovalEntry {
  toolName: string;
  /** 展示细节：命令 / 文件路径（读端会再截断） */
  detail: string;
  reason: string;
  ruleKey?: string;
  cwd: string;
  sessionId?: string | null;
}

export function pendingApprovalsPath(agentDir: string): string {
  return join(agentDir, PENDING_APPROVALS_FILE);
}

/**
 * 追加一条队列条目。返回文件里的总条数（失败返回 0）。
 * `at` 由本函数写入（读端期望 ISO 字符串）。
 */
export function enqueueHostApproval(entry: HostApprovalEntry, agentDir: string): number {
  try {
    const line = `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`;
    appendFileSync(pendingApprovalsPath(agentDir), line, "utf8");
    return 1;
  } catch (error) {
    console.error(
      "[elenva-host-guard] failed to enqueue pending approval:",
      error instanceof Error ? error.message : error,
    );
    return 0;
  }
}
