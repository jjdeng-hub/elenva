"use client";

import { RefreshCw, TrendingUp } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, PageHeader, Skeleton } from "@/components/ui/bits";
import { toast } from "@/components/ui/dialog";
import { cn } from "@/components/lib/utils";
import type { GrowthBucket, GrowthReport, GrowthWeek } from "@/lib/growth-metrics";

/** 读图结论 → chip 三档（变顺=成功绿 / 变钝=警示红 / 其余=中性） */
const VERDICT: Record<GrowthReport["headline"]["verdict"], { label: string; className: string }> = {
  smoother: { label: "变顺", className: "chip-success" },
  blunter: { label: "变钝", className: "chip-danger" },
  flat: { label: "持平", className: "chip-mono" },
  new: { label: "首周", className: "chip-mono" },
  empty: { label: "无数据", className: "chip-mono" },
  insufficient: { label: "样本不足", className: "chip-mono" },
};

const pctText = (rate: number) => `${(rate * 100).toFixed(1)}%`;

/** 近 8 周柱状图：柱高 = 轮次，柱下 = 失败率（有失败的周标红，一眼看出哪周变钝） */
function WeekBars({ weeks }: { weeks: GrowthWeek[] }) {
  const max = Math.max(1, ...weeks.map((w) => w.turns));
  return (
    <div className="flex items-end gap-2" data-testid="growth-weeks">
      {weeks.map((w) => (
        <div
          key={w.weekStart}
          className="flex min-w-0 flex-1 flex-col items-center gap-1.5"
          title={`${w.label} 起那一周${w.isCurrent ? "（未完整）" : ""}：${w.sessions} 个任务 / ${w.turns} 轮 / 失败率 ${pctText(w.failureRate)}`}
        >
          <span className={cn("text-[11px] tabular-nums", w.turns > 0 ? "text-muted" : "text-dim/60")}>{w.turns}</span>
          <div className="flex h-24 w-full items-end">
            <div
              className={cn("w-full rounded-t-sm t-base", w.isCurrent ? "bg-accent" : "bg-viz-3")}
              style={{ height: w.turns > 0 ? `${Math.max(6, Math.round((w.turns / max) * 100))}%` : "0%" }}
            />
          </div>
          <span className={cn("text-[11px] tabular-nums", w.isCurrent ? "font-medium text-fg" : "text-dim")} data-testid="growth-week-label">{w.label}</span>
          <span className={cn("text-[10px] tabular-nums", w.failedTurns > 0 ? "text-danger" : "text-dim/70")}>
            {w.turns > 0 ? pctText(w.failureRate) : "—"}
          </span>
        </div>
      ))}
    </div>
  );
}

/** 项目行里的迷你周趋势（同一色阶，高度按该项目自身峰值归一） */
function ProjectSpark({ weeks }: { weeks: GrowthWeek[] }) {
  const max = Math.max(1, ...weeks.map((w) => w.turns));
  return (
    <div className="flex h-4 items-end gap-0.5">
      {weeks.map((w) => (
        <div
          key={w.weekStart}
          className={cn("w-1.5 rounded-t-sm", w.isCurrent ? "bg-accent" : "bg-viz-4")}
          style={{ height: w.turns > 0 ? `${Math.max(15, Math.round((w.turns / max) * 100))}%` : "0%" }}
          title={`${w.label}：${w.turns} 轮`}
        />
      ))}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] text-dim">{label}</span>
      <span className="text-[16px] font-semibold leading-none tabular-nums text-fg">{value}</span>
      {hint && <span className="text-[10px] text-dim/80">{hint}</span>}
    </div>
  );
}

function BucketStats({ totals }: { totals: GrowthBucket }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
      <Stat label="任务" value={`${totals.sessions}`} hint="同期有轮次的会话" />
      <Stat label="轮次" value={`${totals.turns}`} hint="用户消息数" />
      <Stat label="失败率" value={pctText(totals.failureRate)} hint={`${totals.failedTurns} / ${totals.turns} 轮`} />
      <Stat label="轮 / 任务" value={totals.turnsPerSession.toFixed(1)} />
      <Stat label="工具 / 任务" value={totals.toolCallsPerSession.toFixed(1)} hint={`共 ${totals.toolCalls} 次`} />
    </div>
  );
}

/**
 * 成长页：近 8 周的「正在变顺还是变钝」。
 *
 * 落点理由（独立页，而非工作台小节 / 系统页）：这是**跨项目、跨 8 周的回溯**，
 * 与工作台「今日」快照的节奏不同；放工作台会稀释它的日常用途，放系统页又混淆了
 * 「本机健康」与「我的成长」。与「节律」同级、同样只读且数据源单一。
 */
