import { NextResponse } from "next/server";
import { aggregateSkillUsage } from "@/lib/skill-usage";

export const dynamic = "force-dynamic";

// GET /api/skill-usage — 全部会话的技能调用排行（离线扫描，30s 内存缓存）
export async function GET() {
  return NextResponse.json(aggregateSkillUsage());
}
