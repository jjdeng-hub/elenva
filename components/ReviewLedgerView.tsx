"use client";

import { ClipboardList, GraduationCap, History, Loader2, MinusCircle, RefreshCw, Upload } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "@/components/lib/utils";
import { EmptyState, Skeleton } from "@/components/ui/bits";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import type { ReviewLedger, ReviewLedgerGroupBy, ReviewLedgerWorkItem } from "@/lib/review-ledger";

/**
 * 复台账（模块 7「身份与成长」第 2 轮）。
 *
 * 自动复盘一直在跑，产出却散在记忆文件与工作记录里。这里把三类痕迹收到一条时间线上：
 *  - 学到（记忆条目 created 落在当天）/ 更新（last 被整理刷新）/ 去掉（快照差分的近似痕迹）
 *  - 工作（同一天的工作记录条目）—— 与记忆变更对照，回答「那天到底在忙什么、留下什么」。
 *
 * 只读视图：数据由 `GET /api/review-ledger` 给出，绝不回写记忆扩展的任何文件。
 * 交互克制：个人工作台自用，只做「按天/周聚合 + 点回记忆」，不做热力图/编辑器。
 */

const STATUS_META: Record<string, { label: string; chip: string }> = {
  done: { label: "收尾", chip: "chip-success" },
  doing: { label: "进行中", chip: "chip-accent" },
  blocked: { label: "受阻", chip: "chip-danger" },
};

