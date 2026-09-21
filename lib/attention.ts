/**
 * "Needs attention" detection for idle sessions.
 *
 * A session needs attention when, on its active branch:
 *  - "interrupted": the LAST message is a user message — an instruction was
 *    sent but the agent never produced a final response (stopped/aborted).
 *  - "error": the most recent toolResult has isError — the agent's latest
 *    tool call failed (likely needs human decision to continue).
 *
 * Running sessions are excluded (caller filters them out).
 */

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { buildSessionContext, resolveSessionPath } from "./session-reader";
import type { SessionInfo } from "./types";

export type AttentionReason = "interrupted" | "error";

export interface AttentionItem {
  sessionId: string;
  reasons: AttentionReason[];
  /** Short human-readable detail (user text or tool error snippet). */
  detail: string;
}

const TAIL = 14;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: string }).text ?? "") : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

async function inspectSession(session: SessionInfo): Promise<AttentionItem | null> {
  const filePath = await resolveSessionPath(session.id);
  if (!filePath) return null;

  let messages;
  try {
    const sm = SessionManager.open(filePath);
    const context = buildSessionContext(sm.getEntries() as never, undefined, { tail: TAIL });
    messages = context.messages;
  } catch {
    return null;
  }

  const reasons: AttentionReason[] = [];
  let detail = "";

  // 从尾部找最后一条实质性消息（跳过 custom/bashExecution 等）
  let lastMainIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i]?.role;
    if (role === "user" || role === "assistant" || role === "toolResult") {
      lastMainIndex = i;
      break;
    }
  }
  if (lastMainIndex === -1) return null;
  const last = messages[lastMainIndex];

  if (last.role === "user") {
    reasons.push("interrupted");
    detail = truncate(textOf(last.content), 80);
  }

  // 最近一次 toolResult 报错（在 tail 范围内从后往前找第一条 toolResult）
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "toolResult") {
      if (m.isError) {
        reasons.push("error");
        const text = textOf(m.content);
        detail = detail || `${m.toolName ?? "tool"}: ${truncate(text, 80)}`;
      }
      break;
    }
    if (m?.role === "assistant") break; // agent 已正常回应，旧错误不再提示
  }

  if (reasons.length === 0) return null;
  return { sessionId: session.id, reasons, detail };
}

/** 扫描全部空闲会话，返回需关注列表。运行中/transient 会话跳过。 */
export async function detectAttention(sessions: SessionInfo[], runningIds: Set<string>): Promise<AttentionItem[]> {
  const items = await Promise.all(
    sessions
      .filter((s) => !s.transient && !runningIds.has(s.id))
      .map((s) => inspectSession(s)),
  );
  return items.filter((x): x is AttentionItem => x !== null);
}
