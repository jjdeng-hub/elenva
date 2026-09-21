import { NextResponse } from "next/server";
import { stat } from "fs/promises";
import { resolve } from "path";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import {
  appendContextInstruction,
  isContextFileId,
  listContextFiles,
  MAX_CONTEXT_FILE_BYTES,
  writeContextFile,
} from "@/lib/context-files";

export const dynamic = "force-dynamic";

/** GET /api/context-files?cwd=… — 列出全局 + 项目上下文文件（内容含） */
export async function GET(req: Request) {
  try {
    const cwdParam = new URL(req.url).searchParams.get("cwd");
    let cwd: string | null = null;
    if (cwdParam && cwdParam.trim()) {
      cwd = resolve(cwdParam);
      try {
        if (!(await stat(cwd)).isDirectory()) {
          return NextResponse.json({ error: "cwd must be a directory" }, { status: 400 });
        }
      } catch {
        return NextResponse.json({ error: "Directory does not exist" }, { status: 400 });
      }
      const allowedRoots = await getAllowedFileRoots();
      if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }
    }
    return NextResponse.json({ files: listContextFiles(cwd) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

/** PUT /api/context-files — body: { file, content, cwd? } */
export async function PUT(req: Request) {
  try {
    const body = (await req.json()) as { file?: unknown; content?: unknown; cwd?: unknown };
    if (!isContextFileId(body.file)) {
      return NextResponse.json({ error: "未知上下文文件标识" }, { status: 400 });
    }
    if (typeof body.content !== "string") {
      return NextResponse.json({ error: "content 必须是字符串" }, { status: 400 });
    }
    if (Buffer.byteLength(body.content, "utf8") > MAX_CONTEXT_FILE_BYTES) {
      return NextResponse.json(
        { error: `内容超过大小上限（${Math.floor(MAX_CONTEXT_FILE_BYTES / 1024)}KB）` },
        { status: 400 },
      );
    }
    let cwd: string | null = null;
    if (body.file.startsWith("project-")) {
      if (typeof body.cwd !== "string" || !body.cwd.trim()) {
        return NextResponse.json({ error: "项目级上下文文件需要提供 cwd" }, { status: 400 });
      }
      cwd = resolve(body.cwd);
      try {
        if (!(await stat(cwd)).isDirectory()) {
          return NextResponse.json({ error: "cwd must be a directory" }, { status: 400 });
        }
      } catch {
        return NextResponse.json({ error: "Directory does not exist" }, { status: 400 });
      }
      const allowedRoots = await getAllowedFileRoots();
      if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }
    }
    const path = writeContextFile(body.file, body.content, cwd);
    return NextResponse.json({ success: true, ...(path ? { path } : { deleted: true }) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

/**
 * POST /api/context-files —— body: { file, text, cwd? }
 *
 * 「记住这条」的落盘口：把一句话追加成约定条目，不要求用户去编辑整份
 * Markdown，也不需要把整份文件读上来再写回去（那就又回到覆盖写的老路了）。
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { file?: unknown; text?: unknown; cwd?: unknown };
    if (!isContextFileId(body.file)) {
      return NextResponse.json({ error: "未知上下文文件标识" }, { status: 400 });
    }
    if (typeof body.text !== "string" || !body.text.trim()) {
      return NextResponse.json({ error: "要记住的内容不能为空" }, { status: 400 });
    }
    let cwd: string | null = null;
    if (body.file.startsWith("project-")) {
      if (typeof body.cwd !== "string" || !body.cwd.trim()) {
        return NextResponse.json({ error: "项目级上下文文件需要提供 cwd" }, { status: 400 });
      }
      cwd = resolve(body.cwd);
      try {
        if (!(await stat(cwd)).isDirectory()) {
          return NextResponse.json({ error: "cwd must be a directory" }, { status: 400 });
        }
      } catch {
        return NextResponse.json({ error: "Directory does not exist" }, { status: 400 });
      }
      const allowedRoots = await getAllowedFileRoots();
      if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }
    }
    const result = appendContextInstruction(body.file, body.text, cwd);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
