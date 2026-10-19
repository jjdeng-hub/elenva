import { NextRequest, NextResponse } from "next/server";
import { GitOpError } from "@/lib/git-errors";
import { restoreFileFromCommit } from "@/lib/git-restore";
import { guardGitCwd } from "@/lib/git-route-guard";
import { invalidateSessionListCache } from "@/lib/session-reader";

export const dynamic = "force-dynamic";

/**
 * POST /api/git/restore-file —— 从某个提交恢复单个文件（会覆盖工作区内容）。
 *
 * body：{ cwd, hash, path, force? }
 *  · hash：4–40 位小写十六进制
 *  · path：**仓库内相对路径**（绝对路径 / `..` / 软链逃逸一律拒绝）
 *  · 目标文件当前有未提交改动时返回 409；显式 force: true 才放行
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as
      | { cwd?: unknown; hash?: unknown; path?: unknown; force?: unknown }
      | null;

    const guard = await guardGitCwd(typeof body?.cwd === "string" ? body.cwd : "");
    if (guard instanceof NextResponse) return guard;

    const result = await restoreFileFromCommit(guard.cwd, body?.hash, body?.path, {
      force: body?.force === true,
    });
    invalidateSessionListCache();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof GitOpError) {
      return NextResponse.json(
        { error: error.message, code: error.code, status: error.status },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
