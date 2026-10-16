import { NextResponse } from "next/server";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "@/lib/atomic-file";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { buildSkillMarkdown, isValidSkillDraftName, validateSkillDraft } from "@/lib/skill-drafts";
import { isSkillDraftTaken, skillDraftDir, skillDraftPath } from "@/lib/skill-drafts-server";

export const dynamic = "force-dynamic";

/** 技能库根目录：与技能页、SDK 加载器同一处（全局技能与内置技能都在这）。 */
function skillsRoot(): string {
  return join(getAgentDir(), "skills");
}

// GET /api/skills/draft/save?name=<name> → { name, exists }
// 草稿卡刷新后靠它判断「这个技能是不是已经在技能库里了」（磁盘存在性，不依赖会话状态）。
export async function GET(req: Request) {
  const name = new URL(req.url).searchParams.get("name") ?? "";
  if (!isValidSkillDraftName(name)) {
    return NextResponse.json({ error: "invalid name" }, { status: 400 });
  }
  const file = skillDraftPath(skillsRoot(), name);
  return NextResponse.json({ name, exists: existsSync(file) });
}

// POST /api/skills/draft/save  body: { name, description, body }
// 写 `<skillsRoot>/<name>/SKILL.md`。目标已存在 → 409，绝不覆盖。
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = (await req.json()) as { name?: unknown; description?: unknown; body?: unknown };
    const result = validateSkillDraft(body);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    const { draft } = result;

    const root = resolve(skillsRoot());
    const dir = skillDraftDir(root, draft.name);
    const file = skillDraftPath(root, draft.name);

    // 二道闸：name 已被限制为小写字母/数字/连字符，正常不可能越界；
    // 这里仍确认解析后的目录确实落在技能库根下（防御未来的校验放宽）。
    if (dir !== root && !dir.startsWith(root.endsWith(sep) ? root : root + sep)) {
      return NextResponse.json({ error: "非法路径" }, { status: 400 });
    }

    // 重名防护：技能目录已存在就不动（那是一个已装的技能，可能还有附属文件）
    if (isSkillDraftTaken(existsSync, root, draft.name)) {
      return NextResponse.json(
        { error: "同名技能已存在，未覆盖", name: draft.name, path: file, exists: true },
        { status: 409 },
      );
    }

    mkdirSync(dir, { recursive: true });
    writePrivateFileAtomicSync(file, buildSkillMarkdown(draft));
    return NextResponse.json({ ok: true, name: draft.name, path: file });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
