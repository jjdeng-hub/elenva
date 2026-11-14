import { NextRequest, NextResponse } from "next/server";
import { GitOpError } from "@/lib/git-errors";
import { getGitLog, normalizeLogLimit } from "@/lib/git-log";
import { guardGitCwd } from "@/lib/git-route-guard";

export const dynamic = "force-dynamic";

/**
 * GET /api/git/log —— 提交历史列表（只读）。
 *
 * query：cwd（必填）、limit（默认 30 / 上限 100）、before（分页游标：从该 hash 往旧翻）
 */
export async function GET(request: NextRequest) {
  try {
    const guard = await guardGitCwd(request.nextUrl.searchParams.get("cwd") ?? "");
    if (guard instanceof NextResponse) return guard;

    const limit = normalizeLogLimit(request.nextUrl.searchParams.get("limit"));
    const before = request.nextUrl.searchParams.get("before");
    return NextResponse.json(await getGitLog(guard.cwd, { limit, before }));
  } catch (error) {
    if (error instanceof GitOpError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
