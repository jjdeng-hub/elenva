import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";
import { startAgentSession, getAgentSession, setAgentSessionTools } from "@/lib/agent-runtime";
import { diagError, diagTrace } from "@/lib/diagnostics";

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let commandType: string | undefined;
  let promptAccepted = false;
  /** 命令进入处理到返回的耗时——卡住时先看这一项 */
  const receivedAt = Date.now();

  try {
    const body = await req.json() as { type: string; [key: string]: unknown };
    commandType = typeof body.type === "string" ? body.type : undefined;
    const requestedToolNames = body.toolNames;
    if (
      requestedToolNames !== undefined
      && (!Array.isArray(requestedToolNames) || requestedToolNames.some((name) => typeof name !== "string"))
    ) {
      throw new Error("toolNames must be an array of strings");
    }
    const toolNames = requestedToolNames as string[] | undefined;

    // Fast path: already-running session
    const existing = getAgentSession(id);
    if (body.type === "set_tools") {
      const filePath = existing?.sessionFile || await resolveSessionPath(id) || undefined;
      if (!existing?.isAlive() && !filePath) {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }
      const changed = await setAgentSessionTools(id, filePath, toolNames);
      return NextResponse.json({
        success: true,
        data: { sessionId: changed.sessionId, recreated: changed.recreated },
      });
    }
    if (existing?.isAlive()) {
      const result = await existing.send(body);
      promptAccepted = body.type === "prompt";
      return NextResponse.json({ success: true, data: result });
    }

    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({
        error: "Session not found",
        ...(body.type === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 404 });
    }

    const { session } = await startAgentSession(id, filePath, undefined, {
      ...(toolNames !== undefined ? { toolNames } : {}),
    });
    const result = await session.send(body);
    promptAccepted = body.type === "prompt";
    diagTrace("agent-command", "冷启动会话后命令已分发", {
      sessionId: id,
      commandType,
      elapsedMs: Date.now() - receivedAt,
    });

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    /* 命令失败（含 prompt 派发失败）此前只回 JSON、服务端不落日志，
       「发了消息没反应」在日志里查不到任何线索。补上：哪条命令、到哪一步、什么错。 */
    diagError("agent-command", "命令处理失败", {
      sessionId: id,
      commandType: commandType ?? "(解析请求体失败)",
      promptAccepted,
      elapsedMs: Date.now() - receivedAt,
    }, error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
      stage: commandType === "prompt" ? "prompt_dispatch" : "command",
      ...(commandType === "prompt" && !promptAccepted
        ? { code: "prompt_rejected", accepted: false }
        : {}),
    }, { status: 500 });
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const session = getAgentSession(id);
    if (!session || !session.isAlive()) {
      return NextResponse.json({ running: false });
    }

    const state = await session.send({ type: "get_state" });
    return NextResponse.json({ running: true, state });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
