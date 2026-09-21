import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getPiSettingsPath } from "./pi-user-settings";

/**
 * Agent 记忆（pi-hermes-memory 扩展的落盘目录）只读读取。
 *
 * 布局（Hermes 风格：有界 + 分层，见 ~/.pi/agent/hermes-memory-config.json）：
 *  - <记忆目录>/USER.md       用户画像（关于你：偏好、习惯、沟通风格）
 *  - <记忆目录>/MEMORY.md     跨项目的事实与教训
 *  - <记忆目录>/failures.md   失败记忆（什么没走通、为什么）
 *  - <项目记忆目录>/<项目>/MEMORY.md   项目级记忆
 *  - <记忆目录>/sessions.db   历史会话全文索引（本页不展示）
 *
 * 目录解析优先级：PI_HERMES_MEMORY_DIR 环境变量 → 配置文件的 memoryDir → 默认目录。
 * 与 lib/context-files.ts 是两个体系，别混：那边是用户手写的长期指令（AGENTS.md / SYSTEM.md）。
 */

/** 单个文件读取上限：超出部分截断，避免超大文件整段塞进响应 */
export const MAX_MEMORY_FILE_BYTES = 512 * 1024;

export type AgentMemoryKind = "user" | "memory" | "failures" | "project";

export interface AgentMemoryFile {
  /** user | memory | failures | project/<项目名> */
  id: string;
  /** 展示名：USER.md / MEMORY.md / failures.md / <项目>/MEMORY.md */
  label: string;
  kind: AgentMemoryKind;
  path: string;
  exists: boolean;
  size: number;
  /** ISO 时间；文件不存在时为 null */
  modified: string | null;
}

export interface AgentMemoryIndex {
  dir: string;
  /** 项目级记忆的根目录（<agentDir>/projects-memory） */
  projectsDir: string;
  dirExists: boolean;
  /** 本机 pi 用户设置（~/.pi/agent/settings.json）的 packages 里有没有 pi-hermes-memory */
  installed: boolean;
  files: AgentMemoryFile[];
}

const FIXED_FILES: { id: string; label: string; kind: AgentMemoryKind; file: string }[] = [
  { id: "user", label: "USER.md", kind: "user", file: "USER.md" },
  { id: "memory", label: "MEMORY.md", kind: "memory", file: "MEMORY.md" },
  { id: "failures", label: "failures.md", kind: "failures", file: "failures.md" },
];

const PROJECT_PREFIX = "project/";

export interface HermesMemoryConfig {
  memoryDir?: unknown;
  projectsMemoryDir?: unknown;
  memoryCharLimit?: unknown;
  userCharLimit?: unknown;
  projectCharLimit?: unknown;
}

function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) return join(homedir(), input.slice(2));
  return input;
}

/** 读 ~/.pi/agent/hermes-memory-config.json（缺失/损坏时返回空对象，不抛） */
export function readHermesMemoryConfig(): HermesMemoryConfig {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(getAgentDir(), "hermes-memory-config.json"), "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as HermesMemoryConfig) : {};
  } catch {
    return {};
  }
}

/** 记忆根目录：与扩展 loadConfig() 的 normalizeConfiguredMemoryDir 同口径 */
export function getHermesMemoryDir(): string {
  const env = process.env.PI_HERMES_MEMORY_DIR?.trim();
  if (env) return resolve(expandHome(env));
  const configured = readHermesMemoryConfig().memoryDir;
  if (typeof configured === "string" && configured.trim()) {
    const expanded = expandHome(configured.trim());
    return isAbsolute(expanded) ? normalize(expanded) : resolve(getAgentDir(), expanded);
  }
  return join(getAgentDir(), "pi-hermes-memory");
}

/** 项目记忆根目录：与扩展的 normalizeProjectsMemoryDir 同口径（只接受单层目录名） */
export function getHermesProjectsDir(): string {
  const configured = readHermesMemoryConfig().projectsMemoryDir;
  if (typeof configured === "string") {
    const trimmed = configured.trim();
    const safe = trimmed
      && !trimmed.includes("/")
      && !trimmed.includes("\\")
      && trimmed !== "."
      && trimmed !== "..";
    if (safe) return join(getAgentDir(), trimmed);
  }
  return join(getAgentDir(), "projects-memory");
}

