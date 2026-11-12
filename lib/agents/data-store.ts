/**
 * Agent 数据文件读写（仅服务端）。
 *
 * 这是「人也能改 Agent 的数据」的那一半：读走 `readAgentFile`，写走 `writeAgentFile`。
 * 边界（与 `panels-server.ts` 同口径，再补三条写入门槛）：
 * - 路径必须落在应用包目录内（先字符串判，再 realpath 判，防符号链接逃逸）；
 * - 只允许 `.json` / `.md`，单文件 ≤ 256KB —— 数据文件不是日志，不该无限长；
 * - 写入必须先拿到当前 `revision`（内容 sha256 前 16 位）：Agent 刚写完、界面还开着旧值，
 *   这时覆盖会把它的改动抹掉。宁可回 409 让人刷新一次。
 *
 * 每次写入都留备份（`.backup/<原名>.<时间戳>`，滚动 20 份）与一行变更记录
 * （`.changes.jsonl`）—— 书里把「共享文件系统的并发冲突」列为多 Agent 首要失败模式，
 * 这两样是人事后能对齐的唯一线索。
 */

import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { writePrivateFileAtomicSync } from "../atomic-file";

const MAX_BYTES = 256 * 1024;
const MAX_BACKUPS = 20;
const ALLOWED_EXT = new Set([".json", ".md"]);
const CHANGE_LOG_MAX_BYTES = 256 * 1024;
const CHANGE_LOG_KEEP_LINES = 200;

export interface FileRead {
  ok: true;
  path: string;
  content: string;
  revision: string;
  size: number;
}

export interface FileFailure {
  ok: false;
  status: number;
  error: string;
}

export type FileResult = FileRead | FileFailure;

export function revisionOf(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

/** candidate 是否落在 root 之内（root 自身算之内）。 */
export function isInsideDir(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * 把「相对应用包根目录的路径」解成绝对路径，并做越界判定。
 * 目标尚未存在时判父目录，存在时再按 realpath 判一次（防软链接）。
 */
export function resolveInside(root: string, relPath: string): { ok: true; path: string } | FileFailure {
  if (!relPath || relPath.length > 200) return { ok: false, status: 400, error: "路径为空或过长" };
  if (/[\u0000-\u001f]/.test(relPath)) return { ok: false, status: 400, error: "路径含控制字符" };
  if (isAbsolute(relPath) || /^[a-zA-Z]:[\\/]/.test(relPath)) {
    return { ok: false, status: 400, error: "只接受相对应用包目录的路径" };
  }
  if (relPath.split(/[\\/]/).some((part) => part === "..")) {
    return { ok: false, status: 400, error: "路径不能包含 .." };
  }
  if (!ALLOWED_EXT.has(extname(relPath).toLowerCase())) {
    return { ok: false, status: 400, error: "只允许读写 .json / .md" };
  }

  const absRoot = resolve(root);
  const target = resolve(absRoot, relPath);
  if (!isInsideDir(absRoot, target) || target === absRoot) {
    return { ok: false, status: 400, error: "路径越出应用包目录" };
  }

  try {
    const realRoot = realpathSync(absRoot);
    const existingDir = existsSync(target) ? dirname(target) : dirname(target);
    const realParent = existsSync(existingDir) ? realpathSync(existingDir) : existingDir;
    if (!isInsideDir(realRoot, resolve(realParent, basename(target)))) {
      return { ok: false, status: 400, error: "路径越出应用包目录（软链接）" };
    }
  } catch (error) {
    return { ok: false, status: 400, error: `路径不可解析：${String(error)}` };
  }

  return { ok: true, path: target };
}

export function readAgentFile(root: string, relPath: string): FileResult {
  const resolved = resolveInside(root, relPath);
  if (!resolved.ok) return resolved;
  try {
    if (!existsSync(resolved.path)) return { ok: false, status: 404, error: "文件不存在" };
    const size = statSync(resolved.path).size;
    if (size > MAX_BYTES) return { ok: false, status: 413, error: `文件超过 ${MAX_BYTES / 1024}KB` };
    const content = readFileSync(resolved.path, "utf8");
    return { ok: true, path: relPath, content, revision: revisionOf(content), size };
  } catch (error) {
    return { ok: false, status: 500, error: String(error) };
  }
}

export interface WriteOptions {
  /** 调用方读到的 revision；不一致即 409。新建文件传 "" */
  expectedRevision?: string;
  /** 写前由调用方按契约校验（这里只管落盘） */
  actor?: "ui" | "agent";
}

export type WriteResult =
  | { ok: true; path: string; revision: string; backup?: string }
  | FileFailure
  | { ok: false; status: 409; error: string; revision: string };

function backupPrefixOf(filePath: string): string {
  return `${basename(filePath)}.`;
}

/**
 * 只保留每个文件最近的 MAX_BACKUPS 份。
 * 早先按目录整体排序裁剪，多个文件共用一个 `.backup/` 时会互相挤掉 —— 改为按文件名前缀分组。
 */
function pruneBackups(dir: string, prefix: string): void {
  try {
    const names = readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .sort();
    for (const name of names.slice(0, Math.max(0, names.length - MAX_BACKUPS))) {
      try {
        unlinkSync(join(dir, name));
      } catch {
        /* 删不掉不影响写入 */
      }
    }
  } catch {
    /* 备份目录不存在就不清理 */
  }
}

/** 备份名里的时间戳是 `2026-11-09T12-36-54-698Z`（冒号/点被换成了短横），这里还原成可读时间。 */
function stampToIso(stamp: string): string {
  // 同一毫秒内多次写入会带一个短随机后缀（见 writeAgentFile），这里一并接受
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z(?:-[0-9a-f]{6})?$/.exec(stamp);
  return m ? `${m[1]}:${m[2]}:${m[3]}.${m[4]}Z` : stamp;
}

function appendChange(target: string, entry: Record<string, unknown>): void {
  try {
    const file = join(dirname(target), ".changes.jsonl");
    if (existsSync(file) && statSync(file).size > CHANGE_LOG_MAX_BYTES) {
      const kept = readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-CHANGE_LOG_KEEP_LINES);
      writeFileSync(file, kept.length ? `${kept.join("\n")}\n` : "", "utf8");
    }
    appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    /* 变更记录是辅助线索，写不进去不该挡住主写入 */
  }
}

export function writeAgentFile(root: string, relPath: string, content: string, options: WriteOptions = {}): WriteResult {
  const resolved = resolveInside(root, relPath);
  if (!resolved.ok) return resolved;

  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_BYTES) return { ok: false, status: 413, error: `内容超过 ${MAX_BYTES / 1024}KB` };

  const exists = existsSync(resolved.path);
  const current = exists ? readFileSync(resolved.path, "utf8") : "";
  const currentRevision = revisionOf(current);

  if (options.expectedRevision !== undefined && options.expectedRevision !== currentRevision) {
    return {
      ok: false,
      status: 409,
      error: "数据已被改动（可能是 Agent 刚写过），请刷新后再改",
      revision: currentRevision,
    };
  }

  const dir = dirname(resolved.path);
  if (!existsSync(dir)) return { ok: false, status: 400, error: "目标目录不存在" };

  let backupPath: string | undefined;
  if (exists) {
    try {
      const backupDir = join(dir, ".backup");
      mkdirSync(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      backupPath = join(backupDir, `${basename(resolved.path)}.${stamp}`);
      // 同一毫秒内连续写两次会撞名 —— 撞了就加短随机后缀，否则备份会互相覆盖（自测钉住）
      if (existsSync(backupPath)) {
        backupPath = join(backupDir, `${basename(resolved.path)}.${stamp}-${randomUUID().slice(0, 6)}`);
      }
      writeFileSync(backupPath, current, "utf8");
      pruneBackups(backupDir, backupPrefixOf(resolved.path));
    } catch {
      // 备份失败不阻断写入：数据正确落盘优先于留旧件
      backupPath = undefined;
    }
  }

  try {
    writePrivateFileAtomicSync(resolved.path, content);
  } catch (error) {
    return { ok: false, status: 500, error: String(error) };
  }

  const revision = revisionOf(content);
  appendChange(resolved.path, {
    ts: new Date().toISOString(),
    path: relPath,
    bytes,
    revision,
    actor: options.actor ?? "ui",
  });

  return { ok: true, path: relPath, revision, backup: backupPath ? relative(root, backupPath) : undefined };
}

export interface DocFile {
  path: string;
  name: string;
  size: number;
  revision: string;
}

/** doc 块的数据来源：一个目录下的 `.md` 列表（按名字排序，最多 60 个）。 */
export function listMarkdownFiles(root: string, relDir: string): DocFile[] {
  const resolved = resolveInside(root, join(relDir, "placeholder.md"));
  if (!resolved.ok) return [];
  const dir = dirname(resolved.path);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith(".md") && !name.startsWith("."))
      .slice(0, 60)
      .map((name) => {
        const abs = join(dir, name);
        const content = readFileSync(abs, "utf8");
        return {
          path: relative(resolve(root), abs).split("\\").join("/"),
          name,
          size: Buffer.byteLength(content, "utf8"),
          revision: revisionOf(content),
        };
      });
  } catch {
    return [];
  }
}

