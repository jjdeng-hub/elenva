/**
 * 会话内容搜索 · FTS5 索引（P4d）—— 主线程侧封装。
 *
 * 实际工作在 lib/search-index-worker.mjs（worker_threads）里跑：
 * - 独立索引库 ~/.elenva/search-index.db（绝不写 Hermes 的 state.db，state.db 只读打开）
 * - 增量同步按每 profile 的水位（messages.rowid）推进，分批提交
 * - 查询走 FTS5 MATCH + bm25（≥3 字）或 LIKE 兜底（<3 字）
 *
 * 死线双保险：worker 内有软死线（批间检查），主线程到硬死线直接 terminate() ——
 * 同步/查询卡在哪都能中断，进度靠分批提交保住。P4b 实测主线程死线拦不住
 * node:sqlite 的整块返回（冷查 8573ms），这就是把工作挪进 worker 的原因。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { ContentSearchResult } from "@/lib/sessions-content-search";

export type SearchIndexStats = {
  /** 索引水位落后 state.db 的消息数（>0 = 索引未追上，结果可能不全） */
  pending?: number;
  /** state.db 该 profile 的最大 rowid */
  total?: number;
  inserted?: number;
  syncMs?: number;
  queryMs?: number;
  /** "fts" | "like" */
  mode?: string;
  /** 该 profile 的 state.db 不存在 */
  missing?: boolean;
  /** reindex 返回：索引库体积 */
  bytes?: number;
  docs?: number;
};

export type SearchIndexOutcome = {
  ok?: boolean;
  results: ContentSearchResult[];
  truncated: boolean;
  /** 硬死线到点被 terminate（连软死线都没来得及返回） */
  terminated?: boolean;
  error?: string;
  stats?: SearchIndexStats;
};

const WORKER_CANDIDATES = (): string[] => {
  const envPath = process.env.ELENVA_SEARCH_WORKER_PATH;
  const list = [
    envPath,
    join(process.cwd(), "lib", "search-index-worker.mjs"),
    join(process.cwd(), ".next", "server", "search-index-worker.mjs"),
  ].filter((p): p is string => Boolean(p));
  return list.filter((p) => existsSync(p));
};

let cachedWorkerPath: string | null = null;

function resolveWorkerPath(): string | null {
  if (cachedWorkerPath && existsSync(cachedWorkerPath)) return cachedWorkerPath;
  for (const p of WORKER_CANDIDATES()) {
    cachedWorkerPath = p;
    return p;
  }
  return null;
}

/** 单飞一条 worker 消息：硬超时 terminate，软超时由 worker 自查 */
function runInWorker<T = SearchIndexOutcome>(
  message: Record<string, unknown>,
  hardTimeoutMs: number,
): Promise<T & { token?: unknown }> {
  const workerPath = resolveWorkerPath();
  if (!workerPath) {
    return Promise.resolve({
      ok: false,
      results: [],
      truncated: true,
      error: "search-index worker 未找到（ELENVA_SEARCH_WORKER_PATH 可指定）",
    } as unknown as T & { token?: unknown });
  }
  return new Promise((resolve) => {
    const worker = new Worker(workerPath);
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let settled = false;
    const timer = setTimeout(() => {
      // 硬死线：terminate 后**立即**返回截断空结果，不等 message/exit ——
      // P4b 实测等收尾也可能拖过 2s，承诺必须在主线程同步兑现
      if (settled) return;
      settled = true;
      void worker.terminate();
      resolve({ ok: false, results: [], truncated: true, terminated: true } as unknown as T & { token?: unknown });
    }, hardTimeoutMs);
    const done = (value: { token?: unknown } & Record<string, unknown>) => {
      if (settled || value?.token !== token) return; // 别的 token 的消息不接
      settled = true;
      clearTimeout(timer);
      resolve(value as T & { token?: unknown });
    };
    worker.on("message", (m: { token?: unknown } & Record<string, unknown>) => {
      done(m);
      void worker.terminate();
    });
    worker.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, results: [], truncated: true, error: String(error) } as unknown as T & { token?: unknown });
    });
    worker.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // worker 收到 terminate 后走这里：resolve 一个截断的空结果（Promise 已被 message 或下面 resolve 占位的除外）
      resolve({ ok: false, results: [], truncated: true, terminated: true, exitCode: code } as unknown as T & { token?: unknown });
    });
    worker.postMessage({ ...message, token });
  });
}

/**
 * Hermes 侧内容搜索（走索引）。deadlineMs 是硬死线：超过必返回，
 * 且带 truncated=true —— 界面据此区分「没找到」和「没搜完」。
 */
export async function searchViaIndex(opts: {
  q: string;
  profile: string;
  deadlineMs: number;
}): Promise<SearchIndexOutcome> {
  const hardTimeoutMs = Math.max(100, opts.deadlineMs - Date.now() + 150);
  // 软死线留出查询+IPC 的余量（P4d 实测：sync 拖到软死线后还要 ~150ms 查询，
  // 只提前 150ms 会整体压到 2s 开外），worker 大多数情况能自己体面收尾
  const res = await runInWorker<SearchIndexOutcome>(
    { type: "search", q: opts.q, profile: opts.profile, softDeadlineMs: opts.deadlineMs - 800 },
    hardTimeoutMs,
  );
  // terminated（没等到消息就 exit）→ 保守标 truncated
  if (!res.ok) {
    return {
      results: res.results ?? [],
      truncated: true,
      terminated: Boolean((res as { terminated?: boolean }).terminated),
      error: res.error,
    };
  }
  return {
    results: res.results,
    truncated: Boolean(res.truncated),
    stats: res.stats,
  };
}

/** 重建某 profile 的索引（显式动作，不限 2s；调用方等待完成拿统计） */
export async function reindexProfile(opts: {
  profile: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; stats?: SearchIndexStats; error?: string }> {
  const res = await runInWorker<{ ok: boolean; stats?: SearchIndexStats; error?: string }>(
    { type: "reindex", profile: opts.profile },
    opts.timeoutMs ?? 10 * 60_000,
  );
  return { ok: Boolean(res.ok), stats: res.stats, error: res.error };
}
