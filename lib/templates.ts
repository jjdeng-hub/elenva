import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";

/**
 * 会话模板（常用任务一键起）。
 *
 * 摩擦：巡查、复核、日报这类「固定套路」的会话，每次都要重选工作区、重敲
 * 一遍提示词。这里把「工作区 + 提示词」存成服务端模板（`~/.pi/agent/` 下的
 * JSON，与其它用户数据一致），空态一键带出来。
 *
 * 边界：模板只做两件事 —— 选工作区、覆盖输入框文本；不发消息、不创建会话
 * （发送仍由用户按发送键）。存服务端而非 localStorage，是为了以后多端入口
 * 共用同一份；读写沿用「服务端校验 + 原子写」家规。
 */

/** 模板上限：够日常套路用，又不至于把空态芯片墙塞满 */
export const MAX_TEMPLATES = 50;
/** 名称长度：trim 后 1–40 字 */
export const TEMPLATE_NAME_MAX = 40;
/** 提示词长度：trim 后 1–10000 字 */
export const TEMPLATE_PROMPT_MAX = 10000;

export interface SessionTemplate {
  id: string;
  name: string;
  /** null = 默认工作区 */
  cwd: string | null;
  prompt: string;
  createdAt: string;
}

interface StoredFile {
  version: 1;
  templates: SessionTemplate[];
}

export function getTemplatesPath(agentDir = getAgentDir()): string {
  return join(agentDir, "elenva-templates.json");
}

/** 读失败 / 文件不存在 → 空列表（不打扰），只认结构合法的条目 */
function readTemplates(path: string): SessionTemplate[] {
  if (!existsSync(path)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object") return [];
    const templates = (parsed as { templates?: unknown }).templates;
    if (!Array.isArray(templates)) return [];
    return templates.filter((item): item is SessionTemplate => (
      item !== null
      && typeof item === "object"
      && typeof (item as SessionTemplate).id === "string"
      && typeof (item as SessionTemplate).name === "string"
      && typeof (item as SessionTemplate).prompt === "string"
      && ((item as SessionTemplate).cwd === null || typeof (item as SessionTemplate).cwd === "string")
      && typeof (item as SessionTemplate).createdAt === "string"
    ));
  } catch {
    return [];
  }
}

function writeTemplates(templates: SessionTemplate[], path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const payload: StoredFile = { version: 1, templates };
  writePrivateFileAtomicSync(path, JSON.stringify(payload, null, 2));
}

/** 稳定按 createdAt 升序（同刻保持文件内原序，老模板在前） */
export function listTemplates(agentDir?: string): SessionTemplate[] {
  return readTemplates(getTemplatesPath(agentDir))
    .map((template, index) => ({ template, index }))
    .sort((a, b) => a.template.createdAt.localeCompare(b.template.createdAt) || a.index - b.index)
    .map(({ template }) => template);
}

export interface CreateTemplateInput {
  name: string;
  cwd?: string | null;
  prompt: string;
}

export function createTemplate(input: CreateTemplateInput, agentDir?: string): SessionTemplate {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  const rawCwd = input.cwd ?? null;

  if (!name) throw new Error("模板名称不能为空");
  if (name.length > TEMPLATE_NAME_MAX) throw new Error(`模板名称最长 ${TEMPLATE_NAME_MAX} 字`);
  if (!prompt) throw new Error("模板内容不能为空");
  if (prompt.length > TEMPLATE_PROMPT_MAX) throw new Error(`模板内容最长 ${TEMPLATE_PROMPT_MAX} 字`);
  if (rawCwd !== null && typeof rawCwd !== "string") throw new Error("工作区参数不合法");
  const cwd = rawCwd === null ? null : rawCwd.trim() || null;

  const path = getTemplatesPath(agentDir);
  const templates = readTemplates(path);
  if (templates.length >= MAX_TEMPLATES) {
    throw new Error(`模板最多 ${MAX_TEMPLATES} 个，先删掉一些再存`);
  }

  const created: SessionTemplate = {
    id: `tpl-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
    name,
    cwd,
    prompt,
    createdAt: new Date().toISOString(),
  };
  writeTemplates([...templates, created], path);
  return created;
}

export function deleteTemplate(id: string, agentDir?: string): void {
  const path = getTemplatesPath(agentDir);
  const templates = readTemplates(path);
  const next = templates.filter((template) => template.id !== id);
  if (next.length === templates.length) throw new Error("找不到该模板");
  writeTemplates(next, path);
}
