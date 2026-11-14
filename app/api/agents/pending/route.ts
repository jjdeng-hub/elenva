import { NextResponse } from "next/server";
import { findAgent } from "@/lib/agents/manifest";
import { listAgents } from "@/lib/agents/registry";

export const dynamic = "force-dynamic";

const HOST = process.env.ELENVA_ACP_HOST?.trim() || "http://127.0.0.1:30201";

/**
 * GET /api/agents/pending?id=<agentId> —— 该 Agent 名下还挂着、等人拍板的操作。
 *
 * 为什么需要：块上的动作是在「选题库」这类视图里点下去的，而审批卡长在对话区；
 * 实测过一次动作触发 4 个审批、没人看见，整轮挂了 15 分钟。这条接口让工作台
 * 能在顶上直接喊一声「有 N 个操作等你点头」。
 */
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const agent = findAgent(listAgents().agents, id);
  if (!agent) return NextResponse.json({ error: "Agent 不存在" }, { status: 404 });
  if (agent.runtime !== "hermes") {
    return NextResponse.json({ pending: [], queued: 0, state: "n/a" }, { headers: { "Cache-Control": "no-store" } });
  }

  try {
    const upstream = await fetch(`${HOST}/pending?agentId=${encodeURIComponent(agent.id)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    if (!upstream.ok) {
      return NextResponse.json({ error: `ACP 宿主不可用：HTTP ${upstream.status}` }, { status: 502 });
    }
    const data = (await upstream.json()) as { pending?: unknown[]; queued?: number; state?: string };
    return NextResponse.json(
      { pending: Array.isArray(data.pending) ? data.pending : [], queued: data.queued ?? 0, state: data.state ?? "idle" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json({ error: `ACP 宿主不可用：${String(error)}` }, { status: 502 });
  }
}
