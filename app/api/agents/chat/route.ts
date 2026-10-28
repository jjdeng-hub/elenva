import { NextResponse } from "next/server";
import { findAgent } from "@/lib/agents/manifest";
import { listAgents } from "@/lib/agents/registry";

export const dynamic = "force-dynamic";

/**
 * ACP 运行时代理（只转发，不 spawn —— 子进程边界在 bin/acp-host.mjs）。
 *
 * GET  ?agentId=  → 把宿主的 SSE 事件流原样转给浏览器
 * POST {agentId, action:"prompt"|"permission"|"reset", ...}
 */
const HOST = process.env.ELENVA_ACP_HOST?.trim() || "http://127.0.0.1:30201";

type AgentRuntimeInfo = { profile: string; cwd: string } | { error: string };

function resolveRuntime(agentId: string): AgentRuntimeInfo {
  const { agents } = listAgents();
  const agent = findAgent(agents, agentId);
  if (!agent) return { error: "Agent 不存在" };
  if (agent.runtime !== "hermes") return { error: `该 Agent 的运行时是 ${agent.runtime}，不是 hermes` };
  return { profile: agent.profile ?? agent.id, cwd: agent.dir ?? process.cwd() };
}

export async function GET(req: Request) {
  const agentId = new URL(req.url).searchParams.get("agentId");
  if (!agentId) return NextResponse.json({ error: "agentId required" }, { status: 400 });
  const runtime = resolveRuntime(agentId);
  if ("error" in runtime) return NextResponse.json({ error: runtime.error }, { status: 400 });

  try {
    const upstream = await fetch(`${HOST}/events?agentId=${encodeURIComponent(agentId)}`, {
      headers: { accept: "text/event-stream" },
      cache: "no-store",
    });
    if (!upstream.ok || !upstream.body) {
      return NextResponse.json({ error: `ACP 宿主不可用：HTTP ${upstream.status}` }, { status: 502 });
    }
    return new Response(upstream.body, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: `ACP 宿主不可用：${String(error)}` }, { status: 502 });
  }
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const agentId = String(body.agentId ?? "");
  const action = String(body.action ?? "prompt");
  const runtime = resolveRuntime(agentId);
  if ("error" in runtime) return NextResponse.json({ error: runtime.error }, { status: 400 });

  const payload =
    action === "prompt"
      ? { agentId, profile: runtime.profile, cwd: runtime.cwd, text: String(body.text ?? "") }
      : action === "permission"
        ? { agentId, requestId: body.requestId, optionId: body.optionId }
        : action === "cancel"
          ? { agentId }
          : { agentId, cwd: runtime.cwd };
  const endpoint = action === "prompt" || action === "permission" || action === "cancel" ? action : "reset";

  try {
    const res = await fetch(`${HOST}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch (error) {
    return NextResponse.json({ error: `ACP 宿主不可用：${String(error)}` }, { status: 502 });
  }
}
