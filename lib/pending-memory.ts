import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";

/**
 * 「记住这条 → 先入待审」的队列（ELENVA 自有存储，additive，不进 pi-hermes-memory 本体）。
 *
 * 为什么要有它：从对话里沉淀记忆时，用户往往**当下就知道该记什么、但不确定记到哪一层**
 * （项目约定 / 全局约定 / 项目记忆 / 全局记忆）。直接落盘等于让用户在弹窗里一次性选对；
 * 待审把这步推迟到「记忆」页 —— 那里看得到现有条目和配额，确认去向更从容。
 *
 * 存储：`<agentDir>/elenva-pending-memory.json`，`{version:1, items:[…]}`。
 * 文件损坏 / 结构非法一律按空表处理（待审是尽力而为的暂存，不能因为一个坏文件把记忆页拖垮）。
 */

export const PENDING_MEMORY_LIMIT = 50;
export const PENDING_MEMORY_TEXT_MAX = 20_000;
const PENDING_FILE = "elenva-pending-memory.json";

/** 待审来源（可选；用于 resolve 时找回项目目录：项目约定 / 项目记忆都需要它） */
export interface PendingMemorySource {
  sessionId?: string | null;
  cwd?: string | null;
}

export interface PendingMemoryItem {
  id: string;
  text: string;
  /** ISO 时间 */
  createdAt: string;
  source?: PendingMemorySource;
}

export type PendingMemoryAddResult =
  | { ok: true; item: PendingMemoryItem; count: number }
  | { ok: false; error: string };

export function getPendingMemoryPath(): string {
  return join(getAgentDir(), PENDING_FILE);
}

/**
 * 清洗来源对象：只留 sessionId / cwd 两个字符串或 null 字段（其余一律丢弃）。
 * 结构不合法时返回 undefined（没有来源 = 非项目相关，resolve 时不允许写项目层）。
 */
export function toPendingMemorySource(value: unknown): PendingMemorySource | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const source: PendingMemorySource = {};
  if (typeof raw.sessionId === "string" || raw.sessionId === null) source.sessionId = raw.sessionId;
  if (typeof raw.cwd === "string" || raw.cwd === null) source.cwd = raw.cwd;
  return Object.keys(source).length > 0 ? source : undefined;
}

/** 磁盘上的一条 → 规范化条目；非法（缺 id / 文本空）返回 null 由调用方过滤 */
function normalizeItem(value: unknown): PendingMemoryItem | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !raw.id.trim()) return null;
  if (typeof raw.text !== "string" || !raw.text.trim()) return null;
  const item: PendingMemoryItem = {
    id: raw.id,
    text: raw.text,
    createdAt:
      typeof raw.createdAt === "string" && raw.createdAt.trim() ? raw.createdAt : new Date().toISOString(),
  };
  const source = toPendingMemorySource(raw.source);
  if (source) item.source = source;
  return item;
}

/** 读队列（文件缺失 / 损坏 / 结构非法 → 空数组，不抛） */
function readItems(): PendingMemoryItem[] {
  let raw: string;
  try {
    raw = readFileSync(getPendingMemoryPath(), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return [];
    const items = (parsed as { items?: unknown }).items;
    if (!Array.isArray(items)) return [];
    return items.map(normalizeItem).filter((item): item is PendingMemoryItem => item !== null);
  } catch {
    return [];
  }
}

/** 写队列：先建目录，再原子写（权限 0600，与其余本机私有文件一致） */
function writeItems(items: PendingMemoryItem[]): void {
  const path = getPendingMemoryPath();
  mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(path, `${JSON.stringify({ version: 1, items }, null, 2)}\n`);
}

/** 待审列表：新 → 旧（文件里按加入顺序存放） */
export function listPendingMemory(): PendingMemoryItem[] {
  return readItems().reverse();
}

export function findPendingMemory(id: string): PendingMemoryItem | null {
  return readItems().find((item) => item.id === id) ?? null;
}

/**
 * 入队。文本 trim 后必须 1–20000 字符；超过 50 条报错（要求先处理，避免队列无限增长）。
 */
export function addPendingMemory(input: { text: string; source?: PendingMemorySource }): PendingMemoryAddResult {
  const text = typeof input?.text === "string" ? input.text.trim() : "";
  if (!text) return { ok: false, error: "内容不能为空" };
  if (text.length > PENDING_MEMORY_TEXT_MAX) {
    return { ok: false, error: `单条过长（${text.length} 字符上限 ${PENDING_MEMORY_TEXT_MAX}），请拆分` };
  }
  const items = readItems();
  if (items.length >= PENDING_MEMORY_LIMIT) {
    return { ok: false, error: `待审已满（${PENDING_MEMORY_LIMIT} 条），先处理一下` };
  }
  const item: PendingMemoryItem = {
    id: `pm-${Date.now()}-${randomBytes(3).toString("hex")}`,
    text,
    createdAt: new Date().toISOString(),
  };
  const source = toPendingMemorySource(input?.source);
  if (source) item.source = source;
  items.push(item);
  writeItems(items);
  return { ok: true, item, count: items.length };
}

/** 出队（确认写入成功后调用）。返回被移除的条目；id 不存在返回 null。 */
export function removePendingMemory(id: string): PendingMemoryItem | null {
  const items = readItems();
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) return null;
  const [removed] = items.splice(index, 1);
  writeItems(items);
  return removed;
}
