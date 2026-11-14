"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/components/lib/utils";
import { AgentBlockCard, type BlockPayload } from "@/components/agent-blocks";
import { AgentDocEditor } from "@/components/agent-doc-editor";
import { AgentFilmBlock } from "@/components/agent-film-block";
import { agentGlyph, type AgentRecord } from "@/lib/agents/manifest";
import { clockLabel, dateLines, greeting } from "@/lib/format";
import type { DocMeta } from "@/lib/agents/doc-meta";

/**
 * Agent 工作台外壳：管线（左）+ 当前这一篇（中）+ 协作面（右）。
 *
 * 这一版把「一页到底的卡片流」换成写作工作台：
 * - 左栏是管线（manifest 的 views），带每段的数量，当前项高亮；
 * - 中栏的主语是**这一篇稿子**（doc 块），其余块退到它下面；没有 doc 块时才是面板网格；
 * - 右栏常驻对话与待批 —— 审批不再是页面底部的一张卡，动作在哪个视图点下去都看得见。
 *
 * 宽度断点与静态稿一致：< 900 收左栏，< 1240 收右栏。
 */

interface WorkspaceView {
  view: { id: string; title: string };
  blocks: BlockPayload[];
}

type WorkspaceSnapshot = {
  agent: { id: string; name: string; runtime: string; profile: string };
  views: WorkspaceView[];
};

/**
 * `#a/<id>/<seg>` 里属于这个 Agent 的视图段。
 *
 * 平台级 hash（home / chat / memory / code …）不归工作台管——它只认 manifest 里声明过的
 * 视图（today / train / journal …）。不排除这些名字的话，`#a/default/chat` 会被工作台
 * 当成一个不存在的视图、然后把它改写成 `/today`，人永远进不去会话页。
 */
const PLATFORM_VIEW_SEGMENTS = new Set([
  "home", "chat", "memory", "skills", "rhythm", "growth", "identity", "prompt", "code",
  "approvals", "models", "plugins", "subagents", "candidates", "system", "settings",
]);

