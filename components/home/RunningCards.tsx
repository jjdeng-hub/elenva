"use client";

import { ListTodo, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/components/lib/utils";
import { basename, formatCost, formatTokens } from "@/lib/format";
import type { SessionInfo } from "@/lib/types";
import type { SessionTodoSummary } from "@/lib/session-todo";
import type { UsageReport } from "@/lib/usage-aggregate";

/**
 * 运行中会话的实时卡（置于会话流顶部）。
 * 最新动态与任务进度每 5 秒轮询一次（/context 的 tail 与 todo）；空闲时组件不渲染。
 */
export function RunningCards({
  running,
  usage,
  onOpenSession,
}: {
  running: SessionInfo[];
  usage: UsageReport | null;
  onOpenSession: (s: SessionInfo) => void;
}) {
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [todos, setTodos] = useState<Record<string, SessionTodoSummary | null>>({});
  const runningKey = running.map((s) => s.id).join(",");

  useEffect(() => {
    if (!runningKey) return;
    let cancelled = false;
    const ids = runningKey.split(",");
    const fetchAll = async () => {
      const next: Record<string, string> = {};
      const nextTodos: Record<string, SessionTodoSummary | null> = {};
      await Promise.all(
        ids.map(async (id) => {
          try {
            const r = await fetch(`/api/sessions/${encodeURIComponent(id)}/context?tail=8&deferThinking=1&deferMedia=1`, { cache: "no-store" });
            if (!r.ok) return;
            const data = (await r.json()) as { context?: { messages?: unknown }; todo?: SessionTodoSummary | null };
            const text = lastReadableText(data.context?.messages);
            if (text) next[id] = text;
            nextTodos[id] = data.todo ?? null;
          } catch { /* ignore */ }
        }),
      );
      if (!cancelled) {
        setPreviews((prev) => ({ ...prev, ...next }));
        setTodos((prev) => ({ ...prev, ...nextTodos }));
      }
    };
    fetchAll();
    const timer = setInterval(fetchAll, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [runningKey]);

  if (running.length === 0) return null;

  return (
    <div className="space-y-2 px-4 pb-1 pt-3">
      {running.map((s) => {
        const u = usage?.sessions[s.id];
        const t = todos[s.id];
        return (
          <button
            key={s.id}
            onClick={() => onOpenSession(s)}
            className="block w-full rounded-lg border border-accent/25 bg-accent-soft/40 px-3 py-2.5 text-left t-fast hover:border-accent/50 cursor-pointer"
          >
            <div className="flex items-center gap-2">
              <Loader2 size={12} className="anim-spin shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate text-[12px] font-semibold">{s.name || s.firstMessage || "(无标题)"}</span>
              <span className="shrink-0 rounded-sm bg-panel-2 px-1.5 py-0.5 font-mono text-[11px] text-dim">{basename(s.cwd)}</span>
            </div>
            <div className="mt-1 truncate text-[12px] text-muted">{previews[s.id] ?? "正在获取最新动态…"}</div>
            {t && (
              <div className="mt-0.5 flex items-center gap-1.5 text-[12px]" data-testid="running-card-todo">
                <ListTodo size={12} className={cn("shrink-0", t.done === t.total ? "text-success" : "text-accent")} />
                <span className="shrink-0 tabular-nums text-fg">{t.done}/{t.total}</span>
                <span className="min-w-0 truncate text-muted">
                  {t.active ? `进行中：${t.active}` : t.done === t.total ? "全部完成" : "待推进"}
                </span>
              </div>
            )}
            <div className="mt-1.5 flex items-center gap-2 text-[12px] text-dim">
              <span className="inline-flex items-center gap-1 font-medium text-accent">
                <span className="size-1.5 rounded-full bg-accent anim-pulse-dot" /> 运行中
              </span>
              {u && (
                <span className="tabular-nums">
                  {formatTokens(u.tokens.total)} tok · {formatCost(u.cost)}
                </span>
              )}
              <span className="ml-auto">最近写入 {relTimeLite(s.modified)}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function relTimeLite(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  return `${Math.floor(min / 60)} 小时前`;
}

/** 从 tail 消息里提取最后一条可读文本 */
function lastReadableText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m.role !== "assistant" && m.role !== "user") continue;
    let text = "";
    if (typeof m.content === "string") {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      text = m.content
        .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: string }).text ?? "") : ""))
        .join(" ")
        .trim();
    }
    if (!text) continue;
    text = text.replace(/\s+/g, " ");
    return text.length > 88 ? `${text.slice(0, 88)}…` : text;
  }
  return undefined;
}
