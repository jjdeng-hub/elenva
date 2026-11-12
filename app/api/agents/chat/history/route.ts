import { NextResponse } from "next/server";
import { findAgent } from "@/lib/agents/manifest";
import { listAgents } from "@/lib/agents/registry";
import { findLatestHermesSessionByCwd, readHermesMessages } from "@/lib/agents/resources";

export const dynamic = "force-dynamic";

/**
 * GET /api/agents/chat/history?agentId= —— 该 Agent 的会话历史。
 *
 * 单一真源是 Hermes 的 state.db（见 docs/specs/2026-11-12-single-source-of-truth.md）：
 * 按 cwd=应用包目录认会话（不用 source），忽略 message_count=0 的空会话。
 * 不再读写应用包里的 data/chat.jsonl；这里直连资源层，不经 ACP 宿主。
 */
export async function GET(req: Request) {
  const agentId = new URL(req.url).searchParams.get("agentId");
  if (!agentId) return NextResponse.json({ error: "agentId required" }, { status: 400 });

  const agent = findAgent(listAgents().agents, agentId);
  if (!agent) return NextResponse.json({ error: "Agent 不存在" }, { status: 404 });
  if (!agent.dir) return NextResponse.json({ messages: [] });

  const profile = agent.profile ?? agent.id;
  const session = await findLatestHermesSessionByCwd(profile, agent.dir);
  if (!session) return NextResponse.json({ messages: [] });

  try {
    const messages = await readHermesMessages(profile, session.id);
    return NextResponse.json(
      { sessionId: session.id, title: session.title, messages },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
