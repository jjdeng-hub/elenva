import { NextResponse } from "next/server";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { polishUserPrompt } from "@/lib/prompt-polish";
import { getAgentSession, startAgentSession } from "@/lib/agent-runtime";
import { resolveSessionPath } from "@/lib/session-reader";

/** 与 UI 输入框同一上限口径：超过就直接婉拒，别把超长草稿塞给优化器 */
const MAX_INPUT_LENGTH = 12_000;

/**
 * 提示词优化：借会话同款模型把输入框草稿改写为可执行提示词。
 * 请求：{ sessionId, text }。响应：{ polished }。
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as { sessionId?: unknown; text?: unknown } | null;
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
    const text = typeof body?.text === "string" ? body.text.trim() : "";

    if (!sessionId) {
      return NextResponse.json({ error: "缺少 sessionId" }, { status: 400 });
    }
    if (!text) {
      return NextResponse.json({ error: "输入框是空的" }, { status: 400 });
    }
    if (text.length > MAX_INPUT_LENGTH) {
      return NextResponse.json(
        { error: `提示词过长（${text.length} 字，上限 ${MAX_INPUT_LENGTH} 字）` },
        { status: 400 },
      );
    }

    const filePath = await resolveSessionPath(sessionId);
    if (!filePath) {
      return NextResponse.json({ error: "会话不存在" }, { status: 404 });
    }

    const existing = getAgentSession(sessionId);
    const { session } = existing?.isAlive()
      ? { session: existing }
      : await startAgentSession(sessionId, filePath, undefined);

    // globalThis keeps wrappers alive across dev hot reloads; older instances
    // may predate waitUntilReady(), but those have already completed startup.
    await session.waitUntilReady?.();

    const { polished } = await polishUserPrompt(session.inner as unknown as AgentSession, text);
    return NextResponse.json({ polished });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}