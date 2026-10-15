import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";

/**
 * 会话元数据（收藏 ★ / 标签 # / 目标 ▸）。
 *
 * 摩擦：会话上到 40+ 之后，归类只能靠脑子 —— 「上周那个改 checkpoints 的会话
 * 叫什么来着」。收藏与标签是**用户自己贴的**少量结构化记号，用来在列表里筛。
 * 目标（goal）回答的则是另一个问题：**这个会话在干什么** —— 打开工作台一眼看到，
 * 不必点进去读上下文（模块 3 第 3 轮）。
 *
 * 边界：只存三样东西（fav / tags / goal），不碰会话文件本身，也不做排序权重；写入
 * 沿用家规（服务端校验 + 原子写 + 私有权限）。会话被删除时由删除链路同步清理
 * （`dropSessionMeta`），残留条目不参与任何判定，只是白占一行。
 *
 * 为什么存服务端而不是 localStorage：与 R2 模板同族 —— 多端入口共用同一份，
 * 换浏览器打开仍在；体积小（每条几十字节），不必担心文件膨胀。
 */

/** 单个会话最多 8 个标签 */
export const MAX_TAGS = 8;
/** 单个标签最长 12 字（中文按字符计） */
export const TAG_MAX_LENGTH = 12;
/** 会话目标最长 120 字（中文按字符计；够写清「在做什么」，又不至于变成第二份 prompt） */
export const GOAL_MAX_LENGTH = 120;

export interface SessionMeta {
  /** 收藏（true 才落盘；取消收藏即省略） */
  fav?: boolean;
  /** 标签（已规范化：trim / 去空 / 去重 / 保序） */
  tags?: string[];
  /** 当前目标（已 trim；空串不作为目标，等于没设） */
  goal?: string;
  /** 最后一次写入时间（ISO） */
  updatedAt: string;
}

interface StoredFile {
  version: 1;
  sessions: Record<string, SessionMeta>;
}

export function getSessionMetaPath(agentDir = getAgentDir()): string {
  return join(agentDir, "elenva-session-meta.json");
}

/**
 * 结构合法的条目才认：updatedAt 必填字符串，fav / tags / goal 类型正确。
 *
 * goal 的存在与否不参与合法性判定 —— 旧条目没有 goal 仍然合法（向后兼容）。
 * 读取层只要求它是字符串，不做长度/空串校验（校验只在写入路径把关，
 * 免得一条历史坏数据把整个条目连 fav / tags 一起丢弃）。
 */
function isValidEntry(value: unknown): value is SessionMeta {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as SessionMeta;
  if (typeof entry.updatedAt !== "string") return false;
  if (entry.fav !== undefined && typeof entry.fav !== "boolean") return false;
  if (entry.tags !== undefined) {
    if (!Array.isArray(entry.tags)) return false;
    if (!entry.tags.every((tag) => typeof tag === "string")) return false;
  }
  if (entry.goal !== undefined && typeof entry.goal !== "string") return false;
  return true;
}

/** 读失败 / 文件不存在 / 结构不合法 → 空表（不打扰），逐条丢弃坏条目 */
function readMetaFile(path: string): Record<string, SessionMeta> {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object") return {};
    const sessions = (parsed as { sessions?: unknown }).sessions;
    if (sessions === null || typeof sessions !== "object" || Array.isArray(sessions)) return {};
    const result: Record<string, SessionMeta> = {};
    for (const [id, entry] of Object.entries(sessions as Record<string, unknown>)) {
      if (!id || !isValidEntry(entry)) continue;
      result[id] = entry;
    }
    return result;
  } catch {
    return {};
  }
}

function writeMetaFile(sessions: Record<string, SessionMeta>, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const payload: StoredFile = { version: 1, sessions };
  writePrivateFileAtomicSync(path, JSON.stringify(payload, null, 2));
}

/** 全部会话元数据（sessionId → 条目）。读失败 → {} */
export function readSessionMeta(agentDir?: string): Record<string, SessionMeta> {
  return readMetaFile(getSessionMetaPath(agentDir));
}

/**
 * 标签规范化：trim → 去空 → 去重（大小写不敏感、保留原始大小写）→ 保序。
 * 超限直接报错（而不是静默截断）：用户敲了 9 个标签，应该知道为什么没存上。
 */
export function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) throw new Error("标签参数不合法");
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of tags) {
    if (typeof raw !== "string") throw new Error("标签参数不合法");
    const tag = raw.trim();
    if (!tag) continue;
    if (tag.length > TAG_MAX_LENGTH) throw new Error(`单个标签最长 ${TAG_MAX_LENGTH} 字`);
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(tag);
  }
  if (normalized.length > MAX_TAGS) throw new Error(`标签最多 ${MAX_TAGS} 个`);
  return normalized;
}

/**
 * 目标规范化：trim；空串 → undefined（视为删除该键，而不是存一个空目标）。
 * 超长直接报错（同标签口径：让用户知道为什么没存上，而不是静默截断）。
 */
export function normalizeGoal(value: unknown): string | undefined {
  if (typeof value !== "string") throw new Error("目标参数不合法");
  const goal = value.trim();
  if (!goal) return undefined;
  if (goal.length > GOAL_MAX_LENGTH) throw new Error(`目标最长 ${GOAL_MAX_LENGTH} 字`);
  return goal;
}

/**
 * 合并写入（patch 语义：只覆盖传了的字段）。
 * 合并后条目为空（无 fav、无 tags、无 goal）→ 直接删掉该 key，返回 null。
 * 返回合并后的条目（被删除时为 null）。
 *
 * goal 传空串等价于「删掉目标」：没有目标、没有其它记号时整条也随之删除。
 */
export function setSessionMeta(
  sessionId: string,
  patch: { fav?: boolean; tags?: string[]; goal?: string },
  agentDir?: string,
): SessionMeta | null {
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!id) throw new Error("缺少会话 id");
  if (patch.fav !== undefined && typeof patch.fav !== "boolean") throw new Error("收藏参数不合法");

  const path = getSessionMetaPath(agentDir);
  const sessions = readMetaFile(path);
  const prev = sessions[id];

  const fav = patch.fav !== undefined ? patch.fav : prev?.fav === true;
  const tags = patch.tags !== undefined ? normalizeTags(patch.tags) : prev?.tags ?? [];
  const goal = patch.goal !== undefined ? normalizeGoal(patch.goal) : prev?.goal;

  if (!fav && tags.length === 0 && !goal) {
    if (id in sessions) {
      delete sessions[id];
      writeMetaFile(sessions, path);
    }
    return null;
  }

  const entry: SessionMeta = {
    ...(fav ? { fav: true } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(goal ? { goal } : {}),
    updatedAt: new Date().toISOString(),
  };
  sessions[id] = entry;
  writeMetaFile(sessions, path);
  return entry;
}

/** 会话被删除时清掉它的元数据（失败不阻断删除本身） */
export function dropSessionMeta(sessionId: string, agentDir?: string): void {
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!id) return;
  try {
    const path = getSessionMetaPath(agentDir);
    const sessions = readMetaFile(path);
    if (!(id in sessions)) return;
    delete sessions[id];
    writeMetaFile(sessions, path);
  } catch {
    /* ignore：元数据清理不该让删会话失败 */
  }
}
