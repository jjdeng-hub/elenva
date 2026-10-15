"use client";

import { ChevronDown, History, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "@/components/lib/utils";
import { EmptyState, ListSkeleton, PageHeader } from "@/components/ui/bits";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { relTime } from "@/lib/format";
import type { ApprovalDecision, ApprovalLogEntry, ApprovalSource } from "@/lib/approval-log";

/**
 * 审批历史（模块 5「治理与安全」· 第 1 轮）。
 *
 * 「现在在等你什么」在会话页的待审批区；这里回答的是过去时 ——
 * 「上次这种操作是什么结果、为什么」。只读列表：日志由宿主护栏在决策落点追写。
 */

const PAGE_SIZE = 50;

const DECISION_META: Record<ApprovalDecision, { label: string; chip: string }> = {
  approved: { label: "批准", chip: "chip-success" },
  denied: { label: "拒绝", chip: "chip-danger" },
  timeout: { label: "超时", chip: "chip" },
  queued: { label: "入队", chip: "chip" },
};

const SOURCE_LABEL: Record<ApprovalSource, string> = {
  dialog: "弹窗",
  queue: "队列",
  auto: "自动",
};

const KIND_LABEL: Record<ApprovalLogEntry["kind"], string> = {
  tool: "工具",
  plan: "计划",
};

type FilterDecision = "all" | ApprovalDecision;

/** 筛选项与日志的 decision 取值一一对应；「入队」不单列 —— 它不改变「是否被拦」的判断 */
const FILTERS: { value: FilterDecision; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "approved", label: "批准" },
  { value: "denied", label: "拒绝" },
  { value: "timeout", label: "超时" },
];

function absTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || "—";
  return d.toLocaleString("zh-CN", { hour12: false });
}

export function ApprovalHistoryPage({
  onOpenSession,
}: {
  /** 点会话 id 跳到对应会话（可选：没有会话时只显示 id） */
  onOpenSession?: (sessionId: string) => void;
}) {
  const [decision, setDecision] = useState<FilterDecision>("all");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [entries, setEntries] = useState<ApprovalLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (filter: FilterDecision, take: number) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/approvals/history?decision=${filter}&limit=${take}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { entries?: ApprovalLogEntry[]; total?: number };
      setEntries(Array.isArray(data.entries) ? data.entries : []);
      setTotal(typeof data.total === "number" ? data.total : 0);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setEntries([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(decision, limit);
  }, [decision, limit, load]);

  const pickFilter = (value: FilterDecision) => {
    // 换筛选回到第一页：不然「拒绝」页会沿用「全部」页翻出来的 limit
    setLimit(PAGE_SIZE);
    setDecision(value);
  };

  const hasMore = entries.length < total;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
      <div className="mx-auto w-full max-w-4xl">
        <PageHeader
          icon={<History size={16} />}
          title="审批历史"
          subtitle="危险操作的批准 / 拒绝 / 超时 / 入队记录（最近 1000 条）"
          actions={
            <button
              onClick={() => void load(decision, limit)}
              disabled={loading}
              className="btn btn-ghost btn-sm"
              title="重新读取日志"
            >
              {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              刷新
            </button>
          }
        />

        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {FILTERS.map((item) => (
            <button
              key={item.value}
              onClick={() => pickFilter(item.value)}
              aria-pressed={decision === item.value}
              className={cn(
                "cursor-pointer t-fast",
                "chip",
                decision === item.value ? "chip-accent" : "hover:text-fg",
              )}
            >
              {item.label}
            </button>
          ))}
          {!loading && <span className="ml-auto text-[11px] text-dim">共 {total} 条</span>}
        </div>

        <Card>
          <CardHeader>
            <CardTitle>决策记录</CardTitle>
            <span className="ml-auto text-[11px] text-dim">新 → 旧</span>
          </CardHeader>

          {loading && entries.length === 0 ? (
            <ListSkeleton rows={5} />
          ) : error ? (
            <div className="px-4 py-6 text-[12px]">
              <div className="text-danger">读取审批历史失败：{error}</div>
              <button onClick={() => void load(decision, limit)} className="btn btn-ghost btn-sm mt-3">
                重试
              </button>
            </div>
          ) : entries.length === 0 ? (
            <EmptyState
              icon={<History size={16} />}
              title="还没有审批记录"
              hint={
                decision === "all"
                  ? "危险操作被批准、拒绝、超时或入队时，都会在这里留一条记录。"
                  : `当前筛选（${FILTERS.find((f) => f.value === decision)?.label}）下没有记录，换一个筛选看看。`
              }
            />
          ) : (
            <>
              <ul>
                {entries.map((entry, index) => (
                  <ApprovalRow
                    key={`${entry.ts}-${entry.tool}-${index}`}
                    entry={entry}
                    onOpenSession={onOpenSession}
                  />
                ))}
              </ul>
              {hasMore && (
                <div className="flex justify-center px-4 py-3">
                  <button
                    onClick={() => setLimit((n) => n + PAGE_SIZE)}
                    disabled={loading}
                    className="btn btn-ghost btn-sm"
                  >
                    {loading ? <Loader2 size={12} className="animate-spin" /> : <ChevronDown size={12} />}
                    加载更多（还有 {total - entries.length} 条）
                  </button>
                </div>
              )}
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

function ApprovalRow({
  entry,
  onOpenSession,
}: {
  entry: ApprovalLogEntry;
  onOpenSession?: (sessionId: string) => void;
}) {
  const meta = DECISION_META[entry.decision] ?? DECISION_META.timeout;
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1 border-b border-line-soft px-4 py-3 last:border-b-0">
      <span
        className="w-20 shrink-0 pt-0.5 text-[11px] tabular-nums text-dim"
        title={absTime(entry.ts)}
      >
        {relTime(entry.ts)}
      </span>

      <span className={cn("chip shrink-0", meta.chip)}>{meta.label}</span>
      <span className="chip shrink-0">{KIND_LABEL[entry.kind]}</span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-mono text-[12px] text-fg">{entry.tool || "—"}</span>
          <span className="chip shrink-0" title="决策发生的位置">
            {SOURCE_LABEL[entry.source] ?? entry.source}
          </span>
          {entry.sessionId ? (
            <button
              onClick={() => onOpenSession?.(entry.sessionId)}
              title={entry.sessionId}
              className={cn(
                "font-mono text-[11px] text-dim",
                onOpenSession ? "cursor-pointer t-fast hover:text-accent" : "cursor-default",
              )}
            >
              {entry.sessionId.slice(0, 8)}
            </button>
          ) : (
            <span className="text-[11px] text-dim">无会话</span>
          )}
        </div>
        {entry.summary && (
          <div className="mt-1 truncate font-mono text-[11px] text-muted" title={entry.summary}>
            {entry.summary}
          </div>
        )}
        {entry.reason && (
          <div className="mt-0.5 text-[11px] leading-relaxed text-dim">理由：{entry.reason}</div>
        )}
      </div>
    </li>
  );
}
