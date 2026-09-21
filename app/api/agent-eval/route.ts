import { NextResponse } from "next/server";
import { evaluateAgentPerformance } from "@/lib/agent-eval";

export const dynamic = "force-dynamic";

/**
 * GET /api/agent-eval?days=7 —— agent 能力评估。
 *
 * 只读聚合：扫会话文件算指标（验证覆盖率 / 工具失败率 / 验证命令分布）。
 * 口径写在 lib/agent-eval.ts 头部 —— 读数字前先读那段。
 */
export async function GET(req: Request) {
  try {
    const daysParam = new URL(req.url).searchParams.get("days");
    const parsed = daysParam ? Number.parseInt(daysParam, 10) : 7;
    const windowDays = Number.isFinite(parsed) && parsed > 0 && parsed <= 365 ? parsed : 7;
    const report = await evaluateAgentPerformance({ windowDays });
    return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