export function ReviewLedgerView({ onOpenMemoryEntry }: { onOpenMemoryEntry: (fileId: string) => void }) {
  const [groupBy, setGroupBy] = useState<ReviewLedgerGroupBy>("day");
  const [data, setData] = useState<ReviewLedger | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (group: ReviewLedgerGroupBy) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/review-ledger?group=${group}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as ReviewLedger);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(groupBy);
  }, [groupBy, load]);

  const summary = data?.summary;

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader>
          <History size={12} className="text-dim" />
          <CardTitle>复台账</CardTitle>
          {summary && (
            <span className="ml-1 text-[11px] tabular-nums text-dim">
              {summary.from ?? "—"} ~ {summary.to ?? "—"}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <div className="flex items-center rounded-md border border-line bg-panel-2 p-0.5">
              <SegButton active={groupBy === "day"} onClick={() => setGroupBy("day")}>
                天
              </SegButton>
              <SegButton active={groupBy === "week"} onClick={() => setGroupBy("week")}>
                周
              </SegButton>
            </div>
            <button
              onClick={() => void load(groupBy)}
              disabled={loading}
              className="btn btn-icon"
              title="重新读取记忆与工作记录"
              aria-label="刷新"
            >
              <RefreshCw size={12} className={cn(loading && "anim-spin")} />
            </button>
          </div>
        </CardHeader>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <SummaryStat icon={<GraduationCap size={12} />} label="学到" value={summary?.learned ?? 0} tone="accent" />
          <SummaryStat icon={<Upload size={12} />} label="更新" value={summary?.touched ?? 0} />
          <SummaryStat icon={<MinusCircle size={12} />} label="去掉" value={summary?.removed ?? 0} />
          <SummaryStat icon={<ClipboardList size={12} />} label="工作" value={summary?.work ?? 0} />
          {data?.approximate && <span className="chip chip-warn">近似重建</span>}
        </div>
        {data && (
          <div className="border-t border-line-soft px-4 py-2.5 text-[11px] leading-relaxed text-dim">
            {data.notes[0]}
            {data.notes[2] && <span className="ml-1 text-dim/80">{data.notes[2]}</span>}
          </div>
        )}
      </Card>

      {error && (
        <Card className="px-4 py-3 text-[12px] text-danger">读复台账失败：{error}</Card>
      )}

      {loading && !data && (
        <Card className="flex flex-col gap-3 px-4 py-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </Card>
      )}

      {data && data.buckets.length === 0 && (
        <Card>
          <EmptyState
            icon={<ClipboardList size={20} />}
            title="还没有可看的复盘痕迹"
            hint={
              data.memoryFound
                ? "记忆文件存在，但条目还没带 created/last 元数据，工作记录也是空的。跑过一轮复盘后回来看。"
                : "没读到记忆文件 —— 确认 pi-hermes-memory 扩展已安装、且会话里产生过记忆或工作记录。"
            }
          />
        </Card>
      )}

      <div className="flex flex-col gap-3">
        {data?.buckets.map((bucket) => (
          <Card key={bucket.key} className="overflow-hidden">
            <div className="flex flex-wrap items-center gap-2 border-b border-line-soft bg-panel-2/50 px-4 py-2">
              <span className="font-mono text-[12px] font-medium text-fg">{bucket.label}</span>
              {bucket.counts.learned > 0 && <span className="chip chip-accent">学到 {bucket.counts.learned}</span>}
              {bucket.counts.touched > 0 && <span className="chip">更新 {bucket.counts.touched}</span>}
              {bucket.counts.removed > 0 && <span className="chip chip-warn">去掉 {bucket.counts.removed}</span>}
              {bucket.counts.work > 0 && <span className="chip">工作 {bucket.counts.work}</span>}
            </div>
            <div className="flex flex-col gap-3 px-4 py-3">
              {bucket.learned.length > 0 && (
                <Section icon={<GraduationCap size={12} />} title="学到" tone="accent">
                  {bucket.learned.map((item, i) => (
                    <MemoryRow key={i} label={item.label} preview={item.preview} created={item.created} last={item.last} onOpen={() => onOpenMemoryEntry(item.file)} />
                  ))}
                </Section>
              )}
              {bucket.touched.length > 0 && (
                <Section icon={<Upload size={12} />} title="更新">
                  {bucket.touched.map((item, i) => (
                    <MemoryRow key={i} label={item.label} preview={item.preview} created={item.created} last={item.last} onOpen={() => onOpenMemoryEntry(item.file)} />
                  ))}
                </Section>
              )}
              {bucket.removed.length > 0 && (
                <Section icon={<MinusCircle size={12} />} title="去掉（近似）" tone="warn">
                  {bucket.removed.map((item, i) => (
                    <div key={i} className="flex items-start gap-2 py-1">
                      <span className="chip chip-mono mt-0.5 shrink-0">{item.label}</span>
                      <span className="min-w-0 flex-1 text-[12px] leading-relaxed text-dim line-through decoration-dim/40">
                        {item.preview}
                      </span>
                    </div>
                  ))}
                </Section>
              )}
              {bucket.work.length > 0 && (
                <Section icon={<ClipboardList size={12} />} title="工作">
                  {bucket.work.map((item, i) => (
                    <WorkRow key={i} item={item} />
                  ))}
                </Section>
              )}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function SegButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "h-5 cursor-pointer rounded-sm px-2 text-[11px] t-fast",
        active ? "bg-active font-medium text-accent" : "text-muted hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

function SummaryStat({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: number; tone?: "accent" }) {
  return (
    <span className="flex items-center gap-1.5 text-[12px]">
      <span className={cn("text-dim", tone === "accent" && "text-accent")}>{icon}</span>
      <span className="text-dim">{label}</span>
      <b className={cn("font-medium tabular-nums text-fg", tone === "accent" && "text-accent")}>{value}</b>
    </span>
  );
}

function Section({ icon, title, tone, children }: { icon: React.ReactNode; title: string; tone?: "accent" | "warn"; children: React.ReactNode }) {
  return (
    <div>
      <div
        className={cn(
          "mb-1 flex items-center gap-1.5 text-[11px] font-medium",
          tone === "accent" ? "text-accent" : tone === "warn" ? "text-warn" : "text-muted",
        )}
      >
        {icon}
        {title}
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

function MemoryRow({
  label,
  preview,
  created,
  last,
  onOpen,
}: {
  label: string;
  preview: string;
  created: string | null;
  last: string | null;
  onOpen: () => void;
}) {
  return (
    <button
      onClick={onOpen}
      title="回到「Agent 记忆」里对应的文件"
      className="flex w-full cursor-pointer items-start gap-2 rounded-md px-1 py-1 text-left t-fast hover:bg-panel-2"
    >
      <span className="chip chip-mono mt-0.5 shrink-0">{label}</span>
      <span className="min-w-0 flex-1 text-[12px] leading-relaxed text-fg">{preview}</span>
      <span className="mt-0.5 shrink-0 font-mono text-[10px] tabular-nums text-dim/70">
        {created && last && created !== last ? `${created} → ${last}` : created}
      </span>
    </button>
  );
}

function WorkRow({ item }: { item: ReviewLedgerWorkItem }) {
  const status = item.status ? STATUS_META[item.status] : null;
  return (
    <div className="flex flex-col gap-0.5 border-l border-line-soft py-1 pl-2.5">
      <div className="flex items-center gap-2">
        <span className="truncate text-[12px] text-fg">{item.title}</span>
        {status && <span className={cn("chip", status.chip)}>{status.label}</span>}
        <span className="ml-auto shrink-0 font-mono text-[10px] text-dim/70">{item.source}</span>
      </div>
      {item.todo && (
        <div className="truncate text-[11px] text-dim" title={item.todo}>
          待办：{item.todo}
        </div>
      )}
    </div>
  );
}
