/**
 * 模型备注（模块 6 · 第 4 轮）—— 给每个模型留一条自由文本（擅长什么 / 贵不贵）。
 *
 * 为什么需要：人肉路由全凭记忆——同一个任务该派给哪个模型、哪个便宜到可以随便试、
 * 哪个擅长长上下文，这些判断现在散在脑子里和聊天记录里，换台机器就没了。
 * 这里只做一件事：把「一句话备注」落到本地，并让它出现在**选型路径上**
 * （模型页每行 + 选择器菜单行），而不是藏在某个详情页里。
 *
 * 分层（同 model-review / budget-guard 的约定）：
 *  · 上半是**纯函数区**：归一 / 校验 / 解析 / 增删，无 `node:*`、无副作用，自测可直载。
 *    **客户端只应 `import type`**——本文件下半有 node:fs，运行时导入会把文件系统带进浏览器包。
 *  · 下半是 **IO 区**：`<agentDir>/elenva-model-notes.json`，0600 原子写、损坏容错。
 *
 * 存储形状（键 = `provider/modelId`，与界面的 ref 口径一致）：
 *   { "demo-provider/demo-model": { "note": "擅长长上下文，贵", "updatedAt": "2026-…Z" } }
 */

/** 单条备注上限（按码点计，中文一字算一个）。 */
export const MAX_NOTE_LENGTH = 200;
/** 选择器菜单行里的展示上限：菜单只有一行位置，超出截断。 */
export const NOTE_DISPLAY_MAX = 60;

export interface ModelNote {
  note: string;
  /** 末次写入时间（ISO）；清除即删键，不留空壳 */
  updatedAt: string;
}

/** 备注表：键 = `provider/modelId`。 */
export type ModelNoteMap = Record<string, ModelNote>;

/** 模型引用 → 存储键（与界面 ModelPicker / 模型库的 ref 口径同一套）。 */
export function noteKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

/** 按码点计长度，避免代理对被当成两个字。 */
export function noteLength(note: string): number {
  return Array.from(note).length;
}

/**
 * 归一：折叠换行 / 连续空白为单空格并去首尾。
 * 备注是「一行小字」，多行输入只会把行高撑坏，所以在这里收平。
 * 空串 = 清除信号，调用方据此走删除分支。
 */
export function normalizeNote(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/** 按码点上限截断（超出加省略号），用于菜单行展示；不改存储。 */
export function truncateNote(note: string, max = NOTE_DISPLAY_MAX): string {
  const chars = Array.from(note);
  if (chars.length <= max) return note;
  return `${chars.slice(0, Math.max(0, max - 1)).join("").trimEnd()}…`;
}

/**
 * 输入校验：合法返回 { ok: true, note }（已归一；空串表示清除），
 * 非法返回原因。长度按归一后的码点数计——先折叠再去数，避免多打几个空格就超限。
 */
export function validateNote(raw: unknown): { ok: true; note: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "备注必须是字符串" };
  const note = normalizeNote(raw);
  if (noteLength(note) > MAX_NOTE_LENGTH) {
    return { ok: false, error: `备注最多 ${MAX_NOTE_LENGTH} 字（当前 ${noteLength(note)} 字）` };
  }
  return { ok: true, note };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** 读盘归一：只收形状完整的条目，其余静默丢弃；键必须是非空字符串。 */
export function parseModelNotes(raw: unknown): ModelNoteMap {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: ModelNoteMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isNonEmptyString(key)) continue;
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (typeof record.note !== "string") continue;
    const note = normalizeNote(record.note);
    if (!note) continue;
    out[key] = {
      note,
      updatedAt: isNonEmptyString(record.updatedAt) ? record.updatedAt : new Date(0).toISOString(),
    };
  }
  return out;
}

/** 设一条备注（纯函数，返回新表、不改入参）；note 为空串时等同清除。 */
export function setNote(
  map: ModelNoteMap,
  provider: string,
  modelId: string,
  note: string,
  updatedAt = new Date().toISOString(),
): ModelNoteMap {
  const key = noteKey(provider, modelId);
  const next = { ...map };
  const normalized = normalizeNote(note);
  if (!normalized) {
    delete next[key];
    return next;
  }
  next[key] = { note: normalized, updatedAt };
  return next;
}

/** 清除一条备注（纯函数）；键不存在时原样返回。 */
export function clearNote(map: ModelNoteMap, provider: string, modelId: string): ModelNoteMap {
  const key = noteKey(provider, modelId);
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

/** 取一条备注（找不到返回 null），供服务端 / 自测用。 */
export function getNote(map: ModelNoteMap, provider: string, modelId: string): ModelNote | null {
  return map[noteKey(provider, modelId)] ?? null;
}

// ============================================================================
// IO 区（服务端专用）
// ============================================================================

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";

export function getModelNotesPath(agentDir = getAgentDir()): string {
  return join(agentDir, "elenva-model-notes.json");
}

/** 读盘容错：文件缺失 / 损坏 / 形状不对一律当空表，不让界面因一条坏记录打不开。 */
export function readModelNotes(agentDir?: string): ModelNoteMap {
  const path = getModelNotesPath(agentDir);
  if (!existsSync(path)) return {};
  try {
    return parseModelNotes(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return {};
  }
}

export function writeModelNotes(notes: ModelNoteMap, agentDir?: string): void {
  const path = getModelNotesPath(agentDir);
  mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(path, `${JSON.stringify(notes, null, 2)}\n`);
}

/**
 * 落一条备注；返回落库后的那条（清除时返回 null）。
 * 空串 = 清除：删除键而不是写空字符串，读侧就不用再判「空备注」。
 */
export function saveModelNote(
  provider: string,
  modelId: string,
  note: string,
  agentDir?: string,
): ModelNote | null {
  const current = readModelNotes(agentDir);
  const next = setNote(current, provider, modelId, note);
  writeModelNotes(next, agentDir);
  return getNote(next, provider, modelId);
}
