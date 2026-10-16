import { NextResponse } from "next/server";
import { aggregateGrowth } from "@/lib/growth-metrics";

export const dynamic = "force-dynamic";

/**
 * GET /api/growth → 近 8 周「任务量 / 失败率 / 轮数 / 工具调用」的周趋势 + 项目粗分组（只读，60s 内存缓存）。
 * 一句话读图由 lib/growth-metrics.ts 按规则生成（不上模型），随报告一起返回。
 */
export async function GET() {
  try {
    return NextResponse.json(aggregateGrowth(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
