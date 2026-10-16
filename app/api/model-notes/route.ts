import { NextResponse } from "next/server";
import {
  MAX_NOTE_LENGTH,
  readModelNotes,
  saveModelNote,
  validateNote,
} from "@/lib/model-notes";

export const dynamic = "force-dynamic";

/**
 * 模型备注（模块 6 · 第 4 轮）。
 *
 * 一张表、两个动作：GET 全量（界面一次拉完，避免逐行请求），POST `{provider, modelId, note}`
 * 落一条（`note` 归一后为空串 = 清除）。
 *
 * 备注是本地自建档案，不参与模型清单加载，也不写进 pi 的 settings/models.json——
 * 它是给人看的，内核不需要知道。
 */
export async function GET() {
  try {
    return NextResponse.json(
      { notes: readModelNotes(), maxLength: MAX_NOTE_LENGTH },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

/** POST /api/model-notes  body: { provider, modelId, note } */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      provider?: unknown;
      modelId?: unknown;
      note?: unknown;
    };

    const provider = typeof body.provider === "string" ? body.provider.trim() : "";
    const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
    if (!provider || !modelId) {
      return NextResponse.json({ error: "缺少 provider 或 modelId" }, { status: 400 });
    }

    const validated = validateNote(body.note);
    if (!validated.ok) {
      return NextResponse.json({ error: validated.error }, { status: 400 });
    }

    const saved = saveModelNote(provider, modelId, validated.note);
    return NextResponse.json(
      { ok: true, provider, modelId, note: saved?.note ?? null, updatedAt: saved?.updatedAt ?? null },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
