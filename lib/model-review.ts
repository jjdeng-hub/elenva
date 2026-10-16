/**
 * 换模型复核（模块 6 · 第 1 轮）—— 复核关系落档 + 双向查询。
 *
 * 「同任务换个模型再跑一遍、并排看结果」此前是每次交付时的手工动作，没有落档：
 * 复核会话与它要复核的原会话之间没有关系记录，下次找不回来。这里把它变成一等记录。
 *
 * 分层（同 budget-guard / guardrail-policy 的约定）：
 *  · 上半是**纯函数区**：解析 / 合并 / 查询 / 任务文本抽取，无 `node:*`、无副作用，
 *    自测可直载。**客户端只应 `import type`**——本文件下半有 node:fs，运行时导入会把
 *    文件系统带进浏览器包，因此展示用的状态文案由界面自己映射，不从这里取。
 *  · 下半是 **IO 区**：`<agentDir>/elenva-model-reviews.json`，0600 原子写、损坏容错、
 *    上限 200 条 FIFO（超出丢最旧）。
 */

export const MAX_MODEL_REVIEWS = 200;
/** 任务摘要上限：chip 与标题里只留一眼能认出的开头 */
export const TASK_PREVIEW_MAX = 120;
/** 复核会话标题里模型名的显示上限，防止超长 id 撑爆标题 */
const MODEL_LABEL_MAX = 40;

export interface ModelReviewModel {
  provider: string;
  modelId: string;
}

export type ModelReviewStatus = "creating" | "running" | "done" | "error";

export interface ModelReview {
  id: string;
  /** 被复核的原会话 */
  parentSessionId: string;
  /** 复核会话；创建失败时缺省 */
  reviewSessionId?: string;
  /** 复核所用的模型 */
  model: ModelReviewModel;
  /** 原会话首条任务原文的截断（用于列表辨识，不回灌原会话产出） */
  taskPreview: string;
  status: ModelReviewStatus;
  createdAt: string;
  error?: string;
}

const STATUSES: readonly ModelReviewStatus[] = ["creating", "running", "done", "error"];

export function isModelReviewStatus(value: unknown): value is ModelReviewStatus {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
}

export function isModelReviewModel(value: unknown): value is ModelReviewModel {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.provider === "string" && raw.provider.trim().length > 0
    && typeof raw.modelId === "string" && raw.modelId.trim().length > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * 任务文本归一：折叠空白后按上限截断（超出加省略号）。
 * 空文本返回空串——调用方据此判断「没有可复核的任务」。
 */
export function truncateTaskPreview(text: string, max = TASK_PREVIEW_MAX): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** 复核会话标题：「复核 · {model} · {任务截断}」（与新建会话标题同一套展示口径）。 */
export function buildReviewTitle(model: ModelReviewModel, taskPreview: string): string {
  const modelLabel = truncateTaskPreview(model.modelId, MODEL_LABEL_MAX) || model.modelId;
  const task = truncateTaskPreview(taskPreview);
  return task ? `复核 · ${modelLabel} · ${task}` : `复核 · ${modelLabel}`;
}

/**
 * 复核会话要发送的消息：**原任务原文 + 一行独立复核声明**。
 * 刻意不注入原会话的任何产出（不附 diff、不附结论）——复核必须从零独立跑，
 * 否则只是「让另一个模型同意上一个模型」。
 */
export function buildReviewPrompt(taskText: string): string {
  return `${taskText}\n\n（独立复核对照：请按同一任务从零执行）`;
}

/**
 * 从会话 entries 里取首条有文字的用户消息（原会话的任务原文）。
 * 纯函数：入参是任意 JSON 形状的 entries，坏数据跳过。
 */
export function extractFirstUserTask(entries: readonly unknown[]): string | null {
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== "message") continue;
    const message = record.message;
    if (message === null || typeof message !== "object") continue;
    const { role, content } = message as { role?: unknown; content?: unknown };
    if (role !== "user") continue;
    const text = contentText(content);
    if (text) return text;
  }
  return null;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: string; text: string } =>
        block !== null
        && typeof block === "object"
        && (block as Record<string, unknown>).type === "text"
        && typeof (block as Record<string, unknown>).text === "string",
    )
    .map((block) => block.text)
    .join(" ")
    .trim();
}

