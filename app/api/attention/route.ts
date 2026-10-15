import { NextResponse } from "next/server";
import { listAllSessions } from "@/lib/session-reader";
import { getRunningAgentSessionIds } from "@/lib/agent-runtime";
import { detectAttentionOverview } from "@/lib/attention";
import { listPendingApprovals, readQueuedApprovals } from "@/lib/pending-approvals";

export const dynamic = "force-dynamic";

/**
 * 工作台「在跑 / 等我 / 刚完成」的数据源。
 *
 * - items：空闲且被中断 / 工具报错的会话（既有字段，逐字不变）。
 * - pendingApprovals：新增（additive）——live=活审批注册表（可能含运行中会话），
 *   queued=无人值守落下的审批队列。
 * - recentlyCompleted：新增（additive）——近 24h 收尾且无等待信号的会话，top 5。
 */
export async function GET() {
  try {
    const sessions = await listAllSessions();
    const running = new Set(getRunningAgentSessionIds());
    const { items, completions } = await detectAttentionOverview(sessions, running);
    const live = listPendingApprovals();
    const queued = readQueuedApprovals();
    // 「刚完成」要排除任何等待信号（含活审批与队列里的审批）
    const waiting = new Set<string>();
    for (const approval of [...live, ...queued]) {
      if (approval.sessionId) waiting.add(approval.sessionId);
    }
    const recentlyCompleted = completions.filter((c) => !waiting.has(c.sessionId));
    return NextResponse.json(
      { items, pendingApprovals: { live, queued }, recentlyCompleted },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