function readViewFromHash(agentId: string): string | null {
  if (typeof window === "undefined") return null;
  const raw = window.location.hash.replace(/^#/, "");
  const matched = /^a\/([a-z0-9][a-z0-9-]{0,63})\/(.+)$/.exec(raw);
  if (!matched || matched[1] !== agentId) return null;
  const seg = matched[2].trim();
  if (!seg || seg.startsWith("chat/") || PLATFORM_VIEW_SEGMENTS.has(seg)) return null;
  return seg;
}

/** 视图写回地址栏：replaceState 而不是 push —— 视图切换不该在浏览器历史上留一串。 */
function writeViewHash(agentId: string, viewId: string): void {
  if (typeof window === "undefined") return;
  const next = `#a/${agentId}/${viewId}`;
  if (window.location.hash === next) return;
  window.history.replaceState(null, "", next);
}

/** 加载骨架：形状与真实块一致（卡头 + 两行条目），比「加载工作台…」少一次闪烁。 */
function WorkspaceSkeleton() {
  return (
    <div className="min-h-0 flex-1 overflow-hidden p-4">
      <div className="flex flex-col gap-4">
        {[0, 1, 2].map((card) => (
          <div key={card} className="rounded-card border border-line bg-panel">
            <div className="border-b border-line-soft px-4 py-3">
              <div className="h-3 w-20 animate-pulse rounded-sm bg-panel-2" />
            </div>
            <div className="flex flex-col gap-2 px-4 py-3">
              <div className="h-3 w-3/4 animate-pulse rounded-sm bg-panel-2" />
              <div className="h-3 w-1/2 animate-pulse rounded-sm bg-panel-2" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function AgentWorkspace({ agent, onOpenSession }: { agent: AgentRecord; onOpenSession?: () => void }) {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<string | null>(() => readViewFromHash(agent.id));
  const [docMeta, setDocMeta] = useState<DocMeta | null>(null);
  const [pending, setPending] = useState<{ requestId: number; title: string }[]>([]);
  /** ACP 子进程的存活/忙碌状态（来自 /api/agents/pending 的透传），头部的那个小圆点用它 */
  const [acp, setAcp] = useState<{ state: string; queued: number } | null>(null);
  const [turnTick, setTurnTick] = useState(0);
  /** 头部时钟：挂载后再取时间，避免 SSR 与客户端渲染不一致 */
  const [now, setNow] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/agents/workspace?id=${encodeURIComponent(agent.id)}`, { cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as WorkspaceSnapshot & { error?: string };
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setError(null);
      setSnapshot(data);
    } catch (cause) {
      setError(String(cause));
    }
  }, [agent.id]);

  useEffect(() => {
    setSnapshot(null);
    setActiveView(readViewFromHash(agent.id));
    void load();
  }, [load, agent.id]);

  useEffect(() => {
    setNow(new Date());
  }, []);

  // Agent 每完成一轮就重读：它刚改过 data/*.json，界面应该自己长出来
  useEffect(() => {
    const onTurnEnd = () => {
      void load();
      setTurnTick((tick) => tick + 1);
    };
    window.addEventListener("elenva:agent-turn-end", onTurnEnd);
    return () => window.removeEventListener("elenva:agent-turn-end", onTurnEnd);
  }, [load]);

  // 待拍板的操作：5 秒轮询一次（没有权限请求时是一个极轻的进程内查询）
  useEffect(() => {
    if (agent.runtime !== "hermes") return;
    let alive = true;
    // 偶发一次请求失败（dev 重编译 / 宿主瞬时忙）不该立刻喊「离线」——
    // 连续 3 次（约 15s）都拿不到才算真的断了
    let failures = 0;
    const tick = async () => {
      try {
        const res = await fetch(`/api/agents/pending?id=${encodeURIComponent(agent.id)}`, { cache: "no-store" });
        const data = (await res.json().catch(() => ({}))) as {
          pending?: { requestId: number; title: string }[];
          queued?: number;
          state?: string;
        };
        if (alive) {
          failures = 0;
          setPending(Array.isArray(data.pending) ? data.pending : []);
          setAcp({ state: data.state ?? "unknown", queued: data.queued ?? 0 });
        }
      } catch {
        if (!alive) return;
        failures += 1;
        if (failures >= 3) {
          setPending([]);
          setAcp({ state: "offline", queued: 0 });
        }
      }
    };
    void tick();
    const timer = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [agent.id, agent.runtime]);

  const views = snapshot?.views ?? [];
  const current = views.find((entry) => entry.view.id === activeView) ?? views[0] ?? null;
  const primaryBlock = current?.blocks.find((block) => block.type === "doc" || block.type === "film") ?? null;
  const otherBlocks = current?.blocks.filter((block) => block !== primaryBlock) ?? [];

  /**
   * 导航上的角标：只给「有下一步动作」的视图。
   *
   * 原来是把各块条目数加起来——「今天 9」这种数字既不是待办数也不是事件数，
   * 读的人无从解释。现在的口径：队列只数「等你」的，正文只数篇数，其余不给角标。
   */
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of views) {
      const queue = entry.blocks.find((block) => block.type === "queue");
      if (queue) {
        const waiting = (queue.data?.items ?? []).filter((item) => (item.status ?? "").includes("等")).length;
        if (waiting > 0) map.set(entry.view.id, waiting);
        continue;
      }
      const doc = entry.blocks.find((block) => block.type === "doc");
      if (doc && (doc.files?.length ?? 0) > 0) map.set(entry.view.id, doc.files!.length);
    }
    return map;
  }, [views]);

  /** 当前视图里等你拍板的条数（头部那句副标题用它，而不是写死问候语） */
  const waitingNow = useMemo(() => {
    const queue = current?.blocks.find((block) => block.type === "queue");
    return (queue?.data?.items ?? []).filter((item) => (item.status ?? "").includes("等")).length;
  }, [current]);

  /**
   * 深链接落地：快照到了才知道这个视图名是否真实存在。
   * 存在就写回地址栏（一视图一链接），不存在就落回第一个视图而不是停在空白页。
   */
  useEffect(() => {
    if (!snapshot || snapshot.views.length === 0) return;
    const ids = new Set(snapshot.views.map((entry) => entry.view.id));
    const wanted = activeView && ids.has(activeView) ? activeView : snapshot.views[0].view.id;
    if (wanted !== activeView) setActiveView(wanted);
    writeViewHash(agent.id, wanted);
  }, [snapshot, activeView, agent.id]);

  /**
   * 地址栏变化（前进/后退、手改 hash、别处点进来的深链接）：跟着切视图。
   * 少了这一段，hash 与界面会各说各话 —— 地址是「练」、屏幕还停在「日志」。
   */
  useEffect(() => {
    const onHashChange = () => {
      const wanted = readViewFromHash(agent.id);
      if (wanted) setActiveView(wanted);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [agent.id]);

  /**
   * 数字键 1..9 切视图（输入框里不抢键）。
   * 三个视图的时候，鼠标移过去点一下的成本就已经比按一下高——这种低成本直觉要留住。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))) return;
      const index = Number(event.key);
      if (!Number.isInteger(index) || index < 1 || index > views.length) return;
      const entry = views[index - 1];
      if (!entry) return;
      event.preventDefault();
      setActiveView(entry.view.id);
      writeViewHash(agent.id, entry.view.id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [views, agent.id]);

  /**
   * 切视图时清掉上一篇的正文元信息，否则「231 字 / 3 小节」会跟着跑到别的视图的头部。
   * 只在「视图发生变化」时清，不在首次挂载时清——正文编辑器是先挂载、后回填 meta 的。
   */
  const previousViewRef = useRef<string | null>(null);
  useEffect(() => {
    const viewId = current?.view.id ?? null;
    if (previousViewRef.current !== null && previousViewRef.current !== viewId) setDocMeta(null);
    previousViewRef.current = viewId;
  }, [current?.view.id]);

  const runAction = useCallback(
    async (blockId: string, actionId: string, context: Record<string, unknown>): Promise<string | null> => {
      try {
        const res = await fetch("/api/agents/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentId: agent.id, blockId, actionId, context }),
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) return data.error ?? `HTTP ${res.status}`;
        // 动作 = 一句投进会话的话。话已经发出去了，人应该看得见它跑 —— 带去会话页，而不是留在原地等
        onOpenSession?.();
        return null;
      } catch (cause) {
        return String(cause);
      }
    },
    [agent.id, onOpenSession],
  );

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden" data-testid="agent-workspace">
      <div className="grid min-h-0 w-full grid-cols-[minmax(0,1fr)]">
        {/* 中：当前这一篇（视图切换在头部下方的标签条，不再占一列） */}
        <main className="flex min-h-0 min-w-0 flex-col">
          {/* 头部：与首页同一个「时钟 + 问候」母题，让 Agent 的房间和小区共用一套门牌 */}
          <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-panel px-4 py-3">
            <div
              className="flex shrink-0 items-center gap-2.5 border-r border-line-soft pr-4"
              data-testid="agent-clock"
            >
              <span
                className="text-[16px] font-semibold leading-none tabular-nums"
                style={{ fontFamily: "var(--font-app-mono)" }}
              >
                {now ? clockLabel(now) : "--:--"}
              </span>
              <span className="text-[10px] leading-4 text-dim">
                {now ? dateLines(now).date : "—"}
                <br />
                {now ? dateLines(now).weekday : "—"}
              </span>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-[6px] border border-line text-[12px] text-muted">
                  {agentGlyph(agent)}
                </span>
                <span className="truncate text-[14px] font-semibold">
                  {docMeta?.title || agent.name}
                </span>
                {acp && (
                  <span
                    className="flex shrink-0 items-center gap-1 text-[10px] text-dim"
                    data-testid="agent-runtime-state"
                    title={`ACP · ${acp.state}${acp.queued > 0 ? ` · 队列 ${acp.queued}` : ""}`}
                  >
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        acp.queued > 0
                          ? "bg-accent anim-pulse-dot"
                          : acp.state === "ready" || acp.state === "idle"
                            ? "bg-line"
                            : "bg-danger",
                      )}
                    />
                    {acp.queued > 0
                      ? "在跑"
                      : acp.state === "ready"
                        ? "就绪"
                        : // starting 是进程正在拉起来（几秒），不是故障；idle/unknown = 已回收，下一条消息会唤醒
                          acp.state === "starting"
                          ? "启动中"
                          : acp.state === "idle" || acp.state === "unknown"
                            ? "待唤醒"
                            : "离线"}
                  </span>
                )}
              </div>
              <div className="truncate text-[11px] leading-4 text-dim" title={agent.description}>
                {waitingNow > 0
                  ? `${waitingNow} 件事在等你${now ? ` · ${greeting(now)}` : ""}`
                  : agent.description || `runtime: ${agent.runtime}`}
              </div>
            </div>
            <span className="flex shrink-0 items-center gap-1.5">
              {docMeta && <span className="chip">{docMeta.words.toLocaleString()} 字</span>}
              {docMeta && docMeta.sections.length > 0 && (
                <span className="chip">{docMeta.sections.length} 小节</span>
              )}
              {docMeta && docMeta.gaps.length > 0 && (
                <span className="chip chip-warn">待补 {docMeta.gaps.length}</span>
              )}
              {onOpenSession && (
                <button type="button" className="btn btn-sm btn-ghost" onClick={onOpenSession}>
                  会话
                </button>
              )}
            </span>
          </div>

          {/* 等你拍板：工作台只负责喊一声，处理在会话页 —— 对话是会话页的职责，不再在这儿开第二份 */}
          {pending.length > 0 && (
            <div
              className="flex shrink-0 items-center gap-2 border-b border-line-soft bg-accent-soft/40 px-4 py-2"
              data-testid="agent-pending-banner"
            >
              <span className="shrink-0 text-[11px] font-semibold text-accent">有 {pending.length} 个操作等你点头</span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-dim" title={pending[0]?.title}>
                {pending[0]?.title}
              </span>
              {onOpenSession && (
                <button type="button" className="btn btn-sm btn-subtle shrink-0" onClick={onOpenSession}>
                  去会话处理
                </button>
              )}
            </div>
          )}

          {/* 视图标签条：文字 + 下划线（与右栏面板同一套语言），把原来那一列 216px 还给内容 */}
          <nav
            className="flex shrink-0 items-stretch gap-5 overflow-x-auto border-b border-line bg-panel px-4"
            data-testid="agent-views"
          >
            {views.map((entry) => {
              const active = current?.view.id === entry.view.id;
              return (
                <button
                  key={entry.view.id}
                  type="button"
                  aria-current={active ? "true" : undefined}
                  className={cn(
                    "relative flex shrink-0 items-center gap-1.5 py-2 text-[12px] t-fast",
                    active ? "font-semibold text-accent" : "text-dim hover:text-fg",
                  )}
                  onClick={() => {
                    setActiveView(entry.view.id);
                    writeViewHash(agent.id, entry.view.id);
                  }}
                >
                  {entry.view.title}
                  {counts.has(entry.view.id) && (
                    <span className={cn("text-[10px] tabular-nums", active ? "text-accent/80" : "text-dim/70")}>
                      {counts.get(entry.view.id)}
                    </span>
                  )}
                  <span
                    className={cn(
                      "absolute inset-x-1.5 bottom-0 h-[2px] rounded-full",
                      active ? "bg-accent" : "bg-transparent",
                    )}
                  />
                </button>
              );
            })}
          </nav>

          {error ? (
            <div className="p-6 text-[12px] text-dim">读工作台失败：{error}</div>
          ) : snapshot === null ? (
            <WorkspaceSkeleton />
          ) : views.length === 0 ? (
            <div className="p-6 text-[12px] text-dim">
              这个应用包还没有声明视图。在 manifest.json 里写 `views`（导航项 → blocks），或用旧的 `panels`。
            </div>
          ) : primaryBlock?.type === "film" ? (
            <AgentFilmBlock key={`${primaryBlock.id}-${turnTick}`} agentId={agent.id} block={primaryBlock} />
          ) : primaryBlock ? (
            <AgentDocEditor
              key={`${primaryBlock.id}-${turnTick}`}
              agentId={agent.id}
              block={primaryBlock}
              onMeta={setDocMeta}
            />
          ) : current ? (
            <div key={current.view.id} className="anim-fade-up min-h-0 flex-1 overflow-y-auto p-4">
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {current.blocks.length === 0 ? (
                  <div className="text-[12px] text-dim">这个视图还没有块。</div>
                ) : (
                  current.blocks.map((block) => (
                    <AgentBlockCard
                      key={block.id}
                      agentId={agent.id}
                      block={block}
                      onAction={runAction}
                      wide={block.type !== "gallery"}
                    />
                  ))
                )}
              </div>
            </div>
          ) : null}

          {primaryBlock && otherBlocks.length > 0 && (
            <details className="shrink-0 border-t border-line-soft">
              <summary className="cursor-pointer px-4 py-2 text-[11px] text-dim hover:text-fg">
                这一篇的关联（{otherBlocks.length}）—— 展开看清单与动作
              </summary>
              <div className="grid max-h-72 grid-cols-1 gap-4 overflow-y-auto p-4 lg:grid-cols-2">
                {otherBlocks.map((block) => (
                  <AgentBlockCard key={block.id} agentId={agent.id} block={block} onAction={runAction} />
                ))}
              </div>
            </details>
          )}
        </main>
      </div>
    </div>
  );
}
