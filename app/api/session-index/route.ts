import { NextResponse } from "next/server";
import { listUnifiedSessions } from "@/lib/session-index";

export const dynamic = "force-dynamic";

/**
 * GET /api/session-index —— 统一会话索引（P2）。
 *
 * Pi 会话文件与 Hermes state.db 都投影成同一个 SessionInfo；
 * 侧栏与搜索只吃这里，不各自读存储。只存元数据、可重建。
 */
export async function GET() {
  try {
    const sessions = await listUnifiedSessions();
    return NextResponse.json(
      {
        sessions,
        runningSessionIds: sessions.filter((session) => session.running).map((session) => session.id),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
