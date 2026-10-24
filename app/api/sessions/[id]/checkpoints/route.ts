import { NextResponse } from "next/server";
import { checkpointFileDrift, listCheckpoints } from "@/lib/checkpoints";

export const dynamic = "force-dynamic";

/**
 * GET /api/sessions/[id]/checkpoints —— 该会话每轮的改动快照。
 *
 * 前端在每轮 agent 结束、以及用户主动刷新时拉一次，用于显示「本轮改了 N 个
 * 文件 / 可回滚」。只读，不触发任何还原。changedSince 供「回滚会跳过」预告。
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // 运行中观测栏按 2s 轮询（`hooks/useTurnCheckpoints`），只取最近几条 ——
  // mergeRound 只需要覆盖当前用户轮，没必要每次全量读 50 个 manifest。
  const raw = Number(new URL(req.url).searchParams.get("limit"));
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 50) : undefined;
  try {
    const checkpoints = listCheckpoints(id, undefined, limit).map((checkpoint) => ({
      id: checkpoint.id,
      turnIndex: checkpoint.turnIndex,
      createdAt: checkpoint.createdAt,
      closedAt: checkpoint.closedAt ?? null,
      status: checkpoint.status,
      cwd: checkpoint.cwd,
      fileCount: checkpoint.files.length,
      restorableCount: checkpoint.files.filter((file) => file.preImage || !file.existed).length,
      commands: checkpoint.shellCommands.map((run) => ({ command: run.command, failed: run.failed })),
      files: checkpoint.files.map((file) => ({
        path: file.path,
        tool: file.tool,
        existed: file.existed,
        restorable: Boolean(file.preImage) || !file.existed,
        skippedReason: file.skippedReason ?? null,
        bytes: file.bytes ?? null,
        /* 本轮之后又被改过（手改 / 其他会话）——回滚会跳过、不覆盖；前端做预告用 */
        changedSince: checkpointFileDrift(file),
      })),
    }));
    return NextResponse.json({ checkpoints }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
