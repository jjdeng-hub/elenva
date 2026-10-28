import { NextResponse } from "next/server";
import { findAgent } from "@/lib/agents/manifest";
import { listAgents } from "@/lib/agents/registry";

export const dynamic = "force-dynamic";

/**
 * GET /api/agents/chat/history?agentId= —— 该 Agent 已落盘的对话。
 *
 * 落盘由 bin/acp-host.cjs 负责（应用包内 data/chat.jsonl）；
 * 这里只解析 agentId → 目录，再转发给宿主读盘，Next 侧不碰文件。
 */
const HOST = process.env.ELENVA_ACP_HOST?.trim() || "http://127.0.0.1:30201";

export async function GET(req: Request) {
  const agentId = new URL(req.url).searchParams.get("agentId");
  if (!agentId) return NextResponse.json({ error: "agentId required" }, { status: 400 });

  try {
    const agent = findAgent(listAgents().agents, agentId);
    if (!agent) return NextResponse.json({ error: "Agent 不存在" }, { status: 404 });
    if (!agent.dir) return NextResponse.json({ messages: [] });

    const url = `${HOST}/history?agentId=${encodeURIComponent(agentId)}&dir=${encodeURIComponent(agent.dir)}`;
    const res = await fetch(url, { cache: "no-store" });
    const data = await res.json().catch(() => ({ messages: [] }));
    return NextResponse.json(data, { status: res.status });
  } catch (error) {
    return NextResponse.json({ error: `ACP 宿主不可用：${String(error)}` }, { status: 502 });
  }
}
