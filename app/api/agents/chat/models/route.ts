import { NextResponse } from "next/server";
import { findAgent } from "@/lib/agents/manifest";
import { listAgents } from "@/lib/agents/registry";

export const dynamic = "force-dynamic";

/**
 * GET /api/agents/chat/models?agentId= —— 这条会话可选的模型（ACP session/new 的 models）。
 *
 * `start=1` 会顺手把 Agent 的 ACP 会话建起来：模型清单只存在于活着的会话里。
 * 只建会话、不落对话记录、不发 prompt，行为等价于「打开会话页」。
 */
const HOST = process.env.ELENVA_ACP_HOST?.trim() || "http://127.0.0.1:30201";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const agentId = url.searchParams.get("agentId");
  if (!agentId) return NextResponse.json({ error: "agentId required" }, { status: 400 });

  const agent = findAgent(listAgents().agents, agentId);
  if (!agent) return NextResponse.json({ error: "Agent 不存在" }, { status: 404 });
  if (agent.runtime !== "hermes") return NextResponse.json({ models: null, state: "n/a" });

  const params = new URLSearchParams({
    agentId: agent.id,
    profile: agent.profile ?? agent.id,
    start: url.searchParams.get("start") ?? "0",
  });
  if (agent.dir) params.set("cwd", agent.dir);

  try {
    const upstream = await fetch(`${HOST}/models?${params.toString()}`, {
      cache: "no-store",
      // 首次会拉子进程，给足时间；超时也把已缓存的内容返回去
      signal: AbortSignal.timeout(45000),
    });
    const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
    return NextResponse.json(data, { status: upstream.status, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: `ACP 宿主不可用：${String(error)}` }, { status: 502 });
  }
}