/** 项目名：单层目录名，且解析后必须仍落在项目记忆根目录内（防路径穿越） */
function resolveProjectDir(name: string): string | null {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) return null;
  const root = getHermesProjectsDir();
  const dir = resolve(root, name);
  if (dir !== join(root, name) || !dir.startsWith(root + sep)) return null;
  return dir;
}

/** 是否是合法的记忆文件标识（project/<项目名> 只接受单层安全目录名） */
export function isAgentMemoryFileId(id: unknown): id is string {
  if (typeof id !== "string") return false;
  if (FIXED_FILES.some((f) => f.id === id)) return true;
  if (!id.startsWith(PROJECT_PREFIX)) return false;
  return resolveProjectDir(id.slice(PROJECT_PREFIX.length)) !== null;
}

/** 标识 → 绝对路径。id 必须先过 isAgentMemoryFileId，否则抛错（防路径穿越） */
export function resolveAgentMemoryFilePath(id: string): string {
  const fixed = FIXED_FILES.find((f) => f.id === id);
  if (fixed) return join(getHermesMemoryDir(), fixed.file);
  if (id.startsWith(PROJECT_PREFIX)) {
    const dir = resolveProjectDir(id.slice(PROJECT_PREFIX.length));
    if (dir) return join(dir, "MEMORY.md");
  }
  throw new Error(`未知记忆文件标识：${id}`);
}

function fileMeta(id: string, label: string, kind: AgentMemoryKind, path: string): AgentMemoryFile {
  try {
    const s = statSync(path);
    if (!s.isFile()) throw new Error("not a file");
    return { id, label, kind, path, exists: true, size: s.size, modified: s.mtime.toISOString() };
  } catch {
    return { id, label, kind, path, exists: false, size: 0, modified: null };
  }
}

/** ~/.pi/agent/settings.json 的 packages 里是否挂了 pi-hermes-memory（含 npm:/本地路径/带版本） */
export function isPiHermesMemoryConfigured(): boolean {
  const settingsPath = getPiSettingsPath();
  if (!existsSync(settingsPath)) return false;
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    const packages = (parsed as { packages?: unknown } | null)?.packages;
    if (!Array.isArray(packages)) return false;
    return packages.some((p) => typeof p === "string" && /(?:^|[\\/:])pi-hermes-memory(?:$|[@\\/])/.test(p));
  } catch {
    return false;
  }
}

/** 记忆文件清单：固定三项（画像 / 长期 / 失败）+ 有内容的项目记忆 */
export function listAgentMemoryFiles(): AgentMemoryIndex {
  const dir = getHermesMemoryDir();
  const projectsDir = getHermesProjectsDir();
  const files = FIXED_FILES.map((f) => fileMeta(f.id, f.label, f.kind, join(dir, f.file)));

  let names: string[] = [];
  try {
    names = readdirSync(projectsDir);
  } catch {
    // 目录不存在 = 还没有项目级记忆，不是错误
  }
  const projects = names
    .filter((n) => resolveProjectDir(n) !== null)
    .sort((a, b) => a.localeCompare(b, "zh"))
    .map((n) => fileMeta(`${PROJECT_PREFIX}${n}`, n, "project", join(projectsDir, n, "MEMORY.md")))
    .filter((f) => f.exists);

  return {
    dir,
    projectsDir,
    dirExists: existsSync(dir),
    installed: isPiHermesMemoryConfigured(),
    files: [...files, ...projects],
  };
}

export interface AgentMemoryFileContent {
  file: AgentMemoryFile;
  content: string;
  /** 内容超过 MAX_MEMORY_FILE_BYTES 时为 true，content 只含前 512KB */
  truncated: boolean;
}

export function readAgentMemoryFile(id: string): AgentMemoryFileContent {
  const fixed = FIXED_FILES.find((f) => f.id === id);
  const label = fixed?.label ?? id.slice(PROJECT_PREFIX.length);
  const kind: AgentMemoryKind = fixed?.kind ?? "project";
  const file = fileMeta(id, label, kind, resolveAgentMemoryFilePath(id));
  if (!file.exists) return { file, content: "", truncated: false };
  const raw = readFileSync(file.path);
  const truncated = raw.byteLength > MAX_MEMORY_FILE_BYTES;
  // 条目尾部的 <!-- created=…, last=… --> 是扩展自己写的元数据（在 markdown 里不可见），
  // 这里是纯文本渲染，留着只是噪声 —— 展示时剥掉，磁盘上的原文件不动。
  const content = raw
    .subarray(0, MAX_MEMORY_FILE_BYTES)
    .toString("utf8")
    .replace(/\s*<!--\s*created=[^>]*-->/g, "");
  return { file, content, truncated };
}

