/**
 * 待办侧账本的**服务端只读解析**（扩展写、网页读）。
 *
 * 账本由扩展 `elenva-todo` 在 `todo_write` 成功时旁路写入（见
 * `extensions/elenva-todo/ledger.ts`），记录每条 open 待办的 firstSeen / lastSeen。
 * 这里只解析、不算写 —— 用来回答「这个会话有没有卡了很久没动的待办」。
 *
 * 阈值口径：**最老的 open 待办 ≥ 72h（3 天）** 才算逾期。
 * 我们不做「按优先级 × 天数」的加权，越简单越可解释：三天不动，就该被看到。
 *
 * 容错：文件缺失 / 坏 JSON / 坏条目一律当空账本 —— 账本是旁路数据，
 * 损坏只影响逾期提示本身，绝不报错给上层。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** 逾期阈值：72h */
export const OVERDUE_MS = 72 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** 最多列出多少个逾期会话 */
export const MAX_OVERDUE_SESSIONS = 10;
/** 每个会话最多带几条样例文本 */
export const MAX_OVERDUE_SAMPLES = 3;
/** 条目键最长 160 字（与扩展侧同口径） */
export const ITEM_KEY_MAX_LENGTH = 160;

export interface LedgerStamp {
  firstSeen: string;
  lastSeen: string;
}

export interface TodoLedger {
  sessions: Record<string, Record<string, LedgerStamp>>;
}

export interface OverdueTodoSample {
  /** 待办文本（账本键：已归一、截断到 160 字） */
  text: string;
  /** 已停留整天数（向下取整） */
  days: number;
}

export interface OverdueTodoSummary {
  sessionId: string;
  /** 该会话逾期的 open 待办条数 */
  count: number;
  /** 最老一条的整天数（向下取整） */
  oldestDays: number;
  /** 最老的至多 3 条样例（按天数降序） */
  samples: OverdueTodoSample[];
}

export function getTodoLedgerPath(agentDir = getAgentDir()): string {
  return join(agentDir, "elenva-todo-ledger.json");
}

/**
 * 条目键归一 —— 必须与扩展侧 `extensions/elenva-todo/ledger.ts` 的
 * `normalizeItemKey` 完全一致，否则两边对不上同一条待办。
 */
export function normalizeItemKey(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, ITEM_KEY_MAX_LENGTH);
}

function isStamp(value: unknown): value is LedgerStamp {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as LedgerStamp).firstSeen === "string" &&
    typeof (value as LedgerStamp).lastSeen === "string"
  );
}

/** 读取账本；文件缺失 / 坏 JSON / 结构不对 / 坏条目 → 丢弃（不报错）。 */
export function readTodoLedger(agentDir?: string): TodoLedger {
  const path = getTodoLedgerPath(agentDir);
  if (!existsSync(path)) return { sessions: {} };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object") return { sessions: {} };
    const sessionsRaw = (parsed as { sessions?: unknown }).sessions;
    if (sessionsRaw === null || typeof sessionsRaw !== "object" || Array.isArray(sessionsRaw)) {
      return { sessions: {} };
    }
    const sessions: Record<string, Record<string, LedgerStamp>> = {};
    for (const [sessionId, itemsRaw] of Object.entries(sessionsRaw as Record<string, unknown>)) {
      if (!sessionId || itemsRaw === null || typeof itemsRaw !== "object" || Array.isArray(itemsRaw)) {
        continue;
      }
      const items: Record<string, LedgerStamp> = {};
      for (const [key, stamp] of Object.entries(itemsRaw as Record<string, unknown>)) {
        if (!key || !isStamp(stamp)) continue;
        items[key] = { firstSeen: stamp.firstSeen, lastSeen: stamp.lastSeen };
      }
      if (Object.keys(items).length > 0) sessions[sessionId] = items;
    }
    return { sessions };
  } catch {
    return { sessions: {} };
  }
}

/** firstSeen → 停留整天数；无法解析的时间戳返回 null（跳过该条）。 */
function overdueDays(firstSeen: string, now: number): number | null {
  const at = Date.parse(firstSeen);
  if (!Number.isFinite(at)) return null;
  const age = now - at;
  if (age < OVERDUE_MS) return null;
  return Math.floor(age / DAY_MS);
}

/**
 * 由账本算出逾期会话列表。
 *
 * - 只列**存在逾期 open 条目**的会话（所有条目都已变动 / 移除的会话自然不出现）。
 * - 按 oldestDays 降序，最多 10 个会话；每会话最多 3 条样例（天数降序）。
 */
export function computeOverdueTodos(ledger: TodoLedger, now = Date.now()): OverdueTodoSummary[] {
  const summaries: OverdueTodoSummary[] = [];
  for (const [sessionId, items] of Object.entries(ledger.sessions)) {
    const due: OverdueTodoSample[] = [];
    for (const [key, stamp] of Object.entries(items)) {
      const days = overdueDays(stamp.firstSeen, now);
      if (days === null) continue;
      due.push({ text: key, days });
    }
    if (due.length === 0) continue;
    due.sort((a, b) => b.days - a.days);
    summaries.push({
      sessionId,
      count: due.length,
      oldestDays: due[0].days,
      samples: due.slice(0, MAX_OVERDUE_SAMPLES),
    });
  }
  summaries.sort((a, b) => b.oldestDays - a.oldestDays);
  return summaries.slice(0, MAX_OVERDUE_SESSIONS);
}
