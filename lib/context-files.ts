import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";

/**
 * Pi 上下文文件管理：
 * - 全局指令 ~/.pi/agent/AGENTS.md；全局系统提示 ~/.pi/agent/SYSTEM.md
 * - 项目指令 <cwd>/AGENTS.md；项目系统提示 <cwd>/.pi/SYSTEM.md
 * 语义见 SDK docs/usage.md「Context Files / System Prompt Files」。
 */

export const MAX_CONTEXT_FILE_BYTES = 512 * 1024;

export type ContextFileId = "global-agents" | "global-system" | "project-agents" | "project-system";

export const CONTEXT_FILE_IDS: readonly ContextFileId[] = [
  "global-agents",
  "global-system",
  "project-agents",
  "project-system",
];

export interface ContextFileEntry {
  id: ContextFileId;
  /** 展示名 */
  label: string;
  /** 作用范围：global / project（project 需要 cwd） */
  scope: "global" | "project";
  /** 绝对路径；project 无 cwd 时为 null */
  path: string | null;
  exists: boolean;
  content: string;
}

export function resolveContextFilePath(id: ContextFileId, cwd?: string | null): string | null {
  const agentDir = getAgentDir();
  switch (id) {
    case "global-agents":
      return join(agentDir, "AGENTS.md");
    case "global-system":
      return join(agentDir, "SYSTEM.md");
    case "project-agents":
      return cwd ? join(cwd, "AGENTS.md") : null;
    case "project-system":
      return cwd ? join(cwd, ".pi", "SYSTEM.md") : null;
  }
}

export function listContextFiles(cwd?: string | null): ContextFileEntry[] {
  const defs: { id: ContextFileId; label: string; scope: "global" | "project" }[] = [
    { id: "global-agents", label: "全局 AGENTS.md", scope: "global" },
    { id: "global-system", label: "全局 SYSTEM.md", scope: "global" },
    { id: "project-agents", label: "项目 AGENTS.md", scope: "project" },
    { id: "project-system", label: "项目 SYSTEM.md", scope: "project" },
  ];
  return defs.map((def) => {
    const path = resolveContextFilePath(def.id, cwd);
    if (!path || !existsSync(path)) {
      return { ...def, path, exists: false, content: "" };
    }
    try {
      return { ...def, path, exists: true, content: readFileSync(path, "utf8") };
    } catch {
      return { ...def, path, exists: false, content: "" };
    }
  });
}

export function writeContextFile(id: ContextFileId, content: string, cwd?: string | null): string | null {
  const path = resolveContextFilePath(id, cwd);
  if (!path) throw new Error("项目级上下文文件需要提供 cwd");
  if (typeof content !== "string") throw new Error("content 必须是字符串");
  if (Buffer.byteLength(content, "utf8") > MAX_CONTEXT_FILE_BYTES) {
    throw new Error(`内容超过大小上限（${Math.floor(MAX_CONTEXT_FILE_BYTES / 1024)}KB）`);
  }
  // 全空内容 = 删除文件（清空该上下文文件的作用）
  if (content.trim() === "") {
    if (existsSync(path)) unlinkSync(path);
    return null;
  }
  mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(path, content);
  return path;
}

/**
 * 「记住这条」：把一句话追加成约定条目，而不是让用户自己去编辑整份 Markdown。
 *
 * 目标是「纠正的当下就能落盘」——之前想把「以后用 pnpm 不要用 npm」变成约定，
 * 得先切到记忆页、找到 AGENTS.md、把光标移到文末、手动造一条列表项。
 *
 * 追加规则刻意做得可预测：多行压成一行（用「；」分隔）、已是列表项则不重复加
 * 前缀、同文不重复追加。文件不存在时建一个带标题的最小文件。
 */
export function appendContextInstruction(
  id: ContextFileId,
  text: string,
  cwd?: string | null,
): { path: string; added: string; duplicated: boolean } {
  const path = resolveContextFilePath(id, cwd);
  if (!path) throw new Error("项目级上下文文件需要提供 cwd");
  const single = text.trim().split(/\r?\n+/).map((line) => line.trim()).filter(Boolean).join("；");
  if (!single) throw new Error("内容不能为空");
  const bullet = /^[-*]\s/.test(single) ? single : `- ${single}`;

  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const normalized = (value: string) => value.replace(/^[-*]\s*/, "").trim();
  if (existing.split("\n").some((line) => normalized(line) === normalized(bullet))) {
    return { path, added: bullet, duplicated: true };
  }

  const additions: string[] = [];
  if (!existing.trim()) additions.push("# 项目约定", "");
  else if (!existing.endsWith("\n")) additions.push("");
  else if (existing.trim() && !existing.endsWith("\n\n")) additions.push("");
  additions.push(bullet, "");

  const next = `${existing}${additions.join("\n")}`;
  if (Buffer.byteLength(next, "utf8") > MAX_CONTEXT_FILE_BYTES) {
    throw new Error(`内容超过大小上限（${Math.floor(MAX_CONTEXT_FILE_BYTES / 1024)}KB）`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(path, next);
  return { path, added: bullet, duplicated: false };
}

export function isContextFileId(value: unknown): value is ContextFileId {
  return typeof value === "string" && (CONTEXT_FILE_IDS as readonly string[]).includes(value);
}
