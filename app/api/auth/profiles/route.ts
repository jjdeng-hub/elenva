import { NextResponse } from "next/server";
import {
  deleteAuthProfile,
  listAuthProfiles,
  saveCurrentAsProfile,
  updateProfileNote,
} from "@/lib/auth-profiles";
import { invalidateModelsCache } from "@/lib/models-cache";
import { refreshSessions } from "@/lib/pi-auth";

export const dynamic = "force-dynamic";

/**
 * /api/auth/profiles —— 命名凭据档（多账号）
 *
 * 只读返回档的元数据与「当前生效」指纹，**绝不返回凭据内容**。
 * 写入链与 pi 共用 proper-lockfile 锁 + 原子替换；切换前会自动备份，可回退。
 */

function fail(error: unknown, status = 400) {
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status });
}

/** GET —— 档列表 + 当前生效标记 + 当前 auth.json 指纹（无明文） */
export async function GET() {
  try {
    return NextResponse.json(listAuthProfiles());
  } catch (e) {
    return fail(e, 500);
  }
}

/** POST —— 把当前凭据存为命名档（等于备份），body: { provider, label, note? } */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { provider?: string; label?: string; note?: string };
    if (!body.provider || typeof body.label !== "string") {
      return NextResponse.json({ error: "需要 provider 与 label" }, { status: 400 });
    }
    const profile = await saveCurrentAsProfile(body.provider, body.label, body.note);
    await refreshSessions();
    return NextResponse.json({ profile: { ...profile } });
  } catch (e) {
    return fail(e);
  }
}

/** PATCH —— 修改档备注，body: { id, note } */
export async function PATCH(request: Request) {
  try {
    const body = (await request.json()) as { id?: string; note?: string };
    if (!body.id) return NextResponse.json({ error: "需要 id" }, { status: 400 });
    const profile = await updateProfileNote(body.id, body.note);
    return NextResponse.json({ profile: { ...profile } });
  } catch (e) {
    return fail(e);
  }
}

/** DELETE —— 删除档（不动 auth.json 当前凭据） */
export async function DELETE(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return NextResponse.json({ error: "需要 id 参数" }, { status: 400 });
    await deleteAuthProfile(id);
    invalidateModelsCache();
    return NextResponse.json({ success: true });
  } catch (e) {
    return fail(e);
  }
}
