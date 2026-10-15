"use client";

import { Check, ChevronDown, Loader2, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessageView, useMemoResults } from "@/components/MessageView";
import { Popover } from "@/components/ui/popover";
import { cn } from "@/components/lib/utils";
import type { AgentMessage, SessionInfo } from "@/lib/types";

/** 目标会话运行中时的轮询间隔 */
const POLL_MS = 3000;
/** 首屏窗口：与主会话保持同一档，够看最近几轮又不会太重 */
const TAIL = 30;
/** 换会话下拉里最多列出的会话数 */
const PICKER_LIMIT = 20;
/** 「贴底」判据：距底部小于这个像素数就算用户还在底部 */
const STICK_THRESHOLD_PX = 24;

/** 运行中在前，其余保持调用方给的顺序（服务端已按最近活跃排序） */
function orderForPicker(sessions: SessionInfo[], runningIds: Set<string>): SessionInfo[] {
  const list = [...sessions];
  list.sort((a, b) => Number(runningIds.has(b.id)) - Number(runningIds.has(a.id)));
  return list.slice(0, PICKER_LIMIT);
}

function displayName(s: SessionInfo): string {
  return s.name || s.firstMessage || "(无标题)";
}

/**
 * 会话状态点：运行中转圈（与侧栏一致），空闲灰点。
 * 之所以不沿用侧栏的「已完成未读绿点」——副屏没有未读语义，绿点会误导。
 */
function StatusDot({ running }: { running: boolean }) {
  if (running) {
    return (
      <span className="flex size-3 shrink-0 items-center justify-center" title="运行中">
        <Loader2 size={10} className="anim-spin text-accent" />
      </span>
    );
  }
  return <span className="size-1.5 shrink-0 rounded-full bg-dim" title="空闲" />;
}

/**
 * 并排视图的只读副屏：盯 / 对比另一个会话。
 *
 * 口径（本轮定）：**只读**——不挂输入框、不改写、不触发任何 agent 动作；
 * 唯一的网络出口是 `GET /api/sessions/<id>?tail=30&deferThinking=1&deferMedia=1`
 * （与主对话同一条数据链路，返回 context.messages + entryIds + hasMore）。
 * 渲染复用生产组件 MessageView + useMemoResults（保真优先，不自造轻量版）。
 */
