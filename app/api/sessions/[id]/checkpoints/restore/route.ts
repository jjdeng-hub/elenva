import { NextResponse } from "next/server";
import { restoreCheckpoint } from "@/lib/checkpoints";

export const dynamic = "force-dynamic";

/**
 * POST /api/sessions/[id]/checkpoints/restore —— 把某一轮的改动整轮还原。
 *
 * 还原规则见 lib/checkpoints.ts：写回旧内容与删除新建文件都要求「当前内容
 * 仍等于本轮写入结果」；本轮之后被任何人（用户手改、其他会话等）动过的
 * 文件一律跳过并如实报告 —— 绝不覆盖本轮之后发生的改动。
 *
 * body 可选带 `paths: string[]` —— 文件级回滚（只动命中文件，与整轮共用同一
 * 校验与报告实现）；省略即整轮，行为与字段结构不变。
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = (await req.json().catch(() => ({}))) as { turnId?: string; paths?: unknown };
    if (!body.turnId) {
      return NextResponse.json({ error: "缺少 turnId" }, { status: 400 });
    }
    if (body.paths !== undefined
      && (!Array.isArray(body.paths) || body.paths.some((item) => typeof item !== "string"))) {
      return NextResponse.json({ error: "paths 必须是字符串数组" }, { status: 400 });
    }
    const result = restoreCheckpoint({
      sessionId: id,
      turnId: body.turnId,
      paths: body.paths,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
