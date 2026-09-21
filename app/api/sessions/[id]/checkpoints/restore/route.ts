import { NextResponse } from "next/server";
import { restoreCheckpoint } from "@/lib/checkpoints";

export const dynamic = "force-dynamic";

/**
 * POST /api/sessions/[id]/checkpoints/restore —— 把某一轮的改动整轮还原。
 *
 * 还原规则见 lib/checkpoints.ts：有备份的文件写回原件；本轮新建的文件只在
 * 「当前内容仍等于本轮写入结果」时删除，否则跳过并如实报告，绝不覆盖用户
 * 在这之后的手工改动。
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = (await req.json().catch(() => ({}))) as { turnId?: string };
    if (!body.turnId) {
      return NextResponse.json({ error: "缺少 turnId" }, { status: 400 });
    }
    const result = restoreCheckpoint({ sessionId: id, turnId: body.turnId });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
