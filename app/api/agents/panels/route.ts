import { NextResponse } from "next/server";
import { findAgent } from "@/lib/agents/manifest";
import { listAgents } from "@/lib/agents/registry";
import { readAgentPanels } from "@/lib/agents/panels-server";

export const dynamic = "force-dynamic";

/**
 * GET /api/agents/panels?id=<agentId> —— 该 Agent 声明面板的数据。
 *
 * 只读应用包目录内的 JSON；内置 Agent 没有包目录，返回空列表。
 * 面板读失败不返回 5xx：错误跟着对应面板走，界面显示「暂无数据」+ 原因。
 */
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  try {
    const { agents } = listAgents();
    const agent = findAgent(agents, id);
    if (!agent) return NextResponse.json({ error: "Agent 不存在" }, { status: 404 });

    const panels = agent.dir && agent.panels?.length ? readAgentPanels(agent.dir, agent.panels) : [];
    return NextResponse.json(
      { agent: { id: agent.id, name: agent.name }, panels },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
