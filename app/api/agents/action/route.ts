import { NextResponse } from "next/server";
import { findAgent } from "@/lib/agents/manifest";
import { listAgents } from "@/lib/agents/registry";
import { renderActionPrompt } from "@/lib/agents/action";
import type { AgentBlock, AgentView } from "@/lib/agents/workspace";

export const dynamic = "force-dynamic";

const HOST = process.env.ELENVA_ACP_HOST?.trim() || "http://127.0.0.1:30201";

/**
 * POST /api/agents/action —— 把「块上的一句动作」变成该 Agent 会话里的一轮对话。
 *
 * 只做转发，不做编排：模板 + 选中项 → prompt → 交给运行时。
 * 这也让「新 Agent 的界面」不需要新的后端代码：动作是 manifest 里的一行声明。
 */
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const agentId = String(body.agentId ?? "");
  const blockId = String(body.blockId ?? "");
  const actionId = String(body.actionId ?? "");
  const context = typeof body.context === "object" && body.context !== null ? (body.context as Record<string, unknown>) : {};
  if (!agentId || !blockId || !actionId) {
    return NextResponse.json({ error: "agentId / blockId / actionId 必填" }, { status: 400 });
  }

  const agent = findAgent(listAgents().agents, agentId);
  if (!agent) return NextResponse.json({ error: "Agent 不存在" }, { status: 404 });

  const block = findBlock(agent.views ?? [], blockId);
  if (!block) return NextResponse.json({ error: "块不存在" }, { status: 404 });
  const action = block.actions?.find((entry) => entry.id === actionId);
  if (!action) return NextResponse.json({ error: "动作不存在" }, { status: 404 });

  const rendered = renderActionPrompt(action.prompt, context);
  if (!rendered.ok) return NextResponse.json({ error: rendered.error }, { status: 400 });

  if (!agent.dir) return NextResponse.json({ error: "内置 Agent 不走应用包动作" }, { status: 400 });

  if (agent.runtime !== "hermes") {
    return NextResponse.json(
      { error: `该 Agent 的运行时是 ${agent.runtime}，应用包动作目前只接通 hermes` },
      { status: 400 },
    );
  }

  const profile = agent.profile ?? agent.id;
  try {
    const upstream = await fetch(`${HOST}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: agent.id, profile, cwd: agent.dir, text: rendered.text }),
      cache: "no-store",
    });
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => "");
      return NextResponse.json(
        { error: `ACP 宿主拒绝了这次动作：HTTP ${upstream.status} ${detail.slice(0, 200)}`.trim() },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true, prompt: rendered.text }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: `ACP 宿主不可用：${String(error)}` }, { status: 502 });
  }
}

function findBlock(views: AgentView[], blockId: string): AgentBlock | null {
  for (const view of views) {
    const block = view.blocks.find((entry) => entry.id === blockId);
    if (block) return block;
  }
  return null;
}
