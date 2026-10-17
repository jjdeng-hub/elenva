import { NextResponse } from "next/server";
import { isAgentMemoryFileId, setAgentMemoryEntryStatus } from "@/lib/agent-memory";

export const dynamic = "force-dynamic";

/**
 * POST /api/memory/status —— 条目级「标失效 / 恢复」（单条原子）。
 *
 * body: { file: string, text: string, action: "invalidate" | "restore", reason?: string, revision?: string }
 *
 * 与整份 PUT `/api/memory` 的分工：那条路径整份替换条目，适合编辑 / 删除；
 * 这一条只翻转**指定一条**的失效状态，其余条目不动，并且是唯一能绕过字符上限的写入口
 * （失效是满额时的逃生口）。写入细节与语义见 lib/agent-memory.ts 的 setAgentMemoryEntryStatus。
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof body.file !== "string" || !isAgentMemoryFileId(body.file)) {
      return NextResponse.json(
        { ok: false, code: "unknown-file", error: "未知记忆文件标识" },
        { status: 400 },
      );
    }
    if (body.action !== "invalidate" && body.action !== "restore") {
      return NextResponse.json(
        { ok: false, code: "invalid", error: "action 只能是 invalidate（标失效）或 restore（恢复）" },
        { status: 400 },
      );
    }
    if (typeof body.text !== "string" || !body.text.trim()) {
      return NextResponse.json({ ok: false, code: "invalid", error: "缺少要操作的条目正文" }, { status: 400 });
    }
    const result = setAgentMemoryEntryStatus(body.file, {
      text: body.text,
      action: body.action,
      reason: typeof body.reason === "string" ? body.reason : null,
      revision: typeof body.revision === "string" ? body.revision : undefined,
    });
    const status = result.ok ? 200 : result.code === "conflict" ? 409 : 400;
    return NextResponse.json(result, { status });
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "invalid", error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
