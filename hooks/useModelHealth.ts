"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * 模型健康度的**选型侧**只读视图（模块 6 修复轮 · C）。
 *
 * 数据源就是 `/api/model-health`（服务端 60 秒缓存，口径见 `lib/model-health.ts`），
 * 不新造统计。这里只取「选型那一刻需要的那点数」：状态 + 失败面，
 * 让 `status=failing` 的模型在选择器 / 模型库里**可见**，而不是静默可选。
 *
 * 默认懒加载：选择器菜单打开、模型库加载时各拉一次；失败时返回空表
 * （健康度只做提示，不该挡住选型本身）。
 */

export type ModelHealthStatus = "ok" | "unstable" | "failing";

export interface ModelHealthSummary {
  status: ModelHealthStatus;
  calls: number;
  failures: number;
  successRate: number;
  lastFailureAt: string | null;
  lastError: string | null;
}

export type ModelHealthMap = Record<string, ModelHealthSummary>;

interface HealthPayload {
  models?: Array<{
    provider?: string;
    model?: string;
    key?: string;
    status?: ModelHealthStatus;
    calls?: number;
    failures?: number;
    successRate?: number;
    lastFailureAt?: string | null;
    lastError?: string | null;
  }>;
}

export function useModelHealth(options: { enabled?: boolean } = {}): {
  health: ModelHealthMap;
  reload: () => Promise<void>;
} {
  const enabled = options.enabled !== false;
  const [health, setHealth] = useState<ModelHealthMap>({});

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/model-health", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as HealthPayload;
      const next: ModelHealthMap = {};
      for (const entry of data.models ?? []) {
        const key = entry.key ?? `${entry.provider}/${entry.model}`;
        if (!key || !entry.status) continue;
        next[key] = {
          status: entry.status,
          calls: entry.calls ?? 0,
          failures: entry.failures ?? 0,
          successRate: entry.successRate ?? 1,
          lastFailureAt: entry.lastFailureAt ?? null,
          lastError: entry.lastError ?? null,
        };
      }
      setHealth(next);
    } catch {
      /* 健康度拿不到就不标记，不阻断选型 */
    }
  }, []);

  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);

  return { health, reload };
}

/** 一行提示文案：故障模型的最近失败（给 title / 确认框用） */
export function failingModelNote(summary: ModelHealthSummary | undefined): string {
  if (!summary) return "";
  const pct = Math.round(summary.successRate * 100);
  const base = `近 14 天成功率 ${pct}%（${summary.calls} 次调用 / ${summary.failures} 次失败）`;
  return summary.lastError ? `${base}，最近失败：${summary.lastError}` : base;
}
