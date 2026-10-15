import { NextResponse } from "next/server";
import { appendAgentMemoryEntry } from "@/lib/agent-memory";
import { appendContextInstruction } from "@/lib/context-files";
import { basename } from "@/lib/format";
import { recordMemoryOrigin } from "@/lib/memory-origins";
import {
  addPendingMemory,
  findPendingMemory,
  listPendingMemory,
  removePendingMemory,
  toPendingMemorySource,
} from "@/lib/pending-memory";

export const dynamic = "force-dynamic";

/**
 * 「记住这条 → 先入待审」的队列接口（存储见 lib/pending-memory.ts）。
 *
 * GET  /api/memory/pending — { items }（新 → 旧）
 * POST /api/memory/pending — { action: "add", text, source? }
 *                          | { action: "resolve", id, target, text? }
 *                          | { action: "discard", id }
 *
 * resolve 的四个去向（约定走 AGENTS.md，记忆走 hermes 落盘，两个体系不混）：
 *  - project-agents  → 追加到 <cwd>/AGENTS.md（需要 source.cwd）
 *  - global-agents   → 追加到 ~/.pi/agent/AGENTS.md
 *  - project-memory  → 追加到 project/<basename(cwd)>/MEMORY.md（需要 source.cwd）
 *  - global-memory   → 追加到 ~/.pi/agent/pi-hermes-memory/MEMORY.md
 * **只有写入成功才出队**：失败时条目留在队列里，用户可以在记忆页改文字重试。
 *
 * 记忆两项写入成功后会在来源账本里记一条 `via:"pending"`（来路：待审确认）。
 */

type ResolveTarget = "project-agents" | "global-agents" | "project-memory" | "global-memory";
const RESOLVE_TARGETS: readonly ResolveTarget[] = [
  "project-agents",
  "global-agents",
  "project-memory",
  "global-memory",
];

function fail(error: string, status = 400) {
  return NextResponse.json({ ok: false, error }, { status });
}

export async function GET() {
  try {
    return NextResponse.json({ items: listPendingMemory() });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error), 500);
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      action?: unknown;
      text?: unknown;
      id?: unknown;
      target?: unknown;
      source?: unknown;
    };

    if (body.action === "add") {
      const result = addPendingMemory({
        text: typeof body.text === "string" ? body.text : "",
        source: toPendingMemorySource(body.source),
      });
      if (!result.ok) return fail(result.error);
      return NextResponse.json({ ok: true, item: result.item, count: result.count });
    }

    if (body.action === "discard") {
      if (typeof body.id !== "string" || !body.id) return fail("缺少待审 id");
      const removed = removePendingMemory(body.id);
      if (!removed) return fail("这条待审不存在（可能已在别处处理）");
      return NextResponse.json({ ok: true, id: removed.id });
    }

    if (body.action === "resolve") {
      if (typeof body.id !== "string" || !body.id) return fail("缺少待审 id");
      if (typeof body.target !== "string" || !RESOLVE_TARGETS.includes(body.target as ResolveTarget)) {
        return fail("未知去向");
      }
      const item = findPendingMemory(body.id);
      if (!item) return fail("这条待审不存在（可能已在别处处理）");
      const target = body.target as ResolveTarget;
      const text = typeof body.text === "string" && body.text.trim() ? body.text : item.text;
      const cwd = item.source?.cwd ?? null;

      if (target === "project-agents" || target === "global-agents") {
        if (target === "project-agents" && !cwd) return fail("该待审缺少项目目录");
        appendContextInstruction(target, text, cwd);
      } else {
        if (target === "project-memory" && !cwd) return fail("该待审缺少项目目录");
        const fileId = target === "project-memory" ? `project/${basename(cwd as string)}` : "memory";
        const result = appendAgentMemoryEntry(fileId, text);
        if (!result.ok) {
          return NextResponse.json(
            { ok: false, code: result.code, error: result.error },
            { status: result.code === "conflict" ? 409 : 400 },
          );
        }
        // 写入成功才记来源；sessionId / cwd 沿用这条待审原来的来源
        recordMemoryOrigin({
          file: fileId,
          text,
          via: "pending",
          sessionId: item.source?.sessionId ?? null,
          cwd: item.source?.cwd ?? null,
        });
      }

      // 落盘成功后才出队
      removePendingMemory(item.id);
      return NextResponse.json({ ok: true, id: item.id, target });
    }

    return fail("未知 action");
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
