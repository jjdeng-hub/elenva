import { NextResponse } from "next/server";
import { switchToAuthProfile } from "@/lib/auth-profiles";
import { invalidateModelsCache } from "@/lib/models-cache";
import { refreshSessions } from "@/lib/pi-auth";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/profiles/switch —— 切换到某个凭据档
 *
 * 切换前自动备份当前凭据为 `auto-<时间>`，在 pi 的文件锁内原子替换；
 * 写失败回滚为切换前状态。body: { id }
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { id?: string };
    if (!body.id) return NextResponse.json({ error: "需要 id" }, { status: 400 });
    const result = await switchToAuthProfile(body.id);
    invalidateModelsCache();
    await refreshSessions();
    return NextResponse.json({ success: true, ...result });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
