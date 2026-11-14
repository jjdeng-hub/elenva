import { NextResponse } from "next/server";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { findAgent } from "@/lib/agents/manifest";
import { listAgents } from "@/lib/agents/registry";
import { isInsideDir } from "@/lib/agents/data-store";

export const dynamic = "force-dynamic";

/**
 * GET /api/agents/media?id=&path= —— 把应用包里的媒体文件喂给浏览器。
 *
 * 为什么单独一条：视频要靠 Range 才能拖动进度条，`readAgentFile` 那套只读文本，
 * 而且面板/正文都只允许 .json/.md。这里只放行**媒体扩展名**，其余一律拒绝。
 */

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
};

const MAX_BYTES = 200 * 1024 * 1024;

function resolveMedia(root: string, relPath: string): { ok: true; path: string } | { ok: false; status: number; error: string } {
  if (!relPath || relPath.length > 300) return { ok: false, status: 400, error: "路径为空或过长" };
  if (isAbsolute(relPath) || /^[a-zA-Z]:[\\/]/.test(relPath) || relPath.split(/[\\/]/).some((p) => p === "..")) {
    return { ok: false, status: 400, error: "只接受应用包内的相对路径" };
  }
  const ext = extname(relPath).toLowerCase();
  if (!(ext in MIME)) return { ok: false, status: 400, error: `不支持的媒体类型：${ext || "（无扩展名）"}` };

  const absRoot = resolve(root);
  const target = resolve(absRoot, relPath);
  if (!isInsideDir(absRoot, target)) return { ok: false, status: 400, error: "路径越出应用包目录" };
  if (!existsSync(target)) return { ok: false, status: 404, error: "文件不存在" };
  try {
    if (!isInsideDir(realpathSync(absRoot), realpathSync(target))) {
      return { ok: false, status: 400, error: "路径越出应用包目录（软链接）" };
    }
  } catch (error) {
    return { ok: false, status: 400, error: String(error) };
  }
  if (statSync(target).size > MAX_BYTES) return { ok: false, status: 413, error: "媒体文件超过 200MB" };
  return { ok: true, path: target };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const path = url.searchParams.get("path");
  if (!id || !path) return NextResponse.json({ error: "id 与 path 必填" }, { status: 400 });

  const agent = findAgent(listAgents().agents, id);
  if (!agent?.dir) return NextResponse.json({ error: "Agent 不存在或没有应用包目录" }, { status: 404 });

  const resolved = resolveMedia(agent.dir, path);
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status });

  const ext = extname(resolved.path).toLowerCase();
  const mime = MIME[ext];
  const size = statSync(resolved.path).size;
  const range = req.headers.get("range");

  // 不带 Range：整段返回（静帧、小文件走这条）
  if (!range) {
    return new NextResponse(readFileSync(resolved.path), {
      headers: {
        "Content-Type": mime,
        "Content-Length": String(size),
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=60",
      },
    });
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match) {
    return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
    return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }

  const chunk = readFileSync(resolved.path).subarray(start, end + 1);
  return new NextResponse(chunk, {
    status: 206,
    headers: {
      "Content-Type": mime,
      "Content-Length": String(chunk.length),
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=60",
    },
  });
}
