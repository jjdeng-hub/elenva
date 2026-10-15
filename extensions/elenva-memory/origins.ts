/**
 * 记忆来源账本（扩展侧的最小写入实现）。
 *
 * 为什么扩展要自己实现一份：扩展是**复制**到 `<agentRoot>/extensions/` 的副本
 * （见 install.mjs），加载时读不到仓库里的 `lib/memory-origins.ts`。这与 stores.ts
 * 「按文件契约独立读记忆文件」是同一个取舍：两边只共享**磁盘格式**，不共享代码。
 *
 * 与 `lib/memory-origins.ts` 的契约（改一处必须同步另一处）：
 * - 文件：`<agentRoot>/elenva-memory-origins.json`，`{ version: 1, items: {…} }`；
 * - 键：`fileId + "\u0000" + sha1(正文剥掉尾部 <!-- created=… --> 注释后 trim)`；
 * - 值：`{ via, at, sessionId?, cwd? }`，via ∈ agent | web-edit | remember | pending；
 * - 上限 800 条，超出按 `at` 淘汰最旧；读损坏 → 空表；写失败不抛（旁路信息）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { agentRootDir } from "./stores.js";

export type MemoryOriginVia = "agent" | "web-edit" | "remember" | "pending";

export const MEMORY_ORIGIN_VIAS: readonly MemoryOriginVia[] = ["agent", "web-edit", "remember", "pending"];

export interface MemoryOrigin {
  via: MemoryOriginVia;
  /** ISO 时间 */
  at: string;
  sessionId?: string;
  cwd?: string;
}

export const MEMORY_ORIGINS_LIMIT = 800;

export function memoryOriginsPath(agentRoot = agentRootDir()): string {
  return path.join(agentRoot, "elenva-memory-origins.json");
}

export function isMemoryOriginVia(value: unknown): value is MemoryOriginVia {
  return typeof value === "string" && (MEMORY_ORIGIN_VIAS as readonly string[]).includes(value);
}

export function normalizeOriginEntryText(text: string): string {
  return text.replace(/\s*<!--\s*created=[^>]*-->\s*$/, "").trim();
}

function sha1(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex");
}

export function memoryOriginKey(file: string, text: string): string {
  return `${file}\u0000${sha1(normalizeOriginEntryText(text))}`;
}

interface OriginsLedger {
  version: 1;
  items: Record<string, MemoryOrigin>;
}

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

function readLedger(file: string): OriginsLedger {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { version: 1, items: {} };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { version: 1, items: {} };
    const items = (parsed as { items?: unknown }).items;
    if (typeof items !== "object" || items === null || Array.isArray(items)) {
      return { version: 1, items: {} };
    }
    const clean: Record<string, MemoryOrigin> = {};
    for (const [key, value] of Object.entries(items as Record<string, unknown>)) {
      const origin = normalizeOrigin(value);
      if (origin) clean[key] = origin;
    }
    return { version: 1, items: clean };
  } catch {
    return { version: 1, items: {} };
  }
}

function evictOldest(ledger: OriginsLedger): void {
  const entries = Object.entries(ledger.items);
  if (entries.length <= MEMORY_ORIGINS_LIMIT) return;
  entries.sort((a, b) => Date.parse(a[1].at) - Date.parse(b[1].at));
  const removeCount = entries.length - MEMORY_ORIGINS_LIMIT;
  for (let i = 0; i < removeCount; i += 1) delete ledger.items[entries[i][0]];
}

export interface RecordMemoryOriginInput {
  file: string;
  text: string;
  via: MemoryOriginVia;
  sessionId?: string | null;
  cwd?: string | null;
}

/**
 * 记一条来源（读-改-写，后写胜）。返回是否成功落盘；不抛。
 * 排查用 `/memory-tidy` 旁边的日志：这里的失败是静默的（旁路信息，不能拖垮主流程）。
 */
export function recordMemoryOrigin(input: RecordMemoryOriginInput, agentRoot = agentRootDir()): boolean {
  if (!input || !isMemoryOriginVia(input.via)) return false;
  if (typeof input.file !== "string" || !input.file.trim()) return false;
  if (typeof input.text !== "string") return false;

  const ledger = readLedger(memoryOriginsPath(agentRoot));
  const origin: MemoryOrigin = { via: input.via, at: new Date().toISOString() };
  if (typeof input.sessionId === "string" && input.sessionId) origin.sessionId = input.sessionId;
  if (typeof input.cwd === "string" && input.cwd) origin.cwd = input.cwd;
  ledger.items[memoryOriginKey(input.file, input.text)] = origin;
  evictOldest(ledger);

  try {
    const target = memoryOriginsPath(agentRoot);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
}

/** 查一条来源；未命中 = undefined */
export function getMemoryOrigin(file: string, text: string, agentRoot = agentRootDir()): MemoryOrigin | undefined {
  if (typeof file !== "string" || typeof text !== "string") return undefined;
  return readLedger(memoryOriginsPath(agentRoot)).items[memoryOriginKey(file, text)];
}