/* ========================== 编辑（网页端写入） ==========================
 * 写入契约（与 pi-hermes-memory / elenva-memory 的文件格式一致）：
 *  - 条目之间 `\n§\n` 分隔，条目尾部 `<!-- created=…, last=… -->` 元数据注释；
 *  - 配额与扩展同口径（配置文件的三个上限；failures 无独立项，按 memoryCharLimit × 2）；
 *  - 写入前先备份、原子落盘、并做并发校验（revision = 磁盘原文的内容哈希）。
 * 对账：SQLite 检索镜像是派生数据，扩展在**会话启动**时会自动对齐（migrateThenSyncMarkdownMemories）；
 *      常驻索引（elenva-memory）每轮直读文件，保存后下一轮就是最新的。
 */

/** 记忆配额（字符）—— 与 extensions/elenva-memory/stores.ts 的读取口径一致 */
export interface HermesMemoryLimits {
  memory: number;
  user: number;
  project: number;
  failure: number;
}

export function getHermesMemoryLimits(): HermesMemoryLimits {
  const cfg = readHermesMemoryConfig() as Record<string, unknown>;
  const num = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  const memory = num(cfg.memoryCharLimit, 4000);
  return {
    memory,
    user: num(cfg.userCharLimit, 2500),
    project: num(cfg.projectCharLimit, 3000),
    failure: memory * 2,
  };
}

export function limitForMemoryKind(kind: AgentMemoryKind): number {
  const limits = getHermesMemoryLimits();
  if (kind === "user") return limits.user;
  if (kind === "project") return limits.project;
  if (kind === "failures") return limits.failure;
  return limits.memory;
}

/** 一条记忆（正文 + 尾部元数据） */
export interface AgentMemoryEntry {
  text: string;
  created: string | null;
  last: string | null;
}

const ENTRY_DELIMITER = "\n§\n";
const ENTRY_META_PATTERN =
  /^([\s\S]*?)\s*<!--\s*created=([^,]+),\s*last=([^,>]+)(?:,\s*project64=[A-Za-z0-9_-]+)?\s*-->\s*$/;

export function parseMemoryEntries(raw: string): AgentMemoryEntry[] {
  return raw
    .split(ENTRY_DELIMITER)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const match = ENTRY_META_PATTERN.exec(chunk);
      if (!match) return { text: chunk.trim(), created: null, last: null };
      return { text: match[1].trim(), created: match[2].trim(), last: match[3].trim() };
    })
    .filter((entry) => entry.text.length > 0);
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 序列化条目（不做配额校验，调用方自己比 limit）。
 * `previous` 里能找到的条目视为**未改动**，保留原 last —— 否则一次普通保存会把所有条目刷成今天，
 * 而 last 参与重要性的时间衰减评分。
 */
export function serializeMemoryEntries(entries: AgentMemoryEntry[], previous: AgentMemoryEntry[] = []): string {
  const known = new Map(previous.map((entry) => [entry.text.trim(), entry]));
  return entries
    .map((entry) => {
      const text = entry.text.trim();
      const before = known.get(text);
      const created = entry.created?.trim() || before?.created?.trim() || todayStamp();
      const last = before ? before.last?.trim() || todayStamp() : todayStamp();
      return `${text} <!-- created=${created}, last=${last} -->`;
    })
    .join(ENTRY_DELIMITER);
}

function hashText(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex").slice(0, 12);
}

export interface AgentMemorySnapshot {
  file: AgentMemoryFile;
  /** 磁盘原文（含元数据注释） */
  raw: string;
  entries: AgentMemoryEntry[];
  /** 内容哈希；写入时用于并发校验 */
  revision: string;
  chars: number;
  limit: number;
}

