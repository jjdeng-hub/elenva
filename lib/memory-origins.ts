import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";

/**
 * 记忆来源账本（ELENVA 自有存储，additive，不改 pi-hermes-memory 的条目格式）。
 *
 * 为什么要有它：记忆条目只带 `created/last` 两个日期，看不出「这条从哪来」——是 Agent 在某个
 * 会话里记的，还是网页编辑、还是「记住菜单 / 待审」写的。可信度判断与清理都缺这一手信息。
 *
 * 存储：`<agentDir>/elenva-memory-origins.json`（0600 原子写），
 *   `{ version: 1, items: { "<fileId>\u0000<sha1(正文)>": { via, at, sessionId?, cwd? } } }`
 * 键口径：`fileId + "\u0000" + sha1(entryText.trim())`，entryText 是**剥掉尾部
 * `<!-- created=… -->` 注释后的正文**——扩展落盘时会补注释，读取端拿到的是剥好的正文，
 * 两边必须归一到同一串才能对上。
 *
 * 边界：这是**尽力而为**的旁路账本。文件损坏 / 结构非法 → 空表，不抛；写失败不影响记忆
 * 本身落盘（记忆是正文，来源是注释性的附加信息）。冲突可容忍，后写胜。
 */

export type MemoryOriginVia = "agent" | "web-edit" | "remember" | "pending";

/** via 取值域：Agent 会话写入 / 网页编辑 / 记住菜单 / 待审确认 */
export const MEMORY_ORIGIN_VIAS: readonly MemoryOriginVia[] = ["agent", "web-edit", "remember", "pending"];

export interface MemoryOrigin {
  via: MemoryOriginVia;
  /** ISO 时间 */
  at: string;
  sessionId?: string;
  cwd?: string;
}

/** 账本条目上限：超出按 `at` 淘汰最旧（来源是旁路信息，不必无限增长） */
export const MEMORY_ORIGINS_LIMIT = 800;

const ORIGINS_FILE = "elenva-memory-origins.json";

export function getMemoryOriginsPath(): string {
  return join(getAgentDir(), ORIGINS_FILE);
}

export function isMemoryOriginVia(value: unknown): value is MemoryOriginVia {
  return typeof value === "string" && (MEMORY_ORIGIN_VIAS as readonly string[]).includes(value);
}

/** 条目正文归一：剥掉尾部 `<!-- created=… -->` 注释，再 trim（与扩展的落盘格式对齐） */
export function normalizeOriginEntryText(text: string): string {
  return text.replace(/\s*<!--\s*created=[^>]*-->\s*$/, "").trim();
}

function sha1(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex");
}

/** 账本键：fileId + NUL + sha1(归一后的正文) */
export function memoryOriginKey(file: string, text: string): string {
  return `${file}\u0000${sha1(normalizeOriginEntryText(text))}`;
}

interface OriginsLedger {
  version: 1;
  items: Record<string, MemoryOrigin>;
}

const EMPTY_LEDGER: OriginsLedger = { version: 1, items: {} };

function normalizeOrigin(value: unknown): MemoryOrigin | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (!isMemoryOriginVia(raw.via)) return null;
  if (typeof raw.at !== "string" || !raw.at.trim()) return null;
  const origin: MemoryOrigin = { via: raw.via, at: raw.at };
  if (typeof raw.sessionId === "string" && raw.sessionId) origin.sessionId = raw.sessionId;
  if (typeof raw.cwd === "string" && raw.cwd) origin.cwd = raw.cwd;
  return origin;
}

/** 读账本（文件缺失 / 损坏 / 结构非法 → 空表，不抛） */
function readLedger(): OriginsLedger {
  let raw: string;
  try {
    raw = readFileSync(getMemoryOriginsPath(), "utf8");
  } catch {
    return { ...EMPTY_LEDGER, items: {} };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { ...EMPTY_LEDGER, items: {} };
    const items = (parsed as { items?: unknown }).items;
    if (typeof items !== "object" || items === null || Array.isArray(items)) {
      return { ...EMPTY_LEDGER, items: {} };
    }
    const clean: Record<string, MemoryOrigin> = {};
    for (const [key, value] of Object.entries(items as Record<string, unknown>)) {
      const origin = normalizeOrigin(value);
      if (origin) clean[key] = origin;
    }
    return { version: 1, items: clean };
  } catch {
    return { ...EMPTY_LEDGER, items: {} };
  }
}

/** 上限淘汰：条目数超上限时，按 `at` 从旧到新删 */
function evictOldest(ledger: OriginsLedger): void {
  const entries = Object.entries(ledger.items);
  if (entries.length <= MEMORY_ORIGINS_LIMIT) return;
  entries.sort((a, b) => Date.parse(a[1].at) - Date.parse(b[1].at));
  const removeCount = entries.length - MEMORY_ORIGINS_LIMIT;
  for (let i = 0; i < removeCount; i += 1) delete ledger.items[entries[i][0]];
}

export interface RecordMemoryOriginInput {
  /** 记忆文件标识：user | memory | failures | project/<项目名> */
  file: string;
  /** 条目正文（带不带元数据注释都行，内部会归一） */
  text: string;
  via: MemoryOriginVia;
  sessionId?: string | null;
  cwd?: string | null;
}

/**
 * 记一条来源（读-改-写，后写胜）。返回是否成功落盘。
 * 不抛：来源是旁路信息，记录失败不能把记忆写入本身带崩。
 */
export function recordMemoryOrigin(input: RecordMemoryOriginInput): boolean {
  if (!input || !isMemoryOriginVia(input.via)) return false;
  if (typeof input.file !== "string" || !input.file.trim()) return false;
  if (typeof input.text !== "string") return false;

  const key = memoryOriginKey(input.file, input.text);
  const ledger = readLedger();
  const origin: MemoryOrigin = { via: input.via, at: new Date().toISOString() };
  if (typeof input.sessionId === "string" && input.sessionId) origin.sessionId = input.sessionId;
  if (typeof input.cwd === "string" && input.cwd) origin.cwd = input.cwd;
  ledger.items[key] = origin;
  evictOldest(ledger);

  try {
    const path = getMemoryOriginsPath();
    mkdirSync(dirname(path), { recursive: true });
    writePrivateFileAtomicSync(path, `${JSON.stringify(ledger, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** 查一条来源；未命中 = undefined（旧条目没记过，属正常） */
export function getMemoryOrigin(file: string, text: string): MemoryOrigin | undefined {
  if (typeof file !== "string" || typeof text !== "string") return undefined;
  return readLedger().items[memoryOriginKey(file, text)];
}
