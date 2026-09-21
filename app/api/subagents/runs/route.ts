import { NextResponse } from "next/server";
import { listSubagentRuns } from "@/lib/agent-runtime";

export const dynamic = "force-dynamic";

/**
 * GET /api/subagents/runs —— 当前内存中的子代理运行快照。
 *
 * 管理页此前只能配 profile，看不到「谁在跑」——而按本项目「编排与可见性」的定位，
 * 监控比重配置更要紧。这里返回 run 列表（含 parentSessionId / status / task），
 * 前端据此显示运行卡片并提供 steer / abort（走 /api/subagents/[id]）。
 *
 * 注意路由顺序：本目录必须与 [id]/route.ts 同级存在，Next 会优先匹配静态段 "runs"。
 */
export async function GET() {
  try {
    return NextResponse.json(
      { runs: listSubagentRuns() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
