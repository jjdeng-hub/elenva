import { NextResponse } from "next/server";
import { readApprovalLog } from "@/lib/approval-log";

export const dynamic = "force-dynamic";

/**
 * GET /api/approvals/history — 审批决策历史（跨会话，新 → 旧）
 *
 * 查询参数：
 *  · `decision`  —— `approved` | `denied` | `timeout` | `queued`（`all` / 缺省 = 不筛）
 *  · `sessionId` —— 精确匹配某个会话
 *  · `limit`     —— 条数（缺省 50，上限 200）
 *
 * 响应：`{ entries, total }`。`total` 是过滤后的总数（截断前），前端靠它判断
 * 「还有没有更多」。
 *
 * 日志本身是文件里的 append-only JSONL，这里只负责读出来给界面看 ——
 * 「上次这种操作是什么结果、为什么」必须能被查阅，否则审批历史只是另一个黑盒。
 */
export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const result = readApprovalLog({
      decision: params.get("decision"),
      sessionId: params.get("sessionId"),
      limit: params.get("limit"),
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
