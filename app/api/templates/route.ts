import { NextResponse } from "next/server";
import { createTemplate, deleteTemplate, listTemplates } from "@/lib/templates";

export const dynamic = "force-dynamic";

/** GET /api/templates —— 全部会话模板（createdAt 升序） */
export async function GET() {
  try {
    return NextResponse.json(
      { templates: listTemplates() },
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
 * POST /api/templates —— 模板增删。
 *
 * action 形态（同 guardrails / skills lifecycle）：
 *  · `{ action: "create", name, cwd?, prompt }` → 校验后创建，返回 `{ template }`
 *  · `{ action: "delete", id }` → 删除，返回 `{ ok: true }`
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      id?: string;
      name?: string;
      cwd?: string | null;
      prompt?: string;
    };

    switch (body.action) {
      case "create": {
        try {
          const template = createTemplate({
            name: body.name ?? "",
            cwd: body.cwd ?? null,
            prompt: body.prompt ?? "",
          });
          return NextResponse.json({ template });
        } catch (error) {
          return NextResponse.json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 400 },
          );
        }
      }
      case "delete": {
        if (!body.id) return NextResponse.json({ error: "缺少模板 id" }, { status: 400 });
        try {
          deleteTemplate(body.id);
          return NextResponse.json({ ok: true });
        } catch (error) {
          return NextResponse.json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 400 },
          );
        }
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
