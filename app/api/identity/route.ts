import { NextResponse } from "next/server";
import {
  DEFAULT_IDENTITY_SECTIONS,
  IDENTITY_HISTORY_CAP,
  IDENTITY_HEADING,
  IDENTITY_MAX_SECTIONS,
  IDENTITY_SECTION_BODY_LIMIT,
  IDENTITY_TITLE_LIMIT,
  IDENTITY_TOTAL_LIMIT,
  buildIdentityText,
  listIdentityHistory,
  readIdentity,
  readIdentityHistory,
  restoreIdentity,
  writeIdentity,
  type IdentitySection,
} from "@/lib/identity";

export const dynamic = "force-dynamic";

/**
 * 身份（宿主提示词里「你是谁」那一段）的读写与版本历史。
 *
 * 数据在 `<agentDir>/elenva-identity.json`（0600、原子写、损坏回退内置默认），
 * 旧值快照在 `<agentDir>/elenva-identity-history/`（cap 50，最旧淘汰）。
 * 细节与边界见 lib/identity.ts。
 *
 *   GET  /api/identity                  — 当前身份 + 版本历史列表（+ 内置默认，供「重置」对照）
 *   GET  /api/identity?history=<id>     — 某个历史版本的全文（查看用）
 *   PUT  /api/identity                  — 保存：{ sections[], revision? }（保存前自动快照旧值）
 *   POST /api/identity                  — 恢复：{ action: "restore", id, revision? }（恢复前同样先快照当前值）
 *
 * revision = 当前文件内容哈希（与 /api/memory 同模式）：客户端读到的 revision 与磁盘不一致
 * 时判 409，避免覆盖别处的改动。
 */
export async function GET(req: Request) {
  try {
    const historyId = new URL(req.url).searchParams.get("history");
    if (historyId !== null) {
      const snapshot = readIdentityHistory(historyId);
      if (!snapshot) return NextResponse.json({ error: "历史版本不存在或已损坏" }, { status: 404 });
      return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
    }
    const current = readIdentity();
    const chars = buildIdentityText(current.document.sections).length;
    return NextResponse.json(
      {
        source: current.source,
        path: current.path,
        revision: current.revision,
        version: current.document.version,
        updatedAt: current.document.updatedAt,
        sections: current.document.sections,
        heading: IDENTITY_HEADING,
        chars,
        limit: IDENTITY_TOTAL_LIMIT,
        sectionBodyLimit: IDENTITY_SECTION_BODY_LIMIT,
        titleLimit: IDENTITY_TITLE_LIMIT,
        maxSections: IDENTITY_MAX_SECTIONS,
        historyCap: IDENTITY_HISTORY_CAP,
        /** 内置默认（= 改造前现文）；供界面「恢复内置默认」对照，不落盘 */
        defaultSections: DEFAULT_IDENTITY_SECTIONS,
        history: listIdentityHistory(),
        error: current.error,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function PUT(req: Request) {
  try {
    const body = (await req.json()) as { sections?: unknown; revision?: unknown };
    const result = writeIdentity({
      sections: (Array.isArray(body.sections) ? body.sections : []) as IdentitySection[],
      revision: typeof body.revision === "string" ? body.revision : undefined,
    });
    if (!result.ok) {
      const status = result.code === "conflict" ? 409 : 400;
      return NextResponse.json(result, { status });
    }
    return NextResponse.json({
      ...result,
      history: listIdentityHistory(),
      updatedAt: result.document.updatedAt,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "invalid", error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { action?: unknown; id?: unknown; revision?: unknown };
    if (body.action !== "restore" || typeof body.id !== "string") {
      return NextResponse.json({ ok: false, code: "invalid", error: "未知操作" }, { status: 400 });
    }
    const result = restoreIdentity(body.id, typeof body.revision === "string" ? body.revision : undefined);
    if (!result.ok) {
      const status = result.code === "conflict" ? 409 : 400;
      return NextResponse.json(result, { status });
    }
    return NextResponse.json({
      ...result,
      history: listIdentityHistory(),
      updatedAt: result.document.updatedAt,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "invalid", error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
