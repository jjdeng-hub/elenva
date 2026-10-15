import { NextResponse } from "next/server";
import {
  appendAgentMemoryEntry,
  isAgentMemoryFileId,
  listAgentMemoryFiles,
  readAgentMemoryFile,
  readAgentMemorySnapshot,
  writeAgentMemoryFile,
  type AgentMemoryEntry,
} from "@/lib/agent-memory";
import {
  getMemoryOrigin,
  isMemoryOriginVia,
  recordMemoryOrigin,
  type MemoryOriginVia,
} from "@/lib/memory-origins";

export const dynamic = "force-dynamic";

/** 给条目附来源（additive：没记过的条目保持原样，不多出字段） */
function withMemoryOrigins(file: string, entries: AgentMemoryEntry[]) {
  return entries.map((entry) => {
    const origin = getMemoryOrigin(file, entry.text);
    return origin ? { ...entry, origin } : entry;
  });
}

/** 从 body.source 里取来源三字段；via 非法时返回 null（调用方回 400） */
function readMemorySource(value: unknown): { via: MemoryOriginVia; sessionId: string | null; cwd: string | null } | null {
  const source = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  let via: MemoryOriginVia = "web-edit";
  if (source.via !== undefined) {
    if (!isMemoryOriginVia(source.via)) return null;
    via = source.via;
  }
  return {
    via,
    sessionId: typeof source.sessionId === "string" ? source.sessionId : null,
    cwd: typeof source.cwd === "string" ? source.cwd : null,
  };
}

/**
 * Agent 记忆的读写接口（pi-hermes-memory 落盘的文件）。
 *
 * GET  /api/memory            — 记忆文件清单
 * GET  /api/memory?file=<id>  — 单个文件（原文 + 结构化条目 + 版本 + 配额），id: user | memory | failures | project/<项目名>
 * PUT  /api/memory            — 保存条目：{ file, entries[], revision? }（新增/改动的条目记 via=web-edit）
 * POST /api/memory            — 追加一条：{ file, text, source? }（读快照 → 追加 → 写盘，冲突重试一次）
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
        // 编辑用的结构化视图（正文 + created/last + 版本 + 配额 + 可选来源）
        entries: withMemoryOrigins(file, snapshot.entries),
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

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { file?: unknown; text?: unknown; source?: unknown };
    if (typeof body.file !== "string" || !isAgentMemoryFileId(body.file)) {
      return NextResponse.json(
        { ok: false, code: "unknown-file", error: "未知记忆文件标识" },
        { status: 400 },
      );
    }
    const source = readMemorySource(body.source);
    if (!source) {
      return NextResponse.json({ ok: false, code: "invalid", error: "未知来源类型" }, { status: 400 });
    }
    const text = typeof body.text === "string" ? body.text : "";
    const result = appendAgentMemoryEntry(body.file, text);
    // 写入成功才记来源（来源是旁路信息，记失败不影响正文已落盘）
    if (result.ok) {
      recordMemoryOrigin({ file: body.file, text, via: source.via, sessionId: source.sessionId, cwd: source.cwd });
    }
    const status = result.ok ? 200 : result.code === "conflict" ? 409 : 400;
    return NextResponse.json(result, { status });
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "invalid", error: error instanceof Error ? error.message : String(error) },
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
    // 保存前快照：用来对比出「新增 / 被改动」的条目（按 trim 后正文）
    const before = readAgentMemorySnapshot(body.file);
    const result = writeAgentMemoryFile(body.file, {
      entries: (Array.isArray(body.entries) ? body.entries : []) as AgentMemoryEntry[],
      revision: typeof body.revision === "string" ? body.revision : undefined,
    });
    if (result.ok) {
      const known = new Set(before.entries.map((entry) => entry.text.trim()));
      for (const entry of result.entries) {
        if (!known.has(entry.text.trim())) recordMemoryOrigin({ file: body.file, text: entry.text, via: "web-edit" });
      }
    }
    const status = result.ok ? 200 : result.code === "conflict" ? 409 : 400;
    return NextResponse.json(result, { status });
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "invalid", error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
