import { NextResponse } from "next/server";
import { ApiError, deleteProfile } from "@/lib/profiles-mutate";

export const dynamic = "force-dynamic";

interface DeleteBody {
  confirm?: string;
  archiveOnly?: boolean;
}

/**
 * DELETE /api/profiles/:id —— 归档并删除（P3b）。
 * body: { confirm: "<id>", archiveOnly?: boolean }
 * confirm 必须与 :id 精确相等；default 一律拒绝；有会话在跑 / gateway 在用 → 409。
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: DeleteBody;
  try {
    body = (await req.json()) as DeleteBody;
  } catch {
    return NextResponse.json({ error: "body 不是 JSON（需要 { confirm }）" }, { status: 400 });
  }

  try {
    const result = await deleteProfile(id, body.confirm ?? "", body.archiveOnly === true);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
