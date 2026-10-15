"use client";

import { Target } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/components/lib/utils";
import { toast } from "@/components/ui/dialog";
import type { SessionMeta } from "@/lib/session-meta";

/**
 * 会话目标（goal）—— 一行「这个会话在干什么」，就地在会话页头部编辑。
 *
 * 摩擦：会话一多，列表里只能看到标题（首轮消息切出来的短语），
 * 想知道「这个会话在干什么」得点进去读上下文。目标是把那句自述
 * 定在标题下方，一眼可见，且点击即可改（模块 3 第 3 轮）。
 *
 * 数据源是会话元数据（`/api/session-meta`，与收藏 ★ / 标签 # 同一份文件）。
 * 组件自取数：头部只关心当前会话这一条，不把整张 meta 提升到 AppShell。
 *
 * 编辑交互取「最简且不误触」的组合：Enter 保存 / Esc 取消 / 失焦保存。
 * Esc 与失焦会先后发生，用 cancelledRef 把「取消」从「失焦保存」里摘出来。
 */
export function SessionGoal({
  sessionId,
  className,
}: {
  sessionId: string;
  className?: string;
}) {
  const [goal, setGoal] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** Esc 取消后随之而来的 blur 不应触发保存 */
  const cancelledRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setEditing(false);
    fetch("/api/session-meta", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { meta?: Record<string, SessionMeta> } | null) => {
        if (!cancelled) setGoal(data?.meta?.[sessionId]?.goal ?? null);
      })
      .catch(() => {
        /* 读不到就当作没设目标，头部不因侧栏数据失败而报错 */
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startEditing = () => {
    cancelledRef.current = false;
    setDraft(goal ?? "");
    setEditing(true);
  };

  const commit = async () => {
    const next = draft.trim();
    if (next === (goal ?? "")) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/session-meta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set", sessionId, goal: next }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        entry?: SessionMeta | null;
      };
      if (!res.ok) throw new Error(data.error || `保存目标失败（HTTP ${res.status}）`);
      setGoal(data.entry?.goal ?? null);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
      setEditing(false);
    }
  };

  if (editing) {
    return (
      <span className="flex min-w-0 items-center gap-1">
        <Target size={12} className="shrink-0 text-dim/70" />
        <input
          ref={inputRef}
          value={draft}
          maxLength={120}
          placeholder="这个会话在做什么？"
          disabled={saving}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancelledRef.current = true;
              setEditing(false);
            }
          }}
          onBlur={() => {
            if (cancelledRef.current) {
              cancelledRef.current = false;
              return;
            }
            void commit();
          }}
          data-testid="session-goal-input"
          className="h-5 min-w-0 flex-1 rounded-sm border border-accent/50 bg-panel-2 px-1.5 text-[12px] text-fg outline-none placeholder:text-dim"
        />
      </span>
    );
  }

  return (
    <button
      onClick={startEditing}
      title={goal ?? "设个目标，让工作台一眼看到这个会话在干什么"}
      data-testid="session-goal"
      className={cn(
        "flex min-w-0 max-w-full cursor-text items-center gap-1 rounded-sm px-1 py-0.5 text-left t-fast hover:bg-hover",
        goal ? "text-[12px] text-dim" : "text-[12px] text-dim/50",
        className,
      )}
    >
      <Target size={12} className="shrink-0" />
      <span className="min-w-0 truncate">{goal ?? "设个目标…"}</span>
    </button>
  );
}
