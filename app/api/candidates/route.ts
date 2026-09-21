import { NextResponse } from "next/server";
import { adoptCandidate, discardCandidate, listCandidateGroups, startCandidateGroup } from "@/lib/candidates";
import { resolveProject } from "@/lib/worktree";

export const dynamic = "force-dynamic";

/**
 * GET /api/candidates?cwd=… —— 该项目的并行试验组（含各候选的 diff 与运行状态）。
 * 顺带回报项目是否是 git 仓库，让前端在不能用的项目上直接说清原因。
 */
export async function GET(req: Request) {
  try {
    const cwd = new URL(req.url).searchParams.get("cwd") ?? undefined;
    const groups = await listCandidateGroups(cwd || undefined);
    const repo = cwd
      ? await resolveProject(cwd).then((project) => ({
          isGitRepo: project.isGitRepo,
          repoRoot: project.repoRoot,
        })).catch(() => ({ isGitRepo: false, repoRoot: cwd }))
      : null;
    return NextResponse.json({ groups, repo }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

/**
 * POST /api/candidates —— 开一组并行试验 / 采用某个候选 / 丢弃某个候选。
 *
 * 「开始」会真的起 N 个会话并各自发一次 prompt（消耗 token）—— 这是用户点
 * 「开始」时明确要的，不做静默触发。
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      cwd?: string;
      prompt?: string;
      count?: number;
      groupId?: string;
      sessionId?: string;
    };

    switch (body.action) {
      case "start": {
        if (!body.cwd || !body.prompt) {
          return NextResponse.json({ error: "缺少 cwd 或任务描述" }, { status: 400 });
        }
        const group = await startCandidateGroup({
          cwd: body.cwd,
          prompt: body.prompt,
          count: body.count ?? 2,
        });
        return NextResponse.json({ group });
      }
      case "discard": {
        if (!body.groupId || !body.sessionId) {
          return NextResponse.json({ error: "缺少 groupId 或 sessionId" }, { status: 400 });
        }
        const result = await discardCandidate({ groupId: body.groupId, sessionId: body.sessionId });
        return NextResponse.json({ success: true, ...result });
      }
      case "adopt": {
        if (!body.groupId || !body.sessionId) {
          return NextResponse.json({ error: "缺少 groupId 或 sessionId" }, { status: 400 });
        }
        const result = await adoptCandidate({ groupId: body.groupId, sessionId: body.sessionId });
        return NextResponse.json({ success: true, ...result });
      }
      default:
        return NextResponse.json({ error: "未知操作" }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
