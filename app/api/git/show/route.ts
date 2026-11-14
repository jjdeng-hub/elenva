import { NextRequest, NextResponse } from "next/server";
import { GitOpError } from "@/lib/git-errors";
import { getGitShow } from "@/lib/git-show";
import { guardGitCwd } from "@/lib/git-route-guard";

export const dynamic = "force-dynamic";

/**
 * GET /api/git/show —— 单次提交详情（只读）。
 *
 * query：cwd（必填）、hash（必填，4–40 位小写十六进制）
 * 返回：commit 元信息 + 每个文件的状态/行数/diff（单文件与总量均有限额）
 */
export async function GET(request: NextRequest) {
  try {
    const guard = await guardGitCwd(request.nextUrl.searchParams.get("cwd") ?? "");
    if (guard instanceof NextResponse) return guard;

    const hash = request.nextUrl.searchParams.get("hash") ?? "";
    return NextResponse.json(await getGitShow(guard.cwd, hash));
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
