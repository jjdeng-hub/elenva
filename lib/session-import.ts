import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { resolveSessionPath } from "./session-reader";

/**
 * 导入 pi CLI 导出的 JSONL 会话文件（/import 的 Web 版）。
 * 校验结构后按 pi 的命名约定放入 ~/.pi/agent/sessions/<encoded-cwd>/，
 * 会话 id 沿用文件头，随后即可在会话列表中看到并正常打开。
 */

/** 复刻 SDK getDefaultSessionDirPath 的 cwd → 目录名编码 */
function defaultSessionDirPath(cwd: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(getAgentDir(), "sessions", safePath);
}

export const MAX_IMPORT_BYTES = 64 * 1024 * 1024;

export interface ParsedImport {
  sessionId: string;
  headerCwd: string | undefined;
  lineCount: number;
}

/** 解析并校验 JSONL 内容；返回会话 id 与文件头声明的 cwd */
export function parseImportContent(content: string): ParsedImport {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new Error("文件为空");

  let first: unknown;
  try {
    first = JSON.parse(lines[0]);
  } catch {
    throw new Error("首行不是合法 JSON（需要 pi 会话文件头）");
  }
  const header = first as Record<string, unknown>;
  if (header?.type !== "session" || typeof header.id !== "string" || !header.id.trim()) {
    throw new Error('缺少会话文件头（首行应为 {"type":"session", "id":…}）');
  }
  const sessionId = header.id.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)) {
    throw new Error(`会话 id 非法：${sessionId}`);
  }
  const headerCwd = typeof header.cwd === "string" && header.cwd.trim() ? header.cwd : undefined;

  for (let i = 1; i < lines.length; i++) {
    try {
      const parsed: unknown = JSON.parse(lines[i]);
      if (parsed === null || typeof parsed !== "object") throw new Error("not an object");
    } catch {
      throw new Error(`第 ${i + 1} 行不是合法 JSON 对象`);
    }
  }
  return { sessionId, headerCwd, lineCount: lines.length };
}

/** 回退 cwd：~/pi-workspace（与 /api/default-cwd 一致；旧日期形态已弃用） */
export function fallbackImportCwd(): string {
  return join(homedir(), "pi-workspace");
}

/** 把已校验的 JSONL 内容写入会话目录，返回目标文件路径 */
export function writeImportedSession(content: string, sessionId: string, cwd: string): string {
  const sessionDir = defaultSessionDirPath(cwd);
  mkdirSync(sessionDir, { recursive: true });
  const timestamp = new Date().toISOString();
  const fileTimestamp = timestamp.replace(/[:.]/g, "-");
  const target = join(sessionDir, `${fileTimestamp}_${sessionId}.jsonl`);
  if (existsSync(target)) throw new Error("目标文件已存在，请重试");
  writePrivateFileAtomicSync(target, content.endsWith("\n") ? content : `${content}\n`);
  return target;
}

export function dirExists(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export async function sessionIdExists(id: string): Promise<boolean> {
  return (await resolveSessionPath(id)) !== null;
}
