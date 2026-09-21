import { NextResponse } from "next/server";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveSessionPath, buildSessionContext } from "@/lib/session-reader";
import { getAgentSession } from "@/lib/agent-runtime";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(req.url);
  const leafId = url.searchParams.get("leafId") ?? undefined;
  const deferThinking = url.searchParams.has("deferThinking");
  const deferToolResultImages = url.searchParams.has("deferMedia");
  // `tail` caps the ancestor chain returned (default 50); `before` rewinds the
  // walk start to an older entry so the client can page upward without
  // re-fetching the whole active branch.
  const rawTail = Number(url.searchParams.get("tail"));
  const tail = Number.isFinite(rawTail) && rawTail > 0 ? Math.min(rawTail, 1000) : 50;
  const before = url.searchParams.get("before") ?? undefined;
  // 每一页都落在一轮的起点上：首屏决定用户看到的「提问 + 回答」，
  // 向上翻页则决定滑到顶时先看到什么 —— 两者都需要对齐到轮次边界，
  // 否则顶部永远是一个没有提问的「过程 + 回答」。
  const alignToTurnStart = true;

  try {
    const session = getAgentSession(id);
    const liveSession = session?.isAlive() ? session : undefined;
    const filePath = liveSession ? null : await resolveSessionPath(id);
    if (!liveSession && !filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const sm = liveSession?.inner.sessionManager ?? SessionManager.open(filePath!);
    // `before` is the oldest entry already on the client; fetch its ancestors
    // only (excludeLeaf) so prepending the page does not duplicate `before`.
    const context = buildSessionContext(sm.getEntries() as never, before ?? leafId, {
      deferThinking,
      deferToolResultImages,
      tail,
      excludeLeaf: Boolean(before),
      alignToTurnStart,
      sessionId: id,
    });

    return NextResponse.json({ context, tail, before: before ?? null });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
