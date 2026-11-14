import { NextResponse, type NextRequest } from "next/server";
import { searchSessionContent } from "@/lib/sessions-content-search";
import { reindexProfile, searchViaIndex } from "@/lib/search-index";

export const dynamic = "force-dynamic";

/** 整体死线：搜索必须在这个时间内返回（spec：2s） */
const SEARCH_DEADLINE_MS = 2_000;
/** 最短查询长度（1 个字符也放行：中文单字有意义） */
const MIN_QUERY_LEN = 1;

/**
 * GET /api/sessions/search?q=&profile=&runtime=
 *
 * 会话内容搜索（P4d：Hermes 侧改走 FTS5 索引）：
 * - runtime=pi：扫 ~/.pi/agent/sessions/<cwd-slug>/*.jsonl 的消息文本（保持 P4c 做法）
 * - runtime=hermes / 带 profile：FTS5 索引 ~/.elenva/search-index.db（增量同步 + MATCH）
 * - 返回 sessionId / 标题 / 命中片段 / 命中条数；最多 50 会话、每会话 3 段
 * - 2s 硬死线：worker 里软死线批间让位，超时 terminate —— 保证不会 8s 无响应
 * - truncated=true 表示「未搜完」（索引未追上 / 超时截断），界面据此区分三态
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

  const started = Date.now();
  try {
    // Hermes 侧（带 profile 或显式 runtime=hermes）：走 FTS5 索引
    if (runtime === "hermes" || profile) {
      const prof = profile && /^[a-z0-9][a-z0-9-]{0,63}$/.test(profile) ? profile : "default";
      const outcome = await searchViaIndex({ q, profile: prof, deadlineMs: started + SEARCH_DEADLINE_MS });
      return NextResponse.json(
        {
          results: outcome.results,
          truncated: outcome.truncated,
          elapsedMs: Date.now() - started,
          terminated: outcome.terminated ?? false,
          stats: outcome.stats ?? {},
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    // Pi 侧：保持 P4c 的流式扫描（小文件场景够用，不引入索引）
    const outcome = await searchSessionContent({
      q,
      runtime: "pi",
      deadlineMs: started + SEARCH_DEADLINE_MS,
    });
    return NextResponse.json(outcome, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // 搜索是旁支能力：任何故障都返回空结果，不让侧栏 500
    return NextResponse.json(
      { results: [], truncated: true, elapsedMs: Date.now() - started, error: String(error) },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}

/**
 * POST /api/sessions/search/reindex?profile=
 * 显式重建某 profile 的索引（清掉该 profile 的行 → FTS rebuild → 全量重同步）。
 * 不限 2s 死线（这是用户主动触发的一次性动作），完成返回统计。
 */
export async function POST(request: NextRequest) {
  const profile = request.nextUrl.searchParams.get("profile") ?? "default";
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(profile)) {
    return NextResponse.json({ ok: false, error: "bad profile" }, { status: 400 });
  }
  try {
    const result = await reindexProfile({ profile });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}
