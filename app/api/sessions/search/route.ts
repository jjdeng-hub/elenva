import { NextResponse, type NextRequest } from "next/server";
import { searchSessionContent } from "@/lib/sessions-content-search";

export const dynamic = "force-dynamic";

/** 整体死线：搜索必须在这个时间内返回（spec：2s） */
const SEARCH_DEADLINE_MS = 2_000;
/** 最短查询长度（1 个字符也放行：中文单字有意义） */
const MIN_QUERY_LEN = 1;

/**
 * GET /api/sessions/search?q=&profile=&runtime=
 *
 * 会话内容搜索（P4c）：
 * - runtime=pi：扫 ~/.pi/agent/sessions/<cwd-slug>/*.jsonl 的消息文本
 * - runtime=hermes：profile 的 state.db messages 表 LIKE（只读连接）
 * - 返回 sessionId / 标题 / 命中片段（前后 40 字）/ 命中条数；最多 50 会话、每会话 3 段
 * - 整体 2s 超时；大文件流式读；搜不到返回空数组（200，不报错）
 */
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const q = (url.searchParams.get("q") ?? "").trim();
  const profile = url.searchParams.get("profile") ?? undefined;
  const runtimeParam = url.searchParams.get("runtime");
  const runtime = runtimeParam === "hermes" || runtimeParam === "pi" ? runtimeParam : undefined;

  if (q.length < MIN_QUERY_LEN) {
    return NextResponse.json({ results: [], truncated: false, elapsedMs: 0 });
  }

  try {
    const outcome = await searchSessionContent({
      q,
      runtime,
      profile,
      deadlineMs: Date.now() + SEARCH_DEADLINE_MS,
    });
    return NextResponse.json(outcome, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // 搜索是旁支能力：任何故障都返回空结果，不让侧栏 500
    return NextResponse.json(
      { results: [], truncated: false, elapsedMs: 0, error: String(error) },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
