import { NextResponse } from "next/server";
import { listCheckpoints } from "@/lib/checkpoints";

export const dynamic = "force-dynamic";

/**
 * GET /api/sessions/[id]/checkpoints —— 该会话每轮的改动快照。
 *
 * 前端在每轮 agent 结束、以及用户主动刷新时拉一次，用于显示「本轮改了 N 个
 * 文件 / 可回滚」。只读，不触发任何还原。
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const checkpoints = listCheckpoints(id).map((checkpoint) => ({
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
