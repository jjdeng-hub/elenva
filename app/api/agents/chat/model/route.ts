import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/agents/chat/model {agentId, modelId} —— 只切当前会话的模型。
 *
 * 走 ACP 的 session/set_model，不改 profile 的 config.yaml：
 * 飞书 / cron / 终端里那个自己仍然按 profile 配的模型跑。
 */
const HOST = process.env.ELENVA_ACP_HOST?.trim() || "http://127.0.0.1:30201";

export async function POST(req: Request) {
  let body: { agentId?: string; modelId?: string };
  try {
    body = (await req.json()) as { agentId?: string; modelId?: string };
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const agentId = String(body.agentId ?? "");
  const modelId = String(body.modelId ?? "");
  if (!agentId || !modelId) return NextResponse.json({ error: "agentId / modelId required" }, { status: 400 });

  try {
    const upstream = await fetch(`${HOST}/model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, modelId }),
      cache: "no-store",
      signal: AbortSignal.timeout(30000),
    });
    const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
    return NextResponse.json(data, { status: upstream.status });
  } catch (error) {
    return NextResponse.json({ error: `ACP 宿主不可用：${String(error)}` }, { status: 502 });
  }
}
