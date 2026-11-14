import { NextResponse } from "next/server";
import { findAgent } from "@/lib/agents/manifest";
import { listAgents } from "@/lib/agents/registry";
import { readHermesSessionStats } from "@/lib/agents/resources";

export const dynamic = "force-dynamic";

/**
 * GET /api/agents/chat/stats?agentId=&sessionId= —— 单会话观测统计（P2）。
 *
 * 真源是 Hermes state.db 的 sessions 表（input/output tokens、tool_call_count、
 * started_at、cache tokens、估算成本）；读盘集中在 lib/agents/resources.ts。
 * 找不到会话返回 null —— 界面显示空态，不编数据。
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const agentId = url.searchParams.get("agentId");
  const sessionId = url.searchParams.get("sessionId");
  if (!agentId || !sessionId) {
    return NextResponse.json({ error: "agentId & sessionId required" }, { status: 400 });
  }

  const agent = findAgent(listAgents().agents, agentId);
  if (!agent) return NextResponse.json({ error: "Agent 不存在" }, { status: 404 });
  if (agent.runtime !== "hermes") {
    return NextResponse.json({ stats: null }, { headers: { "Cache-Control": "no-store" } });
  }

  try {
    const stats = await readHermesSessionStats(agent.profile ?? agent.id, sessionId);
    return NextResponse.json({ stats }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
