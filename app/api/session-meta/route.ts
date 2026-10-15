import { NextResponse } from "next/server";
import { dropSessionMeta, readSessionMeta, setSessionMeta } from "@/lib/session-meta";

export const dynamic = "force-dynamic";

/** GET /api/session-meta —— 全部会话元数据（sessionId → { fav?, tags? }） */
export async function GET() {
  try {
    return NextResponse.json(
      { meta: readSessionMeta() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

/**
 * POST /api/session-meta —— 收藏 / 标签写入。
 *
 * action 形态（同 templates / guardrails）：
 *  · `{ action: "set", sessionId, fav?, tags?, goal? }` → 合并写入，返回 `{ ok: true, entry }`
 *  · `{ action: "clear", sessionId }` → 删除该会话的条目，返回 `{ ok: true }`
 *
 * 合并后条目为空（取消收藏、没有标签且没有目标）时，服务端直接删 key、`entry` 为 null。
 * goal 传空串 = 删掉目标。
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      sessionId?: string;
      fav?: unknown;
      tags?: unknown;
      goal?: unknown;
    };

    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    if (!sessionId) return NextResponse.json({ error: "缺少会话 id" }, { status: 400 });

    switch (body.action) {
      case "set": {
        if (body.fav !== undefined && typeof body.fav !== "boolean") {
          return NextResponse.json({ error: "fav 必须是布尔值" }, { status: 400 });
        }
        if (body.tags !== undefined && !Array.isArray(body.tags)) {
          return NextResponse.json({ error: "tags 必须是字符串数组" }, { status: 400 });
        }
        if (body.goal !== undefined && typeof body.goal !== "string") {
          return NextResponse.json({ error: "goal 必须是字符串" }, { status: 400 });
        }
        try {
          const entry = setSessionMeta(sessionId, {
            ...(body.fav !== undefined ? { fav: body.fav } : {}),
            ...(body.tags !== undefined ? { tags: body.tags as string[] } : {}),
            ...(body.goal !== undefined ? { goal: body.goal } : {}),
          });
          return NextResponse.json({ ok: true, entry });
        } catch (error) {
          return NextResponse.json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 400 },
          );
        }
      }
      case "clear": {
        try {
          dropSessionMeta(sessionId);
          return NextResponse.json({ ok: true });
        } catch (error) {
          return NextResponse.json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 400 },
          );
        }
      }
      default:
        return NextResponse.json({ error: "未知操作" }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
