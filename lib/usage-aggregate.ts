/**
 * Offline token/cost aggregation across ALL persisted session files.
 *
 * Unlike the runtime session-stats panel (live session only), this scans
 * every session JSONL under the agent sessions dir so the home dashboard can
 * show "today's tokens/cost", an all-time total, a 7-day trend, and a
 * per-session usage map.
 *
 * Aggregation mirrors lib/session-stats.ts computeSessionStats(): usage is
 * counted on assistant/toolResult messages plus compaction and branch-summary
 * entries, so totals keep growing across compactions.
 *
 * Per-file aggregates are cached keyed by (mtimeMs, size) — rescanning stats
 * is cheap; only changed files are re-parsed.
 */

import { closeSync, fstatSync, openSync, readSync } from "fs";
import { readdir, stat } from "fs/promises";
import { join } from "path";
import { getAgentDir } from "./session-reader";

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface DailyUsage {
  date: string; // local YYYY-MM-DD
  tokens: UsageTotals;
  cost: number;
}

export interface UsageReport {
  today: { tokens: UsageTotals; cost: number };
  allTime: { tokens: UsageTotals; cost: number };
  /** Last 84 days oldest → newest (today last), zero-filled; client aligns to week columns. */
  days: DailyUsage[];
  /** Per-session usage keyed by session id. */
  sessions: Record<string, { tokens: UsageTotals; cost: number; model?: string }>;
  /** All-time usage keyed by "provider/modelId" (assistant + trailing toolResult messages). */
  models: Record<string, { tokens: UsageTotals; cost: number }>;
}

const AGG_VERSION = 2;

interface FileAggregate {
  id: string;
  days: Map<string, { tokens: UsageTotals; cost: number }>;
  /** All-time per-model usage (assistant messages; trailing toolResults inherit the model). */
  models: Map<string, { tokens: UsageTotals; cost: number }>;
  /** Model of the last assistant message ("provider/modelId"). */
  lastModel?: string;
}

interface CacheSlot {
  version: number;
  mtimeMs: number;
  size: number;
  aggregate: FileAggregate;
}

const EMPTY_TOKENS = (): UsageTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });

function addUsage(
  bucket: { tokens: UsageTotals; cost: number },
  usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } | undefined,
): void {
  if (!usage) return;
  bucket.tokens.input += usage.input ?? 0;
  bucket.tokens.output += usage.output ?? 0;
  bucket.tokens.cacheRead += usage.cacheRead ?? 0;
  bucket.tokens.cacheWrite += usage.cacheWrite ?? 0;
  bucket.cost += usage.cost?.total ?? 0;
}

function finishTokens(tokens: UsageTotals): void {
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}

function addTo(target: UsageTotals, source: UsageTotals): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.total += source.total;
}

