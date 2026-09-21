"use client";

import { Ban, Bot, ChevronRight, CornerDownRight, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/components/lib/utils";
import { toast } from "@/components/ui/dialog";

/**
 * 子代理运行监控。
 *
 * 原来这一页只能「配」profile，看不到「谁在跑」——而按本项目「编排与可见性」的定位，
 * 监控比重配置更要紧：agent 派生出去的子代理如果在跑，用户应该能一眼看到、能插话纠偏、能中止。
 *
 * 数据源 /api/subagents/runs（内存快照，只读，不触发内核调用）。
 */

type SubagentRun = {
  sessionId: string;
  parentSessionId: string;
  profile: string;
  description: string;
  task: string;
  runInBackground: boolean;
  status: "starting" | "running" | "completed" | "failed";
  createdAt: string;
  completedAt?: string;
  error?: string;
};

/** 并发上限与服务端 MAX_CONCURRENT_SUBAGENTS 保持一致 */
const MAX_CONCURRENT = 4;
const POLL_MS = 3000;

const STATUS_LABEL: Record<SubagentRun["status"], string> = {
  starting: "启动中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
};

function elapsed(run: SubagentRun): string {
  const start = new Date(run.createdAt).getTime();
  const end = run.completedAt ? new Date(run.completedAt).getTime() : Date.now();
  if (!Number.isFinite(start)) return "—";
  const sec = Math.max(0, Math.round((end - start) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m${String(sec % 60).padStart(2, "0")}s`;
  return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}m`;
}

export function SubagentRunMonitor() {
  const [runs, setRuns] = useState<SubagentRun[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [steerDraft, setSteerDraft] = useState("");
  const activeRef = useRef(0);

  const load = useCallback(async () => {
    try {
      const d = (await fetch("/api/subagents/runs", { cache: "no-store" }).then((r) => r.json())) as {
        runs?: SubagentRun[];
      };
      const list = d.runs ?? [];
      activeRef.current = list.filter((r) => r.status === "running" || r.status === "starting").length;
      setRuns(list);
    } catch {
      /* 网络抖动时保留上一次快照 */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const act = async (sessionId: string, action: "steer" | "abort", message?: string) => {
    setBusy(sessionId);
    try {
      const res = await fetch(`/api/subagents/${encodeURIComponent(sessionId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, message }),
      });
      const d = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(d.error || `操作失败（HTTP ${res.status}）`);
      toast(action === "steer" ? "已插话" : "已请求中止");
      setSteerDraft("");
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const active = runs?.filter((r) => r.status === "running" || r.status === "starting") ?? [];
  const finished = runs?.filter((r) => r.status !== "running" && r.status !== "starting") ?? [];

  return (
    <div className="mb-5 rounded-card border border-line bg-panel" data-testid="run-monitor">
      <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-4 py-3">
        <span className="text-[13px] font-semibold text-fg">运行监控</span>
        <span className="text-[11px] text-dim">
          {active.length > 0 ? `${active.length} 个进行中` : "当前空闲"} · 最多 {MAX_CONCURRENT} 个并发
        </span>
        <button
          onClick={() => void load()}
          className="btn btn-sm btn-subtle ml-auto"
          title="立即刷新"
        >
          <RefreshCw size={10} /> 刷新
        </button>
      </div>

      {runs === null && (
        <div className="flex items-center gap-2 px-4 py-4 text-[12px] text-dim">
          <Loader2 size={12} className="anim-spin" /> 读取运行状态…
        </div>
      )}

      {runs !== null && active.length === 0 && finished.length === 0 && (
        <div className="px-4 py-4 text-[12px] leading-relaxed text-dim">
          还没有子代理运行记录。主会话调用子代理工具（或扩展的 Agent 工具）时，这里会实时显示
          子代理的配置、任务、耗时，并可直接插话纠偏或中止。
        </div>
      )}

      {active.map((run) => (
        <div key={run.sessionId} className="border-t border-line-soft px-4 py-3 first:border-t-0">
          <div className="flex flex-wrap items-center gap-2">
            <Loader2 size={12} className="shrink-0 anim-spin text-accent" />
            <span className="shrink-0 text-[13px] font-semibold text-fg">{run.profile}</span>
            {run.runInBackground && <span className="chip shrink-0">后台</span>}
            <span className="chip chip-accent shrink-0">{STATUS_LABEL[run.status]}</span>
            <span className="shrink-0 font-mono text-[11px] text-dim tabular-nums">{elapsed(run)}</span>
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              <button
                onClick={() => {
                  setExpanded(expanded === run.sessionId ? null : run.sessionId);
                  setSteerDraft("");
                }}
                className="btn btn-ghost"
              >
                <ChevronRight size={12} className={cn("transition-transform", expanded === run.sessionId && "rotate-90")} />
                详情
              </button>
              <button
                onClick={() => void act(run.sessionId, "abort")}
                disabled={busy === run.sessionId}
                className="btn btn-ghost text-danger"
              >
                <Ban size={12} /> 中止
              </button>
            </div>
          </div>
          {run.description && <div className="mt-1 text-[12px] font-medium text-muted">{run.description}</div>}
          <div className="mt-1 line-clamp-2 text-[12px] text-dim">{run.task}</div>
          <div className="mt-0.5 font-mono text-[10px] text-dim/70">
            主会话 {run.parentSessionId.slice(0, 8)} · 子会话 {run.sessionId.slice(0, 8)}
          </div>

          {expanded === run.sessionId && (
            <div className="mt-2 rounded-lg border border-line bg-panel-2 p-2.5">
              <div className="text-[11px] font-semibold text-muted">任务全文</div>
              <pre className="mt-1 max-h-40 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-dim">
                {run.task}
              </pre>
              <div className="mt-2 flex gap-2">
                <input
                  value={steerDraft}
                  onChange={(e) => setSteerDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && steerDraft.trim()) void act(run.sessionId, "steer", steerDraft.trim());
                  }}
                  placeholder="给它插一句话纠偏…"
                  className="h-8 min-w-0 flex-1 rounded-md border border-line bg-panel px-2.5 text-[12px] text-fg outline-none focus:border-accent/60"
                />
                <button
                  onClick={() => steerDraft.trim() && void act(run.sessionId, "steer", steerDraft.trim())}
                  disabled={!steerDraft.trim() || busy === run.sessionId}
                  className="btn btn-primary shrink-0"
                >
                  <CornerDownRight size={12} /> 插话
                </button>
              </div>
            </div>
          )}
        </div>
      ))}

      {finished.length > 0 && (
        <div className="border-t border-line-soft px-4 py-3">
          <div className="mb-1.5 text-[11px] font-semibold text-dim">最近结束</div>
          <div className="flex flex-col gap-1">
            {finished.map((run) => (
              <div key={run.sessionId} className="flex items-center gap-2 text-[12px]">
                <Bot size={12} className="shrink-0 text-dim" />
                <span className="shrink-0 text-muted">{run.profile}</span>
                <span className="min-w-0 flex-1 truncate text-dim/80">{run.description || run.task}</span>
                <span
                  className={cn(
                    "chip shrink-0",
                    run.status === "failed" ? "chip-danger" : "chip-success",
                  )}
                >
                  {STATUS_LABEL[run.status]}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-dim tabular-nums">{elapsed(run)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
