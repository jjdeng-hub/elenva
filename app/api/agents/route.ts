import { NextResponse } from "next/server";
import { listAgents } from "@/lib/agents/registry";

export const dynamic = "force-dynamic";

/**
 * GET /api/agents —— Agent 注册表快照。
 *
 * 只读、无参数：返回内置 Agent + 用户目录（`ELENVA_AGENTS_DIR`，缺省 `~/.elenva/agents`）
 * 下的应用包。坏包不会让接口失败，而是降级成 `errors` 里的一条说明。
 */
export async function GET() {
  try {
    return NextResponse.json(listAgents(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