/** 读盘归一：只收形状完整的条目，其余静默丢弃；按存储顺序、截到上限。 */
export function parseModelReviews(raw: unknown): ModelReview[] {
  const list = Array.isArray(raw)
    ? raw
    : raw !== null && typeof raw === "object" && Array.isArray((raw as { reviews?: unknown }).reviews)
      ? (raw as { reviews: unknown[] }).reviews
      : [];
  const out: ModelReview[] = [];
  for (const item of list) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (!isNonEmptyString(record.id) || !isNonEmptyString(record.parentSessionId)) continue;
    if (!isModelReviewModel(record.model)) continue;
    if (!isModelReviewStatus(record.status)) continue;
    const review: ModelReview = {
      id: record.id,
      parentSessionId: record.parentSessionId,
      model: { provider: record.model.provider, modelId: record.model.modelId },
      taskPreview: typeof record.taskPreview === "string" ? record.taskPreview : "",
      status: record.status,
      createdAt: isNonEmptyString(record.createdAt) ? record.createdAt : new Date(0).toISOString(),
    };
    if (isNonEmptyString(record.reviewSessionId)) review.reviewSessionId = record.reviewSessionId;
    if (isNonEmptyString(record.error)) review.error = record.error;
    out.push(review);
    if (out.length >= MAX_MODEL_REVIEWS) break;
  }
  return out;
}

/**
 * 合并写入：同 id 覆盖并提到最前，超出上限丢最旧（FIFO）。
 * 返回新数组（不改入参），供纯函数自测与 IO 区共用。
 */
export function upsertModelReview(list: readonly ModelReview[], review: ModelReview): ModelReview[] {
  const next = [review, ...list.filter((item) => item.id !== review.id)];
  return next.slice(0, MAX_MODEL_REVIEWS);
}

/** 局部更新（状态流转用）；找不到 id 时原样返回。 */
export function patchModelReview(
  list: readonly ModelReview[],
  id: string,
  patch: Partial<Omit<ModelReview, "id" | "parentSessionId">>,
): ModelReview[] {
  return list.map((item) => (item.id === id ? { ...item, ...patch, id: item.id, parentSessionId: item.parentSessionId } : item));
}

/**
 * 双向查询：该会话**作为原会话**发起了哪些复核（asParent），
 * 以及该会话**本身是不是某次复核的产物**（asReview）。
 * 去重按 id；顺序保持存储顺序（新的在前）。
 */
export function findReviewRelations(
  list: readonly ModelReview[],
  sessionId: string,
): { asParent: ModelReview[]; asReview: ModelReview[] } {
  const seen = new Set<string>();
  const asParent: ModelReview[] = [];
  const asReview: ModelReview[] = [];
  for (const item of list) {
    if (seen.has(item.id)) continue;
    if (item.parentSessionId === sessionId) {
      seen.add(item.id);
      asParent.push(item);
    } else if (item.reviewSessionId === sessionId) {
      seen.add(item.id);
      asReview.push(item);
    }
  }
  return { asParent, asReview };
}

// ============================================================================
// IO 区（服务端专用）
// ============================================================================

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";

export function getModelReviewsPath(agentDir = getAgentDir()): string {
  return join(agentDir, "elenva-model-reviews.json");
}

/** 读盘容错：文件缺失 / 损坏 / 形状不对一律当空列表，不让界面因一条坏记录打不开。 */
export function readModelReviews(agentDir?: string): ModelReview[] {
  const path = getModelReviewsPath(agentDir);
  if (!existsSync(path)) return [];
  try {
    return parseModelReviews(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return [];
  }
}

export function writeModelReviews(reviews: readonly ModelReview[], agentDir?: string): void {
  const path = getModelReviewsPath(agentDir);
  mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(path, `${JSON.stringify({ version: 1, reviews }, null, 2)}\n`);
}

/** 新建一条复核记录（status 通常为 `creating`），返回落库后的记录。 */
export function createModelReview(
  input: Omit<ModelReview, "id" | "createdAt"> & { id?: string; createdAt?: string },
  agentDir?: string,
): ModelReview {
  const review: ModelReview = {
    ...input,
    id: input.id ?? randomUUID(),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  writeModelReviews(upsertModelReview(readModelReviews(agentDir), review), agentDir);
  return review;
}

/** 状态流转；返回更新后的记录（找不到 id 时为 null）。 */
export function updateModelReview(
  id: string,
  patch: Partial<Omit<ModelReview, "id" | "parentSessionId">>,
  agentDir?: string,
): ModelReview | null {
  const current = readModelReviews(agentDir);
  const existing = current.find((item) => item.id === id);
  if (!existing) return null;
  const next = patchModelReview(current, id, patch);
  writeModelReviews(next, agentDir);
  return next.find((item) => item.id === id) ?? null;
}
