import { NextResponse } from "next/server";
import { findAgent } from "@/lib/agents/manifest";
import { listAgents } from "@/lib/agents/registry";
import { listFilms } from "@/lib/agents/film";

export const dynamic = "force-dynamic";

/**
 * GET /api/agents/films?id=&dir=movies —— 只返回片子列表（工作台轮询用）。
 *
 * 为什么单独一条：渲染 450 帧要几十秒，界面得能刷新进度；拉整个 workspace 太重，
 * 而片子列表就是几个目录 stat，轻。
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const dir = url.searchParams.get("dir");
  if (!id || !dir) return NextResponse.json({ error: "id 与 dir 必填" }, { status: 400 });

  const agent = findAgent(listAgents().agents, id);
  if (!agent?.dir) return NextResponse.json({ error: "Agent 不存在或没有应用包目录" }, { status: 404 });

  // 只允许读 manifest 里声明过的 film 块目录
  const declared = (agent.views ?? []).some((view) =>
    view.blocks.some((block) => block.type === "film" && (block.source ?? "").replace(/\/$/, "") === dir.replace(/\/$/, "")),
  );
  if (!declared) return NextResponse.json({ error: "这个目录没有在 manifest 里声明为 film 块" }, { status: 400 });

  return NextResponse.json({ films: listFilms(agent.dir, dir) }, { headers: { "Cache-Control": "no-store" } });
}
