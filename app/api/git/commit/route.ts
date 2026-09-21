import { NextRequest, NextResponse } from "next/server";
import { commitFiles, GitCommitError } from "@/lib/git-commit";
import { guardGitCwd } from "@/lib/git-route-guard";
import { invalidateSessionListCache } from "@/lib/session-reader";

export const dynamic = "force-dynamic";

/**
 * POST /api/git/commit —— 提交选中的文件。
 *
 * 这是本项目里**第一个会写用户仓库的接口**，因此：
 *  · cwd 门禁与其它 git 路由共用（lib/git-route-guard）
 *  · 待提交路径的校验在 lib/git-commit：必须落在仓库内，且必须处于当前变更集合中
 *  · 只暂存显式点选的文件，不提供 `git add -A`
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as
      | { cwd?: unknown; files?: unknown; message?: unknown }
      | null;

    const guard = await guardGitCwd(typeof body?.cwd === "string" ? body.cwd : "");
    if (guard instanceof NextResponse) return guard;

    const files = Array.isArray(body?.files)
      ? (body.files as unknown[]).filter((f): f is string => typeof f === "string")
      : [];
    const message = typeof body?.message === "string" ? body.message : "";

    const result = await commitFiles(guard.cwd, files, message);
    // HEAD 变了，会话列表里缓存的 git 信息需要失效重取
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
