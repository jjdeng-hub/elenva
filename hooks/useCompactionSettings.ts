"use client";

import { useEffect, useState } from "react";

/**
 * 压缩设置（供「上下文窗口」相关 UI 显示真实阈值）。
 *
 * 为什么要读它：内核的自动压缩判定只有一条 ——
 *   contextTokens > contextWindow - reserveTokens
 *   （见 pi-coding-agent 的 core/compaction/compaction.js 的 shouldCompact）
 * 默认 reserveTokens = 16384。所以 1M 窗口的真实阈值是 983,616 tokens（98.4%）。
 *
 * 此前 UI 用「≥75% 建议压缩」这种拍脑袋阈值催用户手动压缩 —— 在 76% 时
 * 离自动触发还有二十多万 token，提前压缩要花一次模型调用、还会丢掉上下文。
 * 正确做法是把**内核的真实阈值**显示出来，让用户知道「不用管，内核会处理」。
 */

/** 内核默认值（docs/compaction.md 的 settings 表） */
export const COMPACTION_DEFAULTS = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
} as const;

type Settings = {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
};

let cached: Promise<Settings> | null = null;

function loadSettings(): Promise<Settings> {
  if (!cached) {
    cached = fetch("/api/pi-settings", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { settings?: { compaction?: Partial<Settings> } } | null) => {
        const c = d?.settings?.compaction ?? {};
        return {
          enabled: c.enabled ?? COMPACTION_DEFAULTS.enabled,
          reserveTokens: c.reserveTokens ?? COMPACTION_DEFAULTS.reserveTokens,
          keepRecentTokens: c.keepRecentTokens ?? COMPACTION_DEFAULTS.keepRecentTokens,
        };
      })
      .catch(() => ({
        enabled: COMPACTION_DEFAULTS.enabled,
        reserveTokens: COMPACTION_DEFAULTS.reserveTokens,
        keepRecentTokens: COMPACTION_DEFAULTS.keepRecentTokens,
      }));
  }
  return cached;
}

/** 测试或设置变更后可清除缓存 */
export function invalidateCompactionSettingsCache(): void {
  cached = null;
}

export function useCompactionSettings(): Settings {
  const [settings, setSettings] = useState<Settings>({
    enabled: COMPACTION_DEFAULTS.enabled,
    reserveTokens: COMPACTION_DEFAULTS.reserveTokens,
    keepRecentTokens: COMPACTION_DEFAULTS.keepRecentTokens,
  });
  useEffect(() => {
    let alive = true;
    void loadSettings().then((s) => {
      if (alive) setSettings(s);
    });
    return () => {
      alive = false;
    };
  }, []);
  return settings;
}

/** 自动压缩的触发 token 数（窗口 − 预留），以及它对应的百分比 */
export function compactionTrigger(contextWindow: number, reserveTokens: number): {
  tokens: number;
  percent: number;
} {
  const tokens = Math.max(0, contextWindow - reserveTokens);
  const percent = contextWindow > 0 ? Math.round((tokens / contextWindow) * 100) : 0;
  return { tokens, percent };
}