export function SideSessionPane({
  sessionId,
  sessions,
  runningIds,
  onSwitch,
  onClose,
}: {
  /** 被观察的会话；null = 尚未选择（首次打开时的提示态） */
  sessionId: string | null;
  sessions: SessionInfo[];
  runningIds: Set<string>;
  onSwitch: (sessionId: string) => void;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [entryIds, setEntryIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const results = useMemoResults(messages);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** 用户是否还贴在底部；一旦上翻就暂停自动贴底，直到手动回到底部 */
  const stickRef = useRef(true);
  /** 当前生效的会话 id，用来丢弃过期响应（切会话时旧请求可能后到） */
  const activeIdRef = useRef<string | null>(sessionId);
  activeIdRef.current = sessionId;

  const session = useMemo(
    () => (sessionId ? sessions.find((s) => s.id === sessionId) ?? null : null),
    [sessions, sessionId],
  );
  const running = sessionId !== null && runningIds.has(sessionId);

  const load = useCallback(async (sid: string, showLoading: boolean) => {
    if (showLoading) setLoading(true);
    try {
      const params = new URLSearchParams({ tail: String(TAIL), deferThinking: "1", deferMedia: "1" });
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sid)}?${params.toString()}`,
        { cache: "no-store" },
      );
      if (activeIdRef.current !== sid) return; // 已切走，丢弃
      if (res.status === 404) {
        setError("会话不存在");
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = (await res.json()) as {
        context?: { messages?: AgentMessage[]; entryIds?: string[] };
      };
      if (activeIdRef.current !== sid) return;
      setMessages(d.context?.messages ?? []);
      setEntryIds(d.context?.entryIds ?? []);
      setError(null);
    } catch {
      /* 失败只留一行提示 + 保留旧内容，不弹错、不清屏 */
      if (activeIdRef.current === sid) setError("拉取失败");
    } finally {
      if (showLoading && activeIdRef.current === sid) setLoading(false);
    }
  }, []);

  /* 进入 / 换会话：清掉上一份内容并立即拉一次（切会话不能残留旧会话的消息） */
  useEffect(() => {
    if (!sessionId) {
      setMessages([]);
      setEntryIds([]);
      setError(null);
      setLoading(false);
      return;
    }
    setMessages([]);
    setEntryIds([]);
    setError(null);
    stickRef.current = true;
    void load(sessionId, true);
  }, [sessionId, load]);

  /* 运行中静默轮询（3s）。依赖 running 而不是 runningIds 整体，避免别的会话状态变化触发重拉。 */
  useEffect(() => {
    if (!sessionId || !running) return;
    const timer = setInterval(() => {
      if (document.hidden) return;
      void load(sessionId, false);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [sessionId, running, load]);

  /* 运行 → 空闲的最后一拍补拉一次：轮询可能刚好停在最后一条消息落盘之前 */
  const wasRunningRef = useRef(running);
  useEffect(() => {
    if (wasRunningRef.current && !running && sessionId) void load(sessionId, false);
    wasRunningRef.current = running;
  }, [running, sessionId, load]);

  /* 新消息到达且用户仍贴底 → 保持贴底；用户上翻过就不打扰 */
  useEffect(() => {
    if (!stickRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX;
  }, []);

  const pickerItems = useMemo(() => orderForPicker(sessions, runningIds), [sessions, runningIds]);
  const title = session ? displayName(session) : sessionId ? sessionId.slice(0, 12) : "未选择会话";

  const picker = (
    <Popover
      align="left"
      panelClassName="w-72"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          data-testid="side-pane-picker"
          onClick={toggle}
          title="切换副屏会话"
          aria-label="切换副屏会话"
          aria-expanded={open}
          className="flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-fg t-fast hover:bg-hover"
        >
          <span className="truncate">{title}</span>
          <ChevronDown size={12} className="shrink-0 text-dim" />
        </button>
      )}
    >
      {(close) => (
        <div className="max-h-80 overflow-y-auto py-1">
          {pickerItems.length === 0 ? (
            <div className="px-3 py-2 text-[12px] text-dim">没有其它会话</div>
          ) : (
            pickerItems.map((s) => {
              const active = s.id === sessionId;
              return (
                <button
                  key={s.id}
                  type="button"
                  data-testid="side-pane-picker-item"
                  onClick={() => {
                    onSwitch(s.id);
                    close();
                  }}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[12px] t-fast hover:bg-hover",
                    active ? "text-fg" : "text-fg/85",
                  )}
                >
                  <StatusDot running={runningIds.has(s.id)} />
                  <span className="min-w-0 flex-1 truncate">{displayName(s)}</span>
                  {active && <Check size={12} className="shrink-0 text-accent" />}
                </button>
              );
            })
          )}
        </div>
      )}
    </Popover>
  );

  return (
    <aside
      data-testid="side-pane"
      className="flex w-[40%] min-w-[380px] max-w-[560px] shrink-0 flex-col overflow-hidden border-l border-line bg-panel"
    >
      {/* 头部：会话名 + 状态点 + 换会话 + 刷新 + 关闭 */}
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-line px-3">
        <StatusDot running={running} />
        <div className="flex min-w-0 flex-1 items-center">{picker}</div>
        <button
          type="button"
          data-testid="side-pane-refresh"
          onClick={() => sessionId && void load(sessionId, false)}
          disabled={!sessionId || loading}
          title="刷新"
          aria-label="刷新副屏"
          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-dim t-fast hover:bg-hover hover:text-fg disabled:cursor-default disabled:opacity-50"
        >
          <RefreshCw size={14} className={cn(loading && "anim-spin")} />
        </button>
        <button
          type="button"
          data-testid="side-pane-close"
          onClick={onClose}
          title="关闭副屏"
          aria-label="关闭副屏"
          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-dim t-fast hover:bg-hover hover:text-fg"
        >
          <X size={14} />
        </button>
      </div>

      {/* 失败提示：一行 dim，保留旧内容，不占位弹错 */}
      {error && (
        <div data-testid="side-pane-error" className="shrink-0 border-b border-line px-3 py-1 text-[11px] text-dim">
          {error}
        </div>
      )}

      {/* 主体：消息流（只读） */}
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {!sessionId ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-[12px] text-dim">
            选一个会话开始并排
          </div>
        ) : messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[12px] text-dim">
            {loading ? "加载中…" : error ? "暂无可显示的消息" : "暂无消息"}
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={entryIds[i] ?? i} className="py-1.5">
              <MessageView
                message={m}
                results={results}
                sessionId={sessionId}
                entryId={entryIds[i] ?? null}
              />
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
