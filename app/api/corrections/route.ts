import { NextResponse } from "next/server";
import { appendAgentMemoryEntry, isAgentMemoryFileId, listAgentMemoryFiles } from "@/lib/agent-memory";
import {
  CORRECTION_RECURRENCE_THRESHOLD,
  listCorrections,
  matchRecurrences,
  ruleCoreOf,
  ruleHashOf,
  type PromotedRule,
} from "@/lib/corrections";
import {
  readCorrectionStates,
  removeCorrectionState,
  updateCorrectionState,
  type CorrectionState,
} from "@/lib/corrections-state";
import { recordMemoryOrigin } from "@/lib/memory-origins";

export const dynamic = "force-dynamic";

/**
 * 「纠正 → 规则」流水线接口（只读纠正集 + sidecar 状态 + 一键升格 + 复发对照）。
 *
 * 纠正来源：pi-hermes-memory 把用户纠错落成记忆文件里的 `[correction]` 条目
 * （侦察见 `lib/corrections.ts` 顶部注释）；**本接口只读那些文件，从不写入**。
 * 处理状态（待处理 / 已升格 / 已处理 / 已搁置）存 `lib/corrections-state.ts` 的 sidecar。
 *
 * GET  /api/corrections — { items, rules, stats, memoryFiles, threshold }
 * POST /api/corrections — { action: "promote", id, file, text? } 升格为记忆条目（走既有写链）
 *                       | { action: "shelve" | "resolve" | "reopen", id }
 *
 * 边界：AGENTS.md 草稿只由 `agentsDraft` 出文本，前端展示/复制；**任何路径都不会自动写 AGENTS.md**。
 * 升格写记忆成功后，来源账本记 `via:"web-edit"`（沿用既有词表，不新增 via——新增会让扩展侧
 * 另一份实现（extensions/elenva-memory/origins.ts）在下次重写账本时丢弃未知 via）。
 */

function fail(error: string, status = 400) {
  return NextResponse.json({ ok: false, error }, { status });
}

/** 从 sidecar 的 promoted 状态还原已升格规则（缺 ruleHash / ruleCore 的旧状态跳过） */
function promotedRulesFromStates(states: Record<string, CorrectionState>): PromotedRule[] {
  const rules: PromotedRule[] = [];
  for (const [id, state] of Object.entries(states)) {
    if (state.status !== "promoted" || !state.ruleHash || !state.ruleCore) continue;
    rules.push({
      sourceCorrectionId: id,
      ruleHash: state.ruleHash,
      ruleCore: state.ruleCore,
      at: state.at,
      ...(state.memoryFile ? { memoryFile: state.memoryFile } : {}),
    });
  }
  return rules;
}

export async function GET() {
  try {
    const items = listCorrections();
    const states = readCorrectionStates();
    const rules = promotedRulesFromStates(states);
    const recurrence = matchRecurrences(items, rules);

    const enriched = items.map((item) => ({
      ...item,
      state: states[item.id] ?? null,
      recurrence: recurrence.byCorrection[item.id] ?? null,
    }));

    const stats = {
      total: enriched.length,
      pending: enriched.filter((i) => !i.state).length,
      promoted: enriched.filter((i) => i.state?.status === "promoted").length,
      resolved: enriched.filter((i) => i.state?.status === "resolved").length,
      shelved: enriched.filter((i) => i.state?.status === "shelved").length,
      recurrences: Object.keys(recurrence.byCorrection).length,
    };

    // 规则清单：带「升格之后的命中」（状态页用它展示复发对照）
    const ruleList = rules
      .map((rule) => {
        const state = states[rule.sourceCorrectionId];
        return {
          ruleHash: rule.ruleHash,
          ruleCore: rule.ruleCore,
          ruleText: state?.ruleText ?? rule.ruleCore,
          memoryFile: rule.memoryFile ?? null,
          at: rule.at,
          sourceCorrectionId: rule.sourceCorrectionId,
          hits: recurrence.byRule[rule.ruleHash] ?? [],
        };
      })
      .sort((a, b) => b.at.localeCompare(a.at));

    return NextResponse.json({
      items: enriched,
      rules: ruleList,
      stats,
      threshold: CORRECTION_RECURRENCE_THRESHOLD,
      // 升格目标的可选记忆文件 + 当前占用（failures.md 常已超限，界面上要能看见）
      memoryFiles: listAgentMemoryFiles().files.map((f) => ({
        id: f.id,
        label: f.label,
        kind: f.kind,
        chars: f.chars,
        limit: f.limit,
      })),
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error), 500);
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      action?: unknown;
      id?: unknown;
      file?: unknown;
      text?: unknown;
    };
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) return fail("缺少纠正 id");

    // 每条动作都先确认纠正还在记忆文件里（可能已被会话改写/删除）
    const items = listCorrections();
    const item = items.find((i) => i.id === id) ?? null;

    if (body.action === "promote") {
      if (!item) return fail("这条纠正已不在记忆文件里（可能被改写或删除），刷新看看", 409);
      const file = typeof body.file === "string" ? body.file : "";
      if (!isAgentMemoryFileId(file)) return fail("未知的记忆文件标识（升格去向）");

      const trimmed = typeof body.text === "string" ? body.text.trim() : "";
      const ruleText = trimmed || item.ruleDraft;
      if (!ruleText) return fail("规则正文不能为空");
      if (ruleText.length > 20_000) return fail(`单条过长（${ruleText.length} 字符上限 20000），请拆分`);

      const result = appendAgentMemoryEntry(file, ruleText);
      if (!result.ok) {
        return NextResponse.json(
          { ok: false, code: result.code, error: result.error, chars: result.chars, limit: result.limit },
          { status: result.code === "conflict" ? 409 : 400 },
        );
      }
      // 写入成功才记来源与状态（来源账本沿用既有 via 词表：这是网页端发起的写入）
      recordMemoryOrigin({
        file,
        text: ruleText,
        via: "web-edit",
        sessionId: item.origin?.sessionId ?? null,
        cwd: item.origin?.cwd ?? null,
      });
      const state = updateCorrectionState(id, {
        status: "promoted",
        ruleHash: ruleHashOf(ruleText),
        ruleCore: ruleCoreOf(ruleText),
        ruleText,
        memoryFile: file,
      });
      return NextResponse.json({
        ok: true,
        id,
        file,
        chars: result.chars,
        limit: result.limit,
        state,
      });
    }

    if (body.action === "shelve" || body.action === "resolve") {
      if (!item) return fail("这条纠正已不在记忆文件里（可能被改写或删除），刷新看看", 409);
      const state = updateCorrectionState(id, { status: body.action === "shelve" ? "shelved" : "resolved" });
      if (!state) return fail("状态写入失败");
      return NextResponse.json({ ok: true, id, state });
    }

    if (body.action === "reopen") {
      removeCorrectionState(id);
      return NextResponse.json({ ok: true, id, state: null });
    }

    return fail("未知 action");
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error), 500);
  }
}
