"use client";

import { cn } from "@/components/lib/utils";
import { formatCost, formatTokens } from "@/lib/format";
import type { UsageReport } from "@/lib/usage-aggregate";

/** 右栏紧凑版：今日 token/成本 + 近 14 日成本迷你柱。
 *  构成条与累计值都在下方「用量分析」里，此处不重复。 */
export function TodayOverview({ report, className }: { report: UsageReport; className?: string }) {
  const days = report.days.slice(-14);
  const max = Math.max(...days.map((d) => d.cost), 1e-9);
  const t = report.today.tokens;

  return (
    <div className={cn("card flex flex-col px-4 py-3.5", className)}>
      <div className="flex shrink-0 items-center justify-between">
        <h2 className="text-[14px] font-semibold">今日概览</h2>
        {/* 累计值不在这里重复 —— 右列下方「用量分析」头部已是累计口径 */}
        <span className="text-[12px] text-dim">近 14 日</span>
      </div>
      <div className="mt-2 flex items-end gap-6">
        <div>
          <div className="text-[12px] text-dim">今日 Token</div>
          <div className="text-[20px] font-bold leading-tight tabular-nums">{formatTokens(t.total)}</div>
          <div className="text-[12px] text-dim tabular-nums">
            入 {formatTokens(t.input)} · 出 {formatTokens(t.output)}
          </div>
        </div>
          <div>
            <div className="text-[12px] text-dim">今日成本</div>
            <div className="text-[20px] font-bold leading-tight tabular-nums">{formatCost(report.today.cost)}</div>
            <div className="text-[12px] text-dim tabular-nums">峰值 {formatCost(Math.max(...days.map((d) => d.cost)))}</div>
          </div>
      </div>
      {/* 柱状图区吃满剩余高度：卡片被拉到与左列等高时，增长的是图形而不是空白 */}
      <div className="mt-2.5 flex min-h-0 flex-1 flex-col justify-end">
        <svg viewBox={`0 0 100 22`} className="h-full max-h-24 w-full" preserveAspectRatio="none">
          {/* 底槽 + 只画有值的日：成本为 0 的日子若也画 h=1 的柱，
              在拉伸坐标系（preserveAspectRatio=none）下会变成一排误导性的虚线段 */}
          <rect x={0} y={21.4} width={100} height={0.6} fill="var(--panel-2)" />
          {days.map((d, i) => {
            const bw = (100 - 1.2 * (days.length - 1)) / days.length;
            if (d.cost <= 0) return null;
            const h = Math.max(2.5, (d.cost / max) * 20);
            return (
              <rect
                key={d.date}
                x={i * (bw + 1.2)}
                y={22 - h}
                width={bw}
                height={h}
                rx={0.6}
                fill="var(--accent)"
                opacity={i === days.length - 1 ? 1 : 0.6}
              >
                <title>{`${d.date}  ${formatCost(d.cost)} · ${formatTokens(d.tokens.total)} tokens`}</title>
              </rect>
            );
          })}
        </svg>
        <div className="mt-0.5 flex justify-between text-[11px] text-dim">
          <span>{days[0]?.date.slice(5)}</span>
          <span>近 14 日成本</span>
          <span>今天</span>
        </div>
      </div>
      {/* 累计构成条已移除：与下方「用量分析」的 Token 构成重复，还会挤占柱状图空间 ——
          右列两卡各管一摊，不再互相重复 */}
    </div>
  );
}