/** Local-calendar date key (YYYY-MM-DD) for an ISO timestamp. */
function localDateKey(iso: string | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  const d = Number.isNaN(t) ? new Date() : new Date(t);
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function getSessionCache(): Map<string, CacheSlot> {
  const g = globalThis as typeof globalThis & { __piUsageAggregateCache?: Map<string, CacheSlot> };
  if (!g.__piUsageAggregateCache) g.__piUsageAggregateCache = new Map();
  return g.__piUsageAggregateCache;
}

function parseFile(filePath: string): FileAggregate {
  const days = new Map<string, { tokens: UsageTotals; cost: number }>();
  const models = new Map<string, { tokens: UsageTotals; cost: number }>();
  let id = "";
  let lastModel: string | undefined;
  let currentModel: string | undefined;

  const fd = openSync(filePath, "r");
  try {
    const size = fstatSync(fd).size;
    const chunkSize = 256 * 1024;
    let buffer = "";
    let position = 0;
    while (position < size) {
      const chunk = Buffer.allocUnsafe(Math.min(chunkSize, size - position));
      const bytesRead = readSync(fd, chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      buffer += chunk.subarray(0, bytesRead).toString("utf8");

      let newlineIndex = buffer.lastIndexOf("\n");
      if (newlineIndex === -1) continue;
      const lines = buffer.slice(0, newlineIndex).split("\n");
      buffer = buffer.slice(newlineIndex + 1);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let entry: Record<string, unknown>;
        try {
          entry = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (entry.type === "session" && typeof entry.id === "string") {
          id = entry.id;
          continue;
        }
        let usage: Record<string, unknown> | undefined;
        if (entry.type === "message") {
          const message = entry.message as Record<string, unknown> | undefined;
          const role = message?.role;
          if (role === "assistant") {
            usage = message?.usage as Record<string, unknown> | undefined;
            const provider = typeof message?.provider === "string" ? message.provider : "";
            const modelId = typeof message?.model === "string" ? message.model : "";
            if (provider || modelId) {
              currentModel = `${provider || "?"}/${modelId || "?"}`;
              lastModel = currentModel;
            }
          } else if (role === "toolResult") {
            usage = message?.usage as Record<string, unknown> | undefined;
          }
        } else if (entry.type === "compaction" || entry.type === "branch_summary") {
          usage = entry.usage as Record<string, unknown> | undefined;
        }
        if (!usage) continue;
        const key = localDateKey(typeof entry.timestamp === "string" ? entry.timestamp : undefined);
        let bucket = days.get(key);
        if (!bucket) {
          bucket = { tokens: EMPTY_TOKENS(), cost: 0 };
          days.set(key, bucket);
        }
        addUsage(bucket, usage as Parameters<typeof addUsage>[1]);
        if (currentModel) {
          let modelBucket = models.get(currentModel);
          if (!modelBucket) {
            modelBucket = { tokens: EMPTY_TOKENS(), cost: 0 };
            models.set(currentModel, modelBucket);
          }
          addUsage(modelBucket, usage as Parameters<typeof addUsage>[1]);
        }
      }
    }
    // Trailing line without newline.
    const trimmed = buffer.trim();
    if (trimmed) {
      try {
        const entry = JSON.parse(trimmed) as Record<string, unknown>;
        if (entry.type === "session" && typeof entry.id === "string") id = entry.id;
      } catch { /* ignore */ }
    }
  } finally {
    closeSync(fd);
  }

  for (const bucket of days.values()) finishTokens(bucket.tokens);
  for (const bucket of models.values()) finishTokens(bucket.tokens);
  // Fallback: derive id from filename "<ts>_<id>.jsonl".
  if (!id) {
    const base = filePath.replace(/\\/g, "/").split("/").pop() ?? "";
    id = base.replace(/\.jsonl$/i, "").split("_").pop() ?? base;
  }
  return { id, days, models, lastModel };
}

function sumDays(days: Iterable<{ tokens: UsageTotals; cost: number }>): { tokens: UsageTotals; cost: number } {
  const tokens = EMPTY_TOKENS();
  let cost = 0;
  for (const bucket of days) {
    addTo(tokens, bucket.tokens);
    cost += bucket.cost;
  }
  return { tokens, cost };
}

export async function aggregateUsage(): Promise<UsageReport> {
  const sessionsRoot = join(getAgentDir(), "sessions");
  const cache = getSessionCache();
  const today = localDateKey(new Date().toISOString());
  const seen = new Set<string>();

  let projectDirs: string[] = [];
  try {
    projectDirs = (await readdir(sessionsRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name);
  } catch {
    projectDirs = [];
  }

  for (const dir of projectDirs) {
    let files: string[] = [];
    try {
      files = (await readdir(join(sessionsRoot, dir))).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const file of files) {
      const filePath = join(sessionsRoot, dir, file);
      seen.add(filePath);
      let fileStat;
      try {
        fileStat = await stat(filePath);
      } catch {
        continue;
      }
      const cached = cache.get(filePath);
      let aggregate: FileAggregate;
      if (cached && cached.version === AGG_VERSION && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
        aggregate = cached.aggregate;
      } else {
        try {
          aggregate = parseFile(filePath);
        } catch {
          continue; // file removed or unreadable mid-scan
        }
        cache.set(filePath, { version: AGG_VERSION, mtimeMs: fileStat.mtimeMs, size: fileStat.size, aggregate });
      }
    }
  }

  // Drop cache entries for deleted files.
  for (const key of cache.keys()) {
    if (!seen.has(key)) cache.delete(key);
  }

  const sessions: UsageReport["sessions"] = {};
  const models: UsageReport["models"] = {};
  for (const slot of cache.values()) {
    const totals = sumDays(slot.aggregate.days.values());
    const prev = sessions[slot.aggregate.id];
    if (prev) {
      addTo(prev.tokens, totals.tokens);
      prev.cost += totals.cost;
    } else {
      sessions[slot.aggregate.id] = {
        tokens: totals.tokens,
        cost: totals.cost,
        ...(slot.aggregate.lastModel ? { model: slot.aggregate.lastModel } : {}),
      };
    }
    for (const [model, bucket] of slot.aggregate.models) {
      const cur = models[model];
      if (cur) {
        addTo(cur.tokens, bucket.tokens);
        cur.cost += bucket.cost;
      } else {
        models[model] = { tokens: { ...bucket.tokens }, cost: bucket.cost };
      }
    }
  }

  // 84-day zero-filled series ending today (local calendar) for the heatmap.
  const HEATMAP_DAYS = 84;
  const dayKeys: string[] = [];
  for (let i = HEATMAP_DAYS - 1; i >= 0; i--) {
    dayKeys.push(localDateKey(new Date(Date.now() - i * 86400000).toISOString()));
  }
  const dateIndex = new Map<string, { tokens: UsageTotals; cost: number }>();
  for (const slot of cache.values()) {
    for (const [date, bucket] of slot.aggregate.days) {
      const cur = dateIndex.get(date);
      if (cur) {
        addTo(cur.tokens, bucket.tokens);
        cur.cost += bucket.cost;
      } else {
        dateIndex.set(date, { tokens: { ...bucket.tokens }, cost: bucket.cost });
      }
    }
  }
  const days: DailyUsage[] = dayKeys.map((date) => {
    const bucket = dateIndex.get(date);
    return {
      date,
      tokens: bucket ? { ...bucket.tokens } : EMPTY_TOKENS(),
      cost: bucket?.cost ?? 0,
    };
  });

  const allTime = sumDays(dateIndex.values());
  const todayBucket = dateIndex.get(today);

  return {
    today: {
      tokens: todayBucket ? { ...todayBucket.tokens } : EMPTY_TOKENS(),
      cost: todayBucket?.cost ?? 0,
    },
    allTime: { tokens: { ...allTime.tokens }, cost: allTime.cost },
    days,
    sessions,
    models,
  };
}
