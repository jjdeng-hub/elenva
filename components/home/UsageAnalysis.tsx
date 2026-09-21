"use client";

import { useMemo } from "react";
import { cn } from "@/components/lib/utils";
import { formatCost, formatTokens } from "@/lib/format";
import type { SessionInfo } from "@/lib/types";
import type { UsageReport } from "@/lib/usage-aggregate";

function shortModel(model?: string): string {
  if (!model) return "未知模型";
  const [, id = model] = model.split("/");
  return id;
}

/** Token 构成堆叠条 + 分项数值 */
function CompositionBar({ report }: { report: UsageReport }) {
  const t = report.allTime.tokens;
  // 颜色走 viz 色阶（2026-09-21）：纯红只给「输出」这个锚点；缓存两段用灰阶，
  // 大面积（缓存读取）取最浅一档保证不吵；相邻段之间加 1px 面板色分隔（见下）。
  const parts = [
    { key: "输入", value: t.input, color: "var(--viz-3)" },
    { key: "输出", value: t.output, color: "var(--viz-1)" },
    { key: "缓存读取", value: t.cacheRead, color: "var(--viz-4)" },
    { key: "缓存写入", value: t.cacheWrite, color: "var(--viz-2)" },
  ];
  const total = Math.max(t.total, 1);
  return (
    <div>
      <div
        className="flex h-2.5 w-full overflow-hidden rounded-full bg-panel-2"
        style={{ boxShadow: "inset 0 0 0 1px var(--line-soft)" }}
      >
        {parts
          .filter((p) => p.value > 0)
          .map((p, i) => (
            <div
              key={p.key}
              className="shrink-0"
              style={{
                width: `${(p.value / total) * 100}%`,
                minWidth: 2,
                backgroundColor: p.color,
                boxShadow: i > 0 ? "inset 1px 0 0 0 var(--panel)" : undefined,
              }}
              title={`${p.key} ${formatTokens(p.value)}（${Math.round((p.value / total) * 100)}%）`}
            />
          ))}
      </div>
      <div className="mt-2 space-y-1">
        {parts
          .filter((p) => p.value > 0 || p.key === "输入" || p.key === "输出")
          .map((p) => (
            <div key={p.key} className="flex items-center gap-1.5 text-[12px]">
              <span className="size-2 rounded-[2px]" style={{ backgroundColor: p.color }} />
              <span className="text-dim">{p.key}</span>
              <span className="ml-auto tabular-nums text-muted">{formatTokens(p.value)}</span>
              <span className="w-10 shrink-0 text-right tabular-nums text-dim">
                {Math.round((p.value / total) * 100)}%
              </span>
            </div>
          ))}
      </div>
    </div>
  );
}

/**
 * 用量分析（右列紧凑版）。
 *
 * 2026-09-14 改版：原先它是**底部通栏**的三列大卡（成本趋势 / Token 构成 / Top 会话），
 * 而「活跃热力图」卡被撤掉后，它整个搬进右列、与「今日概览」平分高度。
 *
 * 内容做了去重 —— 右列两卡各司其职，别互相重复：
 * · 今日概览管 **今日 + 近 14 日成本曲线**（那里已有迷你柱状图）
 * · 这里管 **累计构成 + 谁在烧钱**（Top 会话）
 * 所以成本趋势柱状图不再出现在本卡；模型分布也不在这里（下方有「模型用量排行」专卡）。
 */
export function UsageAnalysis({
  report,
  sessions,
  onOpenSession,
  className,
}: {
  report: UsageReport;
  sessions: SessionInfo[];
  onOpenSession: (s: SessionInfo) => void;
  className?: string;
}) {
  const nameById = useMemo(() => {
    const map = new Map<string, SessionInfo>();
    for (const s of sessions) map.set(s.id, s);
    return map;
  }, [sessions]);

  const topSessions = useMemo(
    () =>
      Object.entries(report.sessions)
        .sort((a, b) => b[1].cost - a[1].cost)
        .slice(0, 3),
    [report.sessions],
  );

  return (
    <div className={cn("card flex flex-col px-4 py-3.5", className)}>
      <div className="flex shrink-0 items-center justify-between">
        <h2 className="text-[14px] font-semibold">用量分析</h2>
        <span className="text-[12px] text-dim">
          累计 {formatTokens(report.allTime.tokens.total)} tok · {formatCost(report.allTime.cost)}
        </span>
      </div>

      <div className="mt-3 shrink-0">
        <div className="text-[12px] font-medium text-dim">Token 构成（累计）</div>
        <div className="mt-2">
          <CompositionBar report={report} />
        </div>
      </div>

      <div className="mt-3 flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 text-[12px] font-medium text-dim">消耗 Top 会话</div>
        <div className="mt-1.5 min-h-0 flex-1 space-y-1 overflow-y-auto">
          {topSessions.length === 0 && <div className="text-[12px] text-dim">暂无数据</div>}
          {topSessions.map(([id, u], i) => {
            const s = nameById.get(id);
            const name = s?.name || s?.firstMessage || "(无标题)";
            return (
              <button
                key={id}
                onClick={() => s && onOpenSession(s)}
                className="flex w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 text-left t-fast hover:bg-hover"
              >
                <span
                  className={
                    "flex size-4.5 shrink-0 items-center justify-center rounded-sm text-[10px] font-bold " +
                    (i === 0 ? "bg-accent text-accent-fg" : "bg-panel-2 text-dim")
                  }
                >
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-medium">{name}</span>
                  <span className="block truncate text-[12px] text-dim" title={u.model}>
                    {shortModel(u.model)}
                  </span>
                </span>
                <span className="shrink-0 text-[12px] tabular-nums text-muted">
                  {formatTokens(u.tokens.total)}
                  <span className="ml-1 text-dim">{formatCost(u.cost)}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
