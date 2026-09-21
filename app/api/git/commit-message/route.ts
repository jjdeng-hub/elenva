import { NextRequest, NextResponse } from "next/server";
import { generateCommitMessage } from "@/lib/commit-message";
import { buildCommitContext, GitCommitError } from "@/lib/git-commit";
import { guardGitCwd } from "@/lib/git-route-guard";

export const dynamic = "force-dynamic";

/**
 * POST /api/git/commit-message —— 用模型为选中的改动生成一条提交信息。
 *
 * 只返回**建议**，不落盘：提交信息是写给未来的人看的，必须经过一次人的确认。
 * 生成失败（无可用模型、超时、模型拒答）返回 `{ message: null }` 而不是报错 ——
 * 前端会静默退回手填，不该因为「帮你写 commit message」失败而阻塞提交流程。
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as
      | { cwd?: unknown; files?: unknown }
      | null;

    const guard = await guardGitCwd(typeof body?.cwd === "string" ? body.cwd : "");
    if (guard instanceof NextResponse) return guard;

    const files = Array.isArray(body?.files)
      ? (body.files as unknown[]).filter((f): f is string => typeof f === "string")
      : [];

    const context = await buildCommitContext(guard.cwd, files);
    const message = await generateCommitMessage(context.modelInput);
    return NextResponse.json({
      ok: true,
      message,
      fileCount: context.fileCount,
      additions: context.additions,
      deletions: context.deletions,
    });
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
