import { NextResponse } from "next/server";
import { dismissSuggestion, listMemorySuggestions, type MemorySuggestion } from "@/lib/memory-suggestions";

export const dynamic = "force-dynamic";

/**
 * 记忆整理候选（只读扫描 + 忽略清单）。
 *
 * GET  /api/memory/suggestions           → { candidates: MemorySuggestion[] }
 * POST /api/memory/suggestions           → { action: "dismiss", key } 落盘忽略（200）
 *
 * 扫描是纯静态启发式（零模型调用），**只读工作记录**；候选「存入记忆」走既有
 * `POST /api/memory`（不在这里新增写入口）。忽略清单存 `<agentDir>/elenva-memory-suggests.json`。
 */
export async function GET() {
  try {
    return NextResponse.json({ candidates: listMemorySuggestions() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { action?: unknown; key?: unknown };
    if (body.action === "dismiss") {
      if (typeof body.key !== "string" || !body.key.trim()) {
        return NextResponse.json({ ok: false, error: "缺少候选 key" }, { status: 400 });
      }
      const ok = dismissSuggestion(body.key);
      if (!ok) {
        return NextResponse.json({ ok: false, error: "忽略失败（无法写入忽略清单）" }, { status: 500 });
      }
      return NextResponse.json({ ok: true, key: body.key });
    }
    return NextResponse.json({ ok: false, error: "未知 action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export type { MemorySuggestion };
