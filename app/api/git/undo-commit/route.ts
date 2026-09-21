import { NextRequest, NextResponse } from "next/server";
import { GitCommitError, undoLastCommit } from "@/lib/git-commit";
import { guardGitCwd } from "@/lib/git-route-guard";
import { invalidateSessionListCache } from "@/lib/session-reader";

export const dynamic = "force-dynamic";

/**
 * POST /api/git/undo-commit —— 撤销最近一次提交。
 *
 * 用 `git reset --soft HEAD~1`：只回退提交记录，改动全部留在暂存区/工作区，
 * **不会丢任何文件**。第一个提交（无父提交）时拒绝，避免把仓库清空。
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as { cwd?: unknown } | null;
    const guard = await guardGitCwd(typeof body?.cwd === "string" ? body.cwd : "");
    if (guard instanceof NextResponse) return guard;

    const result = await undoLastCommit(guard.cwd);
    invalidateSessionListCache();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof GitCommitError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
