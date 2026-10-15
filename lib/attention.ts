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
 *
 * The same tail read also yields "recent completions" (last main message is an
 * assistant reply and there is no attention signal) — used by the dashboard's
 * 「最近完成」 section. Reusing one scan avoids opening every session twice.
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

/** 24h 内、无等待信号、最后一条实质消息为 assistant 的会话 */
export interface RecentCompletion {
  sessionId: string;
  /** 最后一条 assistant 回复（截断后的短句，展示端再按需收窄） */
  detail: string;
  /** 会话最近活动时间（用于倒序与相对时间） */
  at: string;
}

export interface AttentionOverview {
  items: AttentionItem[];
  completions: RecentCompletion[];
}

const TAIL = 14;
/** 「最近完成」的时间窗 */
export const RECENT_COMPLETION_MS = 24 * 60 * 60 * 1000;
/** 「最近完成」最多呈现的条数 */
export const RECENT_COMPLETION_MAX = 5;

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

interface SessionScan {
  attention: AttentionItem | null;
  completion: RecentCompletion | null;
}

const EMPTY_SCAN: SessionScan = { attention: null, completion: null };

async function inspectSession(session: SessionInfo): Promise<SessionScan> {
  const filePath = await resolveSessionPath(session.id);
  if (!filePath) return EMPTY_SCAN;

  let messages;
  try {
    const sm = SessionManager.open(filePath);
    const context = buildSessionContext(sm.getEntries() as never, undefined, { tail: TAIL });
    messages = context.messages;
  } catch {
    return EMPTY_SCAN;
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
  if (lastMainIndex === -1) return EMPTY_SCAN;
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

  const attention: AttentionItem | null =
    reasons.length === 0 ? null : { sessionId: session.id, reasons, detail };

  // 最近完成：没有等待信号、最后一条实质消息是 assistant 的收尾回复
  let completion: RecentCompletion | null = null;
  if (!attention && last.role === "assistant") {
    const text = truncate(textOf(last.content), 160);
    if (text) completion = { sessionId: session.id, detail: text, at: session.modified };
  }

  return { attention, completion };
}

/**
 * 一次扫描同时产出「需关注」与「最近完成」。
 * 运行中 / transient 会话跳过；最近完成再按会话活动时间倒序取前 N 条。
 */
export async function detectAttentionOverview(
  sessions: SessionInfo[],
  runningIds: Set<string>,
): Promise<AttentionOverview> {
  const idle = sessions.filter((s) => !s.transient && !runningIds.has(s.id));
  const scans = await Promise.all(idle.map((s) => inspectSession(s)));
  const cutoff = Date.now() - RECENT_COMPLETION_MS;
  const items: AttentionItem[] = [];
  const completions: RecentCompletion[] = [];
  for (let i = 0; i < idle.length; i++) {
    const { attention, completion } = scans[i];
    if (attention) items.push(attention);
    const modified = Date.parse(idle[i].modified);
    if (completion && Number.isFinite(modified) && modified >= cutoff) {
      completions.push(completion);
    }
  }
  completions.sort((a, b) => b.at.localeCompare(a.at));
  return { items, completions: completions.slice(0, RECENT_COMPLETION_MAX) };
}

/** 扫描全部空闲会话，返回需关注列表。运行中/transient 会话跳过。 */
export async function detectAttention(
  sessions: SessionInfo[],
  runningIds: Set<string>,
): Promise<AttentionItem[]> {
  return (await detectAttentionOverview(sessions, runningIds)).items;
}
