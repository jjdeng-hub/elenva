/**
 * 本扩展自己的状态文件（**不碰 pi-hermes-memory 的任何文件**）：
 * 访问计数、冲突标注、整理记录。默认落在 `<agentRoot>/elenva-memory/state.json`。
 *
 * 为什么不写进记忆文件：pi-hermes-memory 的条目格式是锚定正则
 * （`^(text) <!-- created=…, last=… -->$`），塞第二段注释会破坏它的解析；
 * 而且它自己有 last_referenced 字段，我们没必要去改它的数据（升级即碎）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { agentRootDir, normalizeText, type StoreSet } from "./stores.js";

export interface AccessRecord {
  count: number;
  last: string;
}

export interface ConflictRecord {
  a: string;
  b: string;
  sim: number;
  reason: string;
  at: string;
}

export interface TidyMeta {
  lastRunAt?: string;
  lastSummary?: string;
  report?: string;
}

export interface EvidenceRecord {
  tool: string;
  at: string;
  cwd?: string;
}

export interface ElenvaMemoryState {
  version: 1;
  access: Record<string, AccessRecord>;
  conflicts: ConflictRecord[];
  /** 写入留痕（ch3 L505 的「从哪条证据而来」）：条目 id → 哪次工具调用写下的 */
  evidence?: Record<string, EvidenceRecord>;
  /** 记忆类工具各被调用了多少次（自查用：确认模型真的在检索而不是凭摘要猜） */
  toolCalls?: Record<string, number>;
  tidy?: TidyMeta;
}

const EMPTY_STATE: ElenvaMemoryState = { version: 1, access: {}, conflicts: [], evidence: {}, toolCalls: {} };

export function stateDirFor(agentRoot = agentRootDir()): string {
  return path.join(agentRoot, "elenva-memory");
}

export function stateFileFor(agentRoot = agentRootDir()): string {
  return path.join(stateDirFor(agentRoot), "state.json");
}

let current: ElenvaMemoryState | null = null;

export function loadState(agentRoot = agentRootDir()): ElenvaMemoryState {
  if (current) return current;
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFileFor(agentRoot), "utf8")) as Partial<ElenvaMemoryState>;
    current = {
      version: 1,
      access: parsed.access && typeof parsed.access === "object" ? parsed.access : {},
      conflicts: Array.isArray(parsed.conflicts) ? parsed.conflicts : [],
      evidence: parsed.evidence && typeof parsed.evidence === "object" ? parsed.evidence : {},
      toolCalls: parsed.toolCalls && typeof parsed.toolCalls === "object" ? parsed.toolCalls : {},
      ...(parsed.tidy ? { tidy: parsed.tidy } : {}),
    };
  } catch {
    current = structuredClone(EMPTY_STATE);
  }
  return current;
}

export function saveState(state: ElenvaMemoryState = loadState(), agentRoot = agentRootDir()): void {
  const dir = stateDirFor(agentRoot);
  fs.mkdirSync(dir, { recursive: true });
  const file = stateFileFor(agentRoot);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, file);
  current = state;
}

/** 测试用：丢掉内存里的缓存。 */
export function resetStateCache(): void {
  current = null;
}

/** 一次检索结果里命中了哪些条目（返回命中条目数）。 */
export function recordAccess(stores: StoreSet, resultText: string, state = loadState()): number {
  const normalizedResult = normalizeText(resultText);
  const today = new Date().toISOString().slice(0, 10);
  let touched = 0;
  for (const store of stores.stores) {
    for (const entry of store.entries) {
      const needle = normalizeText(entry.text).slice(0, 48);
      if (needle.length < 8) continue;
      if (!normalizedResult.includes(needle)) continue;
      const record = state.access[entry.id] ?? { count: 0, last: today };
      record.count += 1;
      record.last = today;
      state.access[entry.id] = record;
      touched += 1;
    }
  }
  return touched;
}

export function accessCount(state: ElenvaMemoryState, id: string): number {
  return state.access[id]?.count ?? 0;
}

/**
 * 写入留痕：把「刚写进去的内容」对回条目，记下工具名与时间。
 * 依据 ch3 L505：每条知识都应能回答「从哪条证据而来」。
 *
 * 注意：这个内容来自**工具入参**（`tool_call` / `tool_result` 的 input），不是工具返回值 ——
 * pi-hermes-memory 的 memory_add 只回「Entry added.」，不回显内容（实测踩过）。
 */
export function recordEvidence(
  stores: StoreSet,
  tool: string,
  content: string,
  cwd: string,
  state = loadState(),
): number {
  const needle = normalizeText(content).slice(0, 40);
  if (needle.length < 6) return 0;
  const at = new Date().toISOString();
  state.evidence ??= {};
  let touched = 0;
  for (const store of stores.stores) {
    for (const entry of store.entries) {
      const normalized = normalizeText(entry.text);
      if (!normalized.includes(needle)) continue;
      const previous = state.evidence[entry.id];
      if (previous && previous.tool === tool && previous.at.slice(0, 10) === at.slice(0, 10)) continue;
      state.evidence[entry.id] = { tool, at, ...(cwd ? { cwd } : {}) };
      touched += 1;
    }
  }
  return touched;
}

/** 与某条目疑似冲突的其它条目 id（供索引与检索工具标注）。 */
export function conflictPartnersOf(state: ElenvaMemoryState, id: string): string[] {
  const partners = new Set<string>();
  for (const conflict of state.conflicts) {
    if (conflict.a === id) partners.add(conflict.b);
    if (conflict.b === id) partners.add(conflict.a);
  }
  return [...partners];
}

/** 统计记忆类工具的调用次数（与访问计数分离：这是「行为」信号，不是「内容」信号）。 */
export function recordToolCall(tool: string, state = loadState()): void {
  state.toolCalls ??= {};
  state.toolCalls[tool] = (state.toolCalls[tool] ?? 0) + 1;
}
