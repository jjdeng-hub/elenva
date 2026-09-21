import { mkdirSync } from "fs";
import { resolve } from "path";
import { NextResponse } from "next/server";
import { getAllowedFileRoots, allowFileRoot, isExistingFilePathAllowed } from "@/lib/file-access";
import { invalidateSessionListCache } from "@/lib/session-reader";
import {
  dirExists,
  fallbackImportCwd,
  MAX_IMPORT_BYTES,
  parseImportContent,
  sessionIdExists,
  writeImportedSession,
} from "@/lib/session-import";

export const dynamic = "force-dynamic";

// POST /api/sessions/import — body: { content, filename?, cwd? }
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { content?: unknown; filename?: unknown; cwd?: unknown };
    if (typeof body.content !== "string" || !body.content.trim()) {
      return NextResponse.json({ error: "content required" }, { status: 400 });
    }
    if (Buffer.byteLength(body.content, "utf8") > MAX_IMPORT_BYTES) {
      return NextResponse.json({ error: `文件超过大小上限（${Math.floor(MAX_IMPORT_BYTES / 1024 / 1024)}MB）` }, { status: 413 });
    }

    let parsed: ReturnType<typeof parseImportContent>;
    try {
      parsed = parseImportContent(body.content);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }

    // 目标 cwd：请求指定 > 文件头声明 > 回退目录
    let cwd: string | null = null;
    for (const candidate of [body.cwd, parsed.headerCwd]) {
      if (typeof candidate !== "string" || !candidate.trim()) continue;
      const resolved = resolve(candidate);
      if (!dirExists(resolved)) continue;
      const allowedRoots = await getAllowedFileRoots();
      if (!isExistingFilePathAllowed(resolved, allowedRoots)) continue;
      cwd = resolved;
      break;
    }
    if (!cwd) {
      cwd = fallbackImportCwd();
      mkdirSync(cwd, { recursive: true });
      allowFileRoot(cwd);
    }

    if (await sessionIdExists(parsed.sessionId)) {
      return NextResponse.json({ error: "同名会话（相同 id）已存在，无需重复导入" }, { status: 409 });
    }

    const path = writeImportedSession(body.content, parsed.sessionId, cwd);
    invalidateSessionListCache();
    return NextResponse.json({
      success: true,
      sessionId: parsed.sessionId,
      path,
      cwd,
      entries: parsed.lineCount,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
