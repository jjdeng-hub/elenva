import { NextResponse } from "next/server";
import { archiveSkill, buildSkillLifecycle, dropArchived, restoreSkill } from "@/lib/skill-lifecycle";
import { loadSkillsWithInstallInfo } from "@/lib/skills-service";

export const dynamic = "force-dynamic";

/**
 * GET /api/skills/lifecycle?cwd=… —— 技能生命周期分层（活跃 / 久未使用 / 从未使用）+ 已归档列表。
 *
 * 状态是自动算的（按调用次数与会话出现时间），但**动作是人点的**：
 * 归档只是把技能目录搬到 skills 根目录之外，随时可恢复，绝不删除。
 */
export async function GET(req: Request) {
  try {
    const cwd = new URL(req.url).searchParams.get("cwd");
    const response = await loadSkillsWithInstallInfo(cwd || process.cwd());
    return NextResponse.json(
      buildSkillLifecycle(response.skills),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

/**
 * POST /api/skills/lifecycle —— body: { action: "archive" | "restore" | "drop", … }
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      cwd?: string;
      name?: string;
      baseDir?: string;
      reason?: string;
      id?: string;
    };

    switch (body.action) {
      case "archive": {
        if (!body.name || !body.baseDir) {
          return NextResponse.json({ error: "缺少 name 或 baseDir" }, { status: 400 });
        }
        const archived = archiveSkill(
          { name: body.name, baseDir: body.baseDir },
          body.reason || "手工归档",
        );
        return NextResponse.json({ success: true, archived });
      }
      case "restore": {
        if (!body.id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });
        const restored = restoreSkill(body.id);
        return NextResponse.json({ success: true, restored });
      }
      case "drop": {
        if (!body.id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });
        dropArchived(body.id);
        return NextResponse.json({ success: true });
      }
      default:
        return NextResponse.json({ error: "未知操作" }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
