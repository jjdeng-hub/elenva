import { NextResponse } from "next/server";
import { computeBuiltinCatalog } from "@/lib/builtin-catalog";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

/**
 * GET /api/builtin-catalog —— 仓库自带扩展/技能的清单 + 安装状态 + 依赖提示。
 *
 * 与 `/api/plugins` 的区别：那边看的是「已安装的 pi 包」，这边看的是**仓库里的源码**
 * 是否已经复制进 agent 目录（即 README 里 `node extensions/<name>/install.mjs` 那件事）。
 * 只读 agent 目录、复制源在仓库，不涉及用户可写的 cwd，故不需要 cwd 参数。
 */
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    return NextResponse.json(await computeBuiltinCatalog(process.cwd()), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
