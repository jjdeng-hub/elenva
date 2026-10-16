import { NextResponse } from "next/server";
import { installBuiltin } from "@/lib/builtin-catalog";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

/**
 * POST /api/builtin-catalog/install —— { path: "extensions/<name>" | "skills" }
 *
 * 复制是**幂等**的（重复执行即更新），语义与 `install.mjs` 完全一致；白名单只允许
 * 从仓库枚举出来的项，`path` 里带 `..` / 绝对路径一律拒绝。
 */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Expected application/json" }, { status: 415 });
  }
  try {
    const body = (await req.json().catch(() => ({}))) as { path?: unknown };
    const target = typeof body.path === "string" ? body.path.trim() : "";
    if (!target) {
      return NextResponse.json({ error: "path required" }, { status: 400 });
    }
    const result = await installBuiltin(process.cwd(), target);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    return NextResponse.json({ item: result.item, ...result.response });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