/* ---------------- 历史版本（每次写入前的自动备份） ---------------- */

export interface DataVersion {
  /** 备份文件名（恢复时用它，不接受路径） */
  name: string;
  size: number;
  /** ISO 时间；取自文件名里的时间戳 */
  savedAt: string;
  revision: string;
}

function backupDirOf(filePath: string): string {
  return join(dirname(filePath), ".backup");
}

/** 列出某个文件的历次备份（最新在前，最多 MAX_BACKUPS 份）。 */
export function listVersions(root: string, relPath: string): DataVersion[] {
  const resolved = resolveInside(root, relPath);
  if (!resolved.ok) return [];
  const dir = backupDirOf(resolved.path);
  if (!existsSync(dir)) return [];
  const prefix = backupPrefixOf(resolved.path);
  try {
    return readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && !name.endsWith(".tmp"))
      .sort()
      .reverse()
      .slice(0, MAX_BACKUPS)
      .flatMap((name): DataVersion[] => {
        try {
          const content = readFileSync(join(dir, name), "utf8");
          return [{
            name,
            size: Buffer.byteLength(content, "utf8"),
            savedAt: stampToIso(name.slice(prefix.length)),
            revision: revisionOf(content),
          }];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/**
 * 把某个历史版本写回正文（写前仍会为「当前内容」留一份备份，所以恢复本身也可后悔）。
 * `name` 只接受 `listVersions()` 给出的文件名 —— 不接受路径，避免借恢复接口越界。
 */
export function restoreVersion(
  root: string,
  relPath: string,
  name: string,
  options: WriteOptions = {},
): WriteResult {
  const resolved = resolveInside(root, relPath);
  if (!resolved.ok) return resolved;
  const prefix = backupPrefixOf(resolved.path);
  if (!name.startsWith(prefix) || name.includes("/") || name.includes("\\") || name.includes("..")) {
    return { ok: false, status: 400, error: "版本名不合法" };
  }
  const file = join(backupDirOf(resolved.path), name);
  if (!existsSync(file)) return { ok: false, status: 404, error: "这个版本已经不在了" };
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch (error) {
    return { ok: false, status: 500, error: String(error) };
  }
  return writeAgentFile(root, relPath, content, { ...options, actor: "ui" });
}
