import { NextResponse } from "next/server";
import { runScheduleTaskNow } from "@/lib/scheduler";

export const dynamic = "force-dynamic";

/**
 * POST /api/schedules/[id]/run —— 立即运行一次。
 *
 * 无视 nextRunAt、enabled=false 也能跑；仍受重叠保护（上轮未结束就跳过）。
 * 触发出来的是一条无头会话，标记为 scheduled → 危险操作入队。
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const result = await runScheduleTaskNow(id);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message === "找不到该节律任务" ? 404 : 500 });
  }
}
