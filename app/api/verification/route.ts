import { NextResponse } from "next/server";
import { recentVerificationRecords, summarizeEvidence, verificationRecordsForSession } from "@/lib/verification-ledger";
import { verificationKindLabel } from "@/lib/verification-kind";

export const dynamic = "force-dynamic";

/**
 * GET /api/verification             — 最近的验证证据（跨会话）
 * GET /api/verification?session=<id> — 某会话的证据 + 汇总
 *
 * 账本本身是 JSONL，这里只是把它读出来给界面看。之所以要有这个口子：
 * 「agent 说改完了」这句话的依据必须能被查阅，否则账本只是另一个黑盒。
 */
export async function GET(req: Request) {
  try {
    const sessionId = new URL(req.url).searchParams.get("session");
    if (sessionId) {
      const records = verificationRecordsForSession(sessionId);
      const since = records.length > 0 ? Date.parse(records[0].createdAt) : 0;
      const summary = summarizeEvidence(records, Number.isFinite(since) ? since : 0);
      return NextResponse.json(
        {
          sessionId,
          summary,
          records: records.map((record) => ({
            ...record,
            kindLabel: verificationKindLabel(record.kind),
          })),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    const records = recentVerificationRecords().slice(-100);
    return NextResponse.json(
      { records: records.map((record) => ({ ...record, kindLabel: verificationKindLabel(record.kind) })) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
