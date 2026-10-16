import { NextResponse } from "next/server";
import { aggregateModelHealth } from "@/lib/model-health";

export const dynamic = "force-dynamic";

/** GET /api/model-health → 近 14 天各 (provider/model) 的调用 / 失败 / 成功率（只读，60s 内存缓存） */
export async function GET() {
  try {
    return NextResponse.json(aggregateModelHealth(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
