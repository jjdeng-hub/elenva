import { NextResponse } from "next/server";
import { readReviewLedger, type ReviewLedgerGroupBy } from "@/lib/review-ledger";

export const dynamic = "force-dynamic";

/**
 * GET /api/review-ledger?group=day|week — 复台账（只读聚合）
 *
 * 数据来自记忆条目元数据 + 工作记录 + 记忆文件快照差分；本接口只读不写，
 * 也不触碰 pi-hermes-memory 的任何文件（见 lib/review-ledger.ts 模块头）。
 */
export async function GET(req: Request) {
  try {
    const group = new URL(req.url).searchParams.get("group");
    const groupBy: ReviewLedgerGroupBy = group === "week" ? "week" : "day";
    const ledger = readReviewLedger(groupBy);
    return NextResponse.json(ledger, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
