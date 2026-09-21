import { NextResponse } from "next/server";
import {
  isAgentMemoryFileId,
  listAgentMemoryFiles,
  readAgentMemoryFile,
  readAgentMemorySnapshot,
  writeAgentMemoryFile,
  type AgentMemoryEntry,
} from "@/lib/agent-memory";

export const dynamic = "force-dynamic";

/**
 * Agent 记忆的读写接口（pi-hermes-memory 落盘的文件）。
 *
 * GET /api/memory            — 记忆文件清单
 * GET /api/memory?file=<id>  — 单个文件（原文 + 结构化条目 + 版本 + 配额），id: user | memory | failures | project/<项目名>
 * PUT /api/memory            — 保存条目：{ file, entries[], revision? }
 *
 * 写入由 lib/agent-memory.ts 统一处理（并发校验 → 配额 → 备份 → 原子写）；
 * SQLite 检索镜像是派生的，扩展会在会话启动时自动对齐（无需本接口参与）。
 */
export async function GET(req: Request) {
  try {
    const file = new URL(req.url).searchParams.get("file");
    if (file !== null) {
      if (!isAgentMemoryFileId(file)) {
        return NextResponse.json({ error: "未知记忆文件标识" }, { status: 400 });
      }
      const detail = readAgentMemoryFile(file);
      const snapshot = readAgentMemorySnapshot(file);
      return NextResponse.json({
        ...detail,
        // 编辑用的结构化视图（正文 + created/last + 版本 + 配额）
        entries: snapshot.entries,
        revision: snapshot.revision,
        chars: snapshot.chars,
        limit: snapshot.limit,
      });
    }
    return NextResponse.json(listAgentMemoryFiles());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function PUT(req: Request) {
  try {
    const body = (await req.json()) as { file?: unknown; entries?: unknown; revision?: unknown };
    if (typeof body.file !== "string" || !isAgentMemoryFileId(body.file)) {
      return NextResponse.json(
        { ok: false, code: "unknown-file", error: "未知记忆文件标识" },
        { status: 400 },
      );
    }
    const result = writeAgentMemoryFile(body.file, {
      entries: (Array.isArray(body.entries) ? body.entries : []) as AgentMemoryEntry[],
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
