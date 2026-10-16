import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";

/**
 * 纠正收件箱的处理状态（ELENVA 自有存储，additive，不进 pi-hermes-memory 本体）。
 *
 * 为什么要有它：pi-hermes-memory 捕获的用户纠错只以条目正文落在记忆文件里
 * （failures.md 的 `[correction]` 条目），**没有「处理过没有」的任何状态**——看得到纠错，
 * 但分不清哪些已经升格成规则、哪些只是躺在那里。这个 sidecar 补上状态层：
 *
 *  - `pending`（缺省，不在文件里）= 待处理；
 *  - `promoted` = 已升格为记忆条目（记住规则正文 hash 作为稳定标识，供复发对照）；
 *  - `shelved` = 主动搁置（先不动它）；
 *  - `resolved` = 已处理（无需动作，如已在别处写过规则）。
 *
 * 存储：`<agentDir>/elenva-corrections-state.json`，`{ version: 1, items: { <纠正id>: … } }`。
 * 与 `lib/pending-memory.ts` 同款：目录缺失时新建、0600 原子写、文件损坏/结构非法一律按空表
 * （状态是尽力而为的旁路信息，不能因一个坏文件把收件箱拖垮）。
 *
 * 边界：**只写这份 sidecar**，不写记忆文件（升格写记忆走既有 `lib/agent-memory.ts` 的链）。
 */

export type CorrectionStatus = "promoted" | "shelved" | "resolved";

/** 状态取值域（顺序即 UI 展示顺序：已升格 → 已处理 → 已搁置） */
export const CORRECTION_STATUSES: readonly CorrectionStatus[] = ["promoted", "resolved", "shelved"];

export function isCorrectionStatus(value: unknown): value is CorrectionStatus {
  return typeof value === "string" && (CORRECTION_STATUSES as readonly string[]).includes(value);
}

export interface CorrectionState {
  status: CorrectionStatus;
  /** 状态最后更新时间（ISO） */
  at: string;
  /** 升格时：规则正文的 sha1（稳定标识，供复发对照） */
  ruleHash?: string;
  /** 升格时：规则本体（剥掉来源标注，相似度对照用这个） */
  ruleCore?: string;
  /** 升格时：实际写入记忆的完整正文 */
  ruleText?: string;
  /** 升格去向：memory | project/<项目名> */
  memoryFile?: string;
}

/** 状态条目上限：超出按 `at` 淘汰最旧（纠正条目本身还在记忆文件里，状态不是唯一记录） */
export const CORRECTIONS_STATE_LIMIT = 500;

const STATE_FILE = "elenva-corrections-state.json";

export function getCorrectionsStatePath(): string {
  return join(getAgentDir(), STATE_FILE);
}

function normalizeState(value: unknown): CorrectionState | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (!isCorrectionStatus(raw.status)) return null;
  if (typeof raw.at !== "string" || !raw.at.trim()) return null;
  const state: CorrectionState = { status: raw.status, at: raw.at };
  for (const key of ["ruleHash", "ruleCore", "ruleText", "memoryFile"] as const) {
    if (typeof raw[key] === "string" && (raw[key] as string).trim()) state[key] = raw[key] as string;
  }
  return state;
}

/** 读全表（文件缺失 / 损坏 / 结构非法 → 空对象，不抛） */
export function readCorrectionStates(): Record<string, CorrectionState> {
  let raw: string;
  try {
    raw = readFileSync(getCorrectionsStatePath(), "utf8");
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const items = (parsed as { items?: unknown }).items;
    if (typeof items !== "object" || items === null || Array.isArray(items)) return {};
    const clean: Record<string, CorrectionState> = {};
    for (const [id, value] of Object.entries(items as Record<string, unknown>)) {
      const state = normalizeState(value);
      if (state) clean[id] = state;
    }
    return clean;
  } catch {
    return {};
  }
}

export function getCorrectionState(id: string): CorrectionState | undefined {
  return readCorrectionStates()[id];
}

/** 上限淘汰：条目数超上限时，按 `at` 从旧到新删 */
function evictOldest(items: Record<string, CorrectionState>): void {
  const entries = Object.entries(items);
  if (entries.length <= CORRECTIONS_STATE_LIMIT) return;
  entries.sort((a, b) => Date.parse(a[1].at) - Date.parse(b[1].at));
  for (let i = 0; i < entries.length - CORRECTIONS_STATE_LIMIT; i += 1) delete items[entries[i][0]];
}

function writeStates(items: Record<string, CorrectionState>): void {
  const path = getCorrectionsStatePath();
  mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(path, `${JSON.stringify({ version: 1, items }, null, 2)}\n`);
}

/** 合并写一条状态（读-改-写）。patch 里未给的字段保留原值；缺 status 且原本没有 → 返回 null。 */
export function updateCorrectionState(
  id: string,
  patch: Partial<Omit<CorrectionState, "at">> & { at?: string },
): CorrectionState | null {
  if (typeof id !== "string" || !id.trim()) return null;
  if (patch.status !== undefined && !isCorrectionStatus(patch.status)) return null;

  const items = readCorrectionStates();
  const before = items[id];
  const status = patch.status ?? before?.status;
  if (!status) return null;

  const next: CorrectionState = {
    status,
    at: typeof patch.at === "string" && patch.at.trim() ? patch.at : new Date().toISOString(),
  };
  for (const key of ["ruleHash", "ruleCore", "ruleText", "memoryFile"] as const) {
    const value = patch[key] ?? before?.[key];
    if (typeof value === "string" && value.trim()) next[key] = value;
  }
  items[id] = next;
  evictOldest(items);
  writeStates(items);
  return next;
}

/** 删一条状态（收回件箱的「恢复待处理」）。存在且删除成功返回 true。 */
export function removeCorrectionState(id: string): boolean {
  const items = readCorrectionStates();
  if (!(id in items)) return false;
  delete items[id];
  writeStates(items);
  return true;
}