/** 读一份记忆的完整快照（原始文本 + 结构化条目 + 版本 + 配额），供编辑用 */
export function readAgentMemorySnapshot(id: string): AgentMemorySnapshot {
  const path = resolveAgentMemoryFilePath(id);
  const fixed = FIXED_FILES.find((f) => f.id === id);
  const label = fixed?.label ?? id.slice(PROJECT_PREFIX.length);
  const kind: AgentMemoryKind = fixed?.kind ?? "project";
  const file = fileMeta(id, label, kind, path);
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    raw = "";
  }
  return {
    file,
    raw,
    entries: parseMemoryEntries(raw),
    revision: hashText(raw),
    chars: raw.length,
    limit: limitForMemoryKind(kind),
  };
}

export interface AgentMemoryWriteInput {
  entries: AgentMemoryEntry[];
  /** 客户端读到的 revision；传了且不一致 → 判定为并发冲突 */
  revision?: string;
}

export type AgentMemoryWriteResult =
  | {
      ok: true;
      file: AgentMemoryFile;
      entries: AgentMemoryEntry[];
      chars: number;
      limit: number;
      revision: string;
      /** 写入前的备份文件路径（无原文件时为 null） */
      backup: string | null;
    }
  | {
      ok: false;
      code: "unknown-file" | "conflict" | "over-limit" | "invalid";
      error: string;
      chars?: number;
      limit?: number;
    };

/** 单条长度上限（防御性；正常记忆一条几十到几百字符） */
const MAX_ENTRY_CHARS = 20_000;

function backupMemoryFile(file: AgentMemoryFile, raw: string): string | null {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const dir = join(getAgentDir(), "backups", `memory-ui-${stamp}`);
    mkdirSync(dir, { recursive: true });
    const target = join(dir, file.label.replace(/[\\/]/g, "_"));
    writeFileSync(target, raw, "utf8");
    return target;
  } catch {
    return null;
  }
}

function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

/**
 * 网页端保存一份记忆（整份条目替换）。
 * 顺序：并发校验 → 条目清洗 → 配额校验 → 备份（失败即中止）→ 原子写。
 */
export function writeAgentMemoryFile(id: string, input: AgentMemoryWriteInput): AgentMemoryWriteResult {
  if (!isAgentMemoryFileId(id)) return { ok: false, code: "unknown-file", error: `未知记忆文件标识：${id}` };
  const snapshot = readAgentMemorySnapshot(id);

  if (typeof input.revision === "string" && input.revision !== snapshot.revision) {
    return {
      ok: false,
      code: "conflict",
      error: "文件刚被改动过（可能是会话里的新记忆写入），请刷新后再编辑",
    };
  }
  if (!Array.isArray(input.entries)) return { ok: false, code: "invalid", error: "entries 必须是数组" };

  const clean: AgentMemoryEntry[] = [];
  for (const raw of input.entries) {
    if (!raw || typeof raw.text !== "string") return { ok: false, code: "invalid", error: "有条目缺少文本" };
    const text = raw.text.trim();
    if (!text) continue; // 清空 = 删除该条
    if (text.length > MAX_ENTRY_CHARS) {
      return { ok: false, code: "invalid", error: `单条过长（${text.length} 字符上限 ${MAX_ENTRY_CHARS}），请拆分` };
    }
    clean.push({
      text,
      created: typeof raw.created === "string" ? raw.created : null,
      last: typeof raw.last === "string" ? raw.last : null,
    });
  }

  const next = serializeMemoryEntries(clean, snapshot.entries);
  if (next.length > snapshot.limit) {
    return {
      ok: false,
      code: "over-limit",
      chars: next.length,
      limit: snapshot.limit,
      error: `超出配额：${next.length} / ${snapshot.limit} 字符（满额时扩展会硬拒写入）。请先合并或删除一些条目。`,
    };
  }

  let backup: string | null = null;
  if (snapshot.file.exists && snapshot.raw) {
    backup = backupMemoryFile(snapshot.file, snapshot.raw);
    if (!backup) return { ok: false, code: "invalid", error: "备份失败，出于安全未写入磁盘" };
  }

  writeFileAtomic(snapshot.file.path, next);

  const after = readAgentMemorySnapshot(id);
  return {
    ok: true,
    file: after.file,
    entries: after.entries,
    chars: after.chars,
    limit: after.limit,
    revision: after.revision,
    backup,
  };
}