export function GrowthPage() {
  const [data, setData] = useState<GrowthReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/growth", { cache: "no-store" });
      const payload = (await res.json()) as GrowthReport & { error?: string };
      if (!res.ok) throw new Error(payload.error || `读取失败（HTTP ${res.status}）`);
      setData(payload);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      toast(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const headline = data?.headline;
  const verdict = headline ? VERDICT[headline.verdict] : null;
  const projects = data?.projects.slice(0, 6) ?? [];

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="growth-page">
      <div className="page-col py-6">
        <PageHeader
          icon={<TrendingUp size={16} />}
          title="成长"
          subtitle="近 8 周：任务量 / 失败率 / 轮数 / 工具调用 —— 正在变顺还是变钝"
          actions={
            <button onClick={() => void load()} disabled={loading} className="btn btn-ghost">
              <RefreshCw size={12} className={loading ? "anim-spin" : undefined} /> 刷新
            </button>
          }
        />

        {error && !data && <EmptyState icon={<TrendingUp size={20} />} title="读取失败" hint={error} className="py-14" />}

        {!data && !error && (
          <div className="flex flex-col gap-4">
            <Skeleton className="h-56 rounded-card" />
            <Skeleton className="h-40 rounded-card" />
          </div>
        )}

        {data && (
          <div className="flex flex-col gap-4">
            <Card className="px-4 py-4">
              <div className="mb-4 flex items-start gap-2">
                <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-fg" data-testid="growth-headline">{headline?.text}</p>
                {verdict && <span className={cn("chip shrink-0", verdict.className)}>{verdict.label}</span>}
              </div>
              <WeekBars weeks={data.weeks} />
              <div className="mt-4 border-t border-line-soft pt-4">
                <BucketStats totals={data.totals} />
              </div>
            </Card>

            <Card>
              <CardHeader>
                <span className="text-accent">
                  <TrendingUp size={14} />
                </span>
                <CardTitle>按项目 · 近 8 周</CardTitle>
                <span className="ml-auto text-[11px] text-dim">
                  {data.projects.length > projects.length ? `共 ${data.projects.length} 个项目（按轮次取前 ${projects.length}）` : "按轮次排序"}
                </span>
              </CardHeader>
              {projects.length === 0 ? (
                <div className="px-4 py-6 text-center text-[12px] text-dim">这 8 周还没有可归因到项目的会话记录。</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-[12px]">
                    <thead>
                      <tr className="border-b border-line-soft text-left text-[11px] text-dim">
                        <th className="px-4 py-2 font-normal">项目</th>
                        <th className="px-3 py-2 font-normal">周趋势</th>
                        <th className="px-3 py-2 text-right font-normal">任务</th>
                        <th className="px-3 py-2 text-right font-normal">轮次</th>
                        <th className="px-3 py-2 text-right font-normal">失败率</th>
                        <th className="px-3 py-2 text-right font-normal">轮 / 任务</th>
                        <th className="px-4 py-2 text-right font-normal">工具 / 任务</th>
                      </tr>
                    </thead>
                    <tbody>
                      {projects.map((p) => (
                        <tr key={p.project} className="border-b border-line-soft last:border-0" data-testid="growth-project-row">
                          <td className="px-4 py-2.5">
                            <span className="block max-w-[220px] truncate font-medium text-fg" title={p.project}>
                              {p.label}
                            </span>
                            <span className="block max-w-[220px] truncate font-mono text-[10px] text-dim/70" title={p.project}>
                              {p.project}
                            </span>
                          </td>
                          <td className="px-3 py-2.5">
                            <ProjectSpark weeks={p.weeks} />
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-muted">{p.totals.sessions}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-muted">{p.totals.turns}</td>
                          <td className={cn("px-3 py-2.5 text-right tabular-nums", p.totals.failedTurns > 0 ? "text-fg" : "text-dim")}>
                            {pctText(p.totals.failureRate)}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-muted">{p.totals.turnsPerSession.toFixed(1)}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-muted">{p.totals.toolCallsPerSession.toFixed(1)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="border-t border-line-soft px-4 py-2 text-[11px] leading-relaxed text-dim">
                口径：轮次 = 用户消息数；失败 = 该轮出现 provider error（用户主动中断 aborted 不计）；任务 = 会话；
                项目 = 会话 cwd（取末段展示，worktree 不归并）。本周为当前**未完整**的一周，
                周环比**按已过同等时段对齐上周同期**（对齐到「上周一 00:00 → 上周一 + 本周已过时长」），
                不再直接与完整上周比；任一侧轮数 &lt; {data.comparison.minTurns} 时不给趋势结论（标「样本不足」）。
                工具调用 = assistant 的 toolCall 块。未做「任务类型」分类（无可靠标签），用「项目 × 周」粗分组代替。
              </div>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
