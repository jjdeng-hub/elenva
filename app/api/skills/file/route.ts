import { NextResponse } from "next/server";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { writePrivateFileAtomicSync } from "@/lib/atomic-file";

export const dynamic = "force-dynamic";

const MAX_SKILL_FILE_BYTES = 512 * 1024;

/** SKILL.md 可访问根：常规允许根 + agent 目录 + 全局技能目录（与 PATCH /api/skills 一致） */
async function resolveAllowedRootsForSkills(): Promise<Set<string>> {
  const allowedRoots = new Set(await getAllowedFileRoots());
  allowedRoots.add(getAgentDir());
  const globalSkillsDir = path.join(homedir(), ".agents", "skills");
  if (existsSync(globalSkillsDir)) allowedRoots.add(globalSkillsDir);
  return allowedRoots;
}

function validateSkillFilePath(filePath: unknown): { path: string } | { response: NextResponse } {
  if (typeof filePath !== "string" || !filePath.trim()) {
    return { response: NextResponse.json({ error: "path required" }, { status: 400 }) };
  }
  const p = path.resolve(filePath);
  if (!p.endsWith("SKILL.md")) {
    return { response: NextResponse.json({ error: "只允许读写 SKILL.md 文件" }, { status: 400 }) };
  }
  if (!existsSync(p)) {
    return { response: NextResponse.json({ error: "file not found" }, { status: 404 }) };
  }
  return { path: p };
}

// GET /api/skills/file?path=<SKILL.md 路径>
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const checked = validateSkillFilePath(searchParams.get("path"));
    if ("response" in checked) return checked.response;
    const allowedRoots = await resolveAllowedRootsForSkills();
    if (!isExistingFilePathAllowed(checked.path, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    const stat = await import("fs").then((fs) => fs.statSync(checked.path));
    if (stat.size > MAX_SKILL_FILE_BYTES) {
      return NextResponse.json({ error: "文件超过大小上限" }, { status: 413 });
    }
    return NextResponse.json({ path: checked.path, content: readFileSync(checked.path, "utf8") });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// PUT /api/skills/file — body: { path, content }
export async function PUT(req: Request) {
  try {
    const body = (await req.json()) as { path?: unknown; content?: unknown };
    const checked = validateSkillFilePath(body.path);
    if ("response" in checked) return checked.response;
    if (typeof body.content !== "string") {
      return NextResponse.json({ error: "content 必须是字符串" }, { status: 400 });
    }
    if (Buffer.byteLength(body.content, "utf8") > MAX_SKILL_FILE_BYTES) {
      return NextResponse.json({ error: "内容超过大小上限（512KB）" }, { status: 413 });
    }
    if (body.content.trim() === "") {
      return NextResponse.json({ error: "SKILL.md 不能为空（至少保留 frontmatter）" }, { status: 400 });
    }
    const allowedRoots = await resolveAllowedRootsForSkills();
    if (!isExistingFilePathAllowed(checked.path, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    writePrivateFileAtomicSync(checked.path, body.content.endsWith("\n") ? body.content : `${body.content}\n`);
    return NextResponse.json({ success: true, path: checked.path });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
