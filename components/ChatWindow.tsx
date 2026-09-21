"use client";

import { ArrowDown, ChevronRight, GitBranch, Loader2, MessageSquare, Search, Sparkles, Wrench } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentPhase } from "@/hooks/useAgentSession";
import { cn } from "@/components/lib/utils";
import { AssistantMessageView, MessageView, useMemoResults, StreamingIndicator } from "@/components/MessageView";
import { ChatSkeleton, EmptyState } from "@/components/ui/bits";
import { formatClock, formatDuration } from "@/lib/format";
import { turnWallClock } from "@/lib/tool-timing";
import type { AgentMessage, AssistantMessage, TextContent, ToolResultMessage } from "@/lib/types";

/**
 * 一轮 = 一条 user 消息到下一条 user 消息之间的全部内容。
 * 一轮结束后把「过程」（思考 / 工具调用 / 工具结果）收成摘要，只留实质回答。
 * 展开时过程按时间线排布（每步一个节点 + 时刻），详见 ProcessGroup。
 *
 * 关于「哪条算实质回答」——原来取的是【该轮最后一条 assistant 消息】，
 * 这条规则在会写工具/记忆的回合里会算错：实测一个回合的消息序列是
 *
 *   [32] assistant  text(1964)  ← 真正的回答“## 先给个判断标准…”
 *   [33] assistant  tool:write  ← 把结论写进 scratchpad
 *   [34] assistant  text(63)    ← “已把这两条缺口记进 scratchpad…”
 *
 * 于是 1964 字的答案被当成过程折叠了，用户看到的“回答”是一句收尾语。
 *
 * 新规则（阀值有数据依据 —— 全部 13 个会话里，被折叠的中间文字共 404 条：
 * ≤80 字占 77%，都是“我来系统性地过一遍这个项目”这类步骤叙述，该折；
 * ≥200 字只占 4%（16 条），且全是“根因确认（3 个连锁问题）”这类实质结论，不能折）：
 *   ① 最后一条【有文字】的消息 → 永远显示（短答案不会丢）
 *   ② 任何 ≥ MIN_SUBSTANTIVE_CHARS 的文字 → 也显示（实质结论不会藏）
 * 其余（思考 / 工具调用 / 工具结果 / 短叙述）继续折叠。
 */
type Turn = {
  /** 消息下标区间 [start, end) */
  start: number;
  end: number;
  userIdx: number | null;
  /** 需要完整渲染的 assistant 消息下标，按出现顺序 */
  answerIdxs: number[];
};

/** 超过这个字数就当成「实质回答」，不管它在轮中的位置 */
const MIN_SUBSTANTIVE_CHARS = 200;

/** assistant 消息里所有 text 块的总字数（思考块不计） */
function assistantTextLength(m: AgentMessage): number {
  if (m.role !== "assistant") return 0;
  let total = 0;
  for (const b of m.content) {
    if (b.type === "text") total += (b.text ?? "").trim().length;
  }
  return total;
}

function buildTurns(messages: AgentMessage[]): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  /** 本轮最后一条「有文字」的 assistant 消息 */
  let lastTextIdx: number | null = null;
  const close = (turn: Turn | null) => {
    if (!turn) return;
    if (lastTextIdx !== null && !turn.answerIdxs.includes(lastTextIdx)) turn.answerIdxs.push(lastTextIdx);
    turn.answerIdxs.sort((a, b) => a - b);
    turns.push(turn);
    lastTextIdx = null;
  };

  messages.forEach((m, i) => {
    if (m.role === "user") {
      close(cur);
      cur = { start: i, end: i + 1, userIdx: i, answerIdxs: [] };
      return;
    }
    if (!cur) cur = { start: i, end: i + 1, userIdx: null, answerIdxs: [] };
    cur.end = i + 1;
    if (m.role === "assistant") {
      const len = assistantTextLength(m);
      if (len > 0) lastTextIdx = i;
      if (len >= MIN_SUBSTANTIVE_CHARS && !cur.answerIdxs.includes(i)) cur.answerIdxs.push(i);
    }
  });
  close(cur);
  return turns;
}

/** 该消息是否会渲染出可见内容（toolResult / display:false 的 custom 都渲染为空） */
function rendersContent(m: AgentMessage): boolean {
  if (m.role === "user" || m.role === "bashExecution") return true;
  if (m.role === "assistant") {
    return !m.content.every((b) => b.type === "text" && !b.text.trim());
  }
  return false;
}

/**
 * 不归「过程」管、应该直接在对话里占位的消息。
 * 目前两种：
 *  · 压缩记录 —— 上下文层的状态变更，塞进折叠过程区就等于又藏起来一次；
 *  · 含 present_plan 的 assistant 消息 —— 计划是要**读懂再决定**的文档，
 *    折进「过程 · 思考 8 次」里用户根本找不到。
 */
function isStandaloneMessage(m: AgentMessage): boolean {
  if (m.role === "custom") return m.customType === "compaction" && m.display !== false;
  if (m.role === "assistant") {
    return m.content.some((block) => block.type === "toolCall" && block.toolName === "present_plan");
  }
  return false;
}

/** 过程摘要统计：思考次数 / 工具调用次数 / 失败次数 */
function summarizeProcess(
  messages: AgentMessage[],
  results: Map<string, ToolResultMessage>,
  indices: number[],
): { thinking: number; tools: number; failed: number } {
  let thinking = 0;
  let tools = 0;
  let failed = 0;
  for (const i of indices) {
    const m = messages[i];
    if (m.role === "assistant") {
      for (const b of m.content) {
        if (b.type === "thinking") thinking += 1;
        else if (b.type === "toolCall") {
          tools += 1;
          if (b.toolCallId && results.get(b.toolCallId)?.isError) failed += 1;
        }
      }
    } else if (m.role === "toolResult" && m.isError) {
      failed += 1;
    } else if (m.role === "bashExecution") {
      tools += 1;
      if (m.exitCode !== undefined && m.exitCode !== 0) failed += 1;
    }
  }
  return { thinking, tools, failed };
}

export function ChatWindow({
  messages,
  streamState,
  agentPhase,
  agentRunning,
  loading,
  error,
  sessionTitle,
  scrollContainerRef,
  onScrollToBottom,
  entryIds,
  forkingEntryId,
  onFork,
  searchQuery,
  onExitSearch,
  onOpenFile,
  sessionId,
  onRemember,
  hasEarlierMessages,
  loadingEarlier,
  onLoadEarlier,
  lastUserMsgRef,
}: {
  messages: AgentMessage[];
  streamState: { isStreaming: boolean; streamingMessage: AssistantMessage | null };
  agentPhase: AgentPhase;
  agentRunning: boolean;
  loading: boolean;
  error: string | null;
  sessionTitle: string;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  onScrollToBottom: () => void;
  entryIds: string[];
  forkingEntryId: string | null;
  onFork: (entryId: string) => void;
  /** 会话内搜索关键词（空 = 正常浏览） */
  searchQuery: string;
  /** 点击搜索结果跳转后由父级清除关键词 */
  onExitSearch: () => void;
  /** 点击写入文件的路径时，在会话右侧打开文件预览 */
  onOpenFile?: (path: string) => void;
  /** `!命令` 完整输出按需拉取所需的会话 id */
  sessionId?: string | null;
  /** 「记住这条」：把用户的一句话说成长期约定（由 ChatView 落盘到 AGENTS.md） */
  onRemember?: (text: string, scope: "project" | "global") => void;
  /** 服务端还有更早的历史（/context 的 tail 默认为 50，长会话需向上翻页） */
  hasEarlierMessages?: boolean;
  loadingEarlier?: boolean;
  onLoadEarlier?: () => void;
  /**
   * 由 useAgentSession 提供：指向**最后一条用户消息**的 DOM 节点。
   * 发送消息后 hook 会把它滚到视口顶部（答案往下流），
   * 但此前没有任何组件把它挂到节点上 —— ref 永远是 null，
   * scrollUserMsgToTop() 每次提前 return，表现为「发送后视图纹丝不动」。
   */
  lastUserMsgRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const results = useMemoResults(messages);
  const [atBottom, setAtBottom] = useState(true);
  /** 用户手动展开/收起过的轮次（key = 该轮 start 下标）；未记录时按「正在跑则展开」推断 */
  const [turnOverride, setTurnOverride] = useState<Record<number, boolean>>({});
  /** 是否翻过页 —— 只有翻过页才显示「会话开头」分隔标记，避免新会话里出现无意义提示 */
  const [hasPagedEarlier, setHasPagedEarlier] = useState(false);
  const bottomAnchor = useRef<HTMLDivElement | null>(null);
  const topSentinelRef = useRef<HTMLDivElement | null>(null);

  /* 滚到顶部自动加载更早的消息（保留 rootMargin 提前量，滚动时无感衔接） */
  useEffect(() => {
    const root = scrollContainerRef.current;
    const sentinel = topSentinelRef.current;
    if (!root || !sentinel || !onLoadEarlier) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        if (!hasEarlierMessages || loadingEarlier) return;
        setHasPagedEarlier(true);
        onLoadEarlier();
      },
      { root, rootMargin: "240px 0px 0px 0px" },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [scrollContainerRef, hasEarlierMessages, loadingEarlier, onLoadEarlier]);

  const turns = useMemo(() => buildTurns(messages), [messages]);
  const lastTurnStart = turns[turns.length - 1]?.start ?? -1;
  /** 最后一条用户消息的下标（用于挂 lastUserMsgRef） */
  const lastUserIdx = useMemo(() => {
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      if (turns[i].userIdx !== null) return turns[i].userIdx;
    }
    return -1;
  }, [turns]);
  /** 当前轮正在执行 → 过程默认展开（实时可见）；已结束的轮默认收起 */
  const live = agentRunning || streamState.isStreaming;

  /* ---------- 会话内搜索 ---------- */
  const q = searchQuery.trim().toLowerCase();
  const searchMatches = useMemo(() => {
    if (q.length < 1) return null;
    const out: { index: number; role: "user" | "assistant" | "tool"; snippet: string }[] = [];
    let lastAssistant = 0;
    messages.forEach((m, i) => {
      if (m.role === "assistant") lastAssistant = i;
      const texts: { role: "user" | "assistant" | "tool"; text: string }[] = [];
      if (m.role === "user") {
        texts.push({
          role: "user",
          text:
            typeof m.content === "string"
              ? m.content
              : m.content.filter((c): c is TextContent => c.type === "text").map((c) => c.text).join("\n"),
        });
      } else if (m.role === "assistant") {
        for (const b of m.content) {
          if (b.type === "text") texts.push({ role: "assistant", text: b.text });
          else if (b.type === "toolCall") {
            const summary = Object.entries(b.input ?? {})
              .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
              .join(" ");
            texts.push({ role: "tool", text: `${b.toolName} ${summary}`.trim() });
          }
        }
      } else if (m.role === "toolResult") {
        const t = m.content.filter((c): c is TextContent => c.type === "text").map((c) => c.text).join("\n");
        if (t) texts.push({ role: "tool", text: t });
      }
      for (const { role, text } of texts) {
        const pos = text.toLowerCase().indexOf(q);
        if (pos < 0) continue;
        const start = Math.max(0, pos - 60);
        const end = Math.min(text.length, pos + q.length + 90);
        out.push({
          // toolResult 自身不渲染节点，锚到它所属的 assistant 消息，否则跳转无处可去
          index: m.role === "toolResult" ? lastAssistant : i,
          role,
          snippet: `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "…" : ""}`,
        });
        break; // 每条消息只出一条结果
      }
    });
    return out;
  }, [messages, q]);

  const flashTarget = (index: number) => {
    const el = scrollContainerRef.current?.querySelector<HTMLElement>(`[data-idx="${index}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("ring-1", "ring-accent", "rounded-lg");
    setTimeout(() => el.classList.remove("ring-1", "ring-accent", "rounded-lg"), 1600);
  };

  // Track whether the user is near the bottom
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      setAtBottom(distance < 80);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, [scrollContainerRef]);

  // Follow the tail while streaming, unless the user scrolled away
  const lastMessageLen = messages[messages.length - 1]
    ? JSON.stringify(messages[messages.length - 1]).length
    : 0;
  useEffect(() => {
    if (atBottom) onScrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, streamState.isStreaming, lastMessageLen]);

  const phaseLabel = phaseToLabel(agentPhase, agentRunning);
  /** 计时重置键：阶段类型变了就重新计时，工具进度变化不算换阶段 */
  const agentPhaseKind = agentPhase?.kind ?? "";

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollContainerRef}
        data-testid="chat-scroll"
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="chat-col pt-5 pb-4">
            {loading && <ChatSkeleton />}
            {error && !loading && (
              <div className="my-6 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-[13px] text-danger">
                {error}
              </div>
            )}
            {!loading && messages.length === 0 && !streamState.isStreaming && !error && (
              <EmptyChatState title={sessionTitle} />
            )}

            {/*
              向上翻页：服务端只按条数切页（tail 默认 50），长会话必须向前翻才看得到开头。
              改为滚动到顶自动加载（下面的 IntersectionObserver），这里只留哨兵与状态提示，
              不再要求用户先点一下。
            */}
            {!loading && onLoadEarlier && (
              <div ref={topSentinelRef} className="mb-2 flex min-h-6 items-center justify-center">
                {loadingEarlier && (
                  <span className="flex items-center gap-1.5 text-[11px] text-dim" data-testid="load-earlier">
                    <Loader2 size={12} className="anim-spin" /> 正在加载更早的消息…
                  </span>
                )}
                {!loadingEarlier && !hasEarlierMessages && messages.length > 0 && hasPagedEarlier && (
                  <span className="flex items-center gap-2 text-[11px] text-dim/70">
                    <span className="h-px w-8 bg-line-soft" />
                    会话开头
                    <span className="h-px w-8 bg-line-soft" />
                  </span>
                )}
                {!loadingEarlier && hasEarlierMessages && (
                  <button
                    onClick={onLoadEarlier}
                    className="cursor-pointer text-[11px] text-dim t-fast hover:text-fg"
                    title="滚动到顶部会自动加载，也可以点这里"
                  >
                    加载更早的消息
                  </button>
                )}
              </div>
            )}

            {searchMatches !== null && (
              <div className="pb-2">
                <div className="mb-2 flex items-center gap-1.5 text-[12px] text-dim">
                  <Search size={12} />
                  {searchMatches.length > 0 ? `${searchMatches.length} 处匹配` : "无匹配结果"}
                  <span className="text-dim/60">· 点击跳转到消息</span>
                </div>
                {searchMatches.map((hit) => (
                  <button
                    key={`${hit.index}-${hit.role}`}
                    onClick={() => {
                      onExitSearch();
                      requestAnimationFrame(() => setTimeout(() => flashTarget(hit.index), 60));
                    }}
                    className="mb-1.5 flex w-full cursor-pointer items-start gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-left t-fast hover:border-accent/40"
                  >
                    <span
                      className={cn(
                        "mt-0.5 flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] font-medium",
                        hit.role === "user"
                          ? "bg-raised text-muted"
                          : hit.role === "tool"
                            ? "bg-panel-2 text-dim"
                            : "bg-accent-soft text-accent",
                      )}
                    >
                      {hit.role === "tool" ? <Wrench size={10} /> : hit.role === "user" ? <MessageSquare size={10} /> : <Sparkles size={10} />}
                      {hit.role === "user" ? "用户" : hit.role === "tool" ? "工具" : "回复"}
                    </span>
                    <span className="min-w-0 flex-1 break-words text-[12px] text-muted">
                      <Highlight text={hit.snippet} query={searchQuery.trim()} />
                    </span>
                  </button>
                ))}
              </div>
            )}

            {searchMatches === null &&
              turns.map((turn) => {
                const overridden = turnOverride[turn.start];
                const isLast = turn.start === lastTurnStart;
                const expanded = overridden ?? (isLast && live);
                /** 该轮墙钟时长（首次提问 → 最后一句话），供折叠 pill 展示 */
                const wallClockMs = turnWallClock(messages, turn.start, turn.end);

                /* 把该轮切成有序片段：连续的「过程」合并成一条摘要行，
                   实质回答按原位插入 —— 否则回答会被强行提到过程之前，顺序就错了 */
                const segments: ({ kind: "process"; idxs: number[] } | { kind: "answer"; idx: number })[] = [];
                let buf: number[] = [];
                for (let i = turn.start; i < turn.end; i++) {
                  if (i === turn.userIdx) continue;
                  if (isStandaloneMessage(messages[i])) {
                    if (buf.length > 0) {
                      segments.push({ kind: "process", idxs: buf });
                      buf = [];
                    }
                    segments.push({ kind: "answer", idx: i });
                  } else if (turn.answerIdxs.includes(i)) {
                    if (buf.length > 0) {
                      segments.push({ kind: "process", idxs: buf });
                      buf = [];
                    }
                    segments.push({ kind: "answer", idx: i });
                  } else if (rendersContent(messages[i])) {
                    buf.push(i);
                  }
                }
                if (buf.length > 0) segments.push({ kind: "process", idxs: buf });

                return (
                  <div key={turn.start}>
                    {turn.userIdx !== null && (
                      <div
                        data-idx={turn.userIdx}
                        ref={turn.userIdx === lastUserIdx ? lastUserMsgRef : undefined}
                        className="group/msg relative py-1.5"
                      >
                        <MessageView
                          message={messages[turn.userIdx]}
                          results={results}
                          onOpenFile={onOpenFile}
                          sessionId={sessionId}
                          entryId={entryIds[turn.userIdx] ?? null}
                          onRemember={onRemember}
                        />
                        {entryIds[turn.userIdx] && (
                          <button
                            onClick={() => onFork(entryIds[turn.userIdx!])}
                            disabled={forkingEntryId !== null}
                            className="absolute -right-1 top-1.5 hidden cursor-pointer items-center gap-1 rounded-md border border-line bg-panel px-1.5 py-0.5 text-[11px] text-muted shadow-sm t-fast hover:border-accent/40 hover:text-accent group-hover/msg:flex disabled:opacity-50"
                            title="从这条消息分叉出新会话（不影响当前会话）"
                          >
                            {forkingEntryId === entryIds[turn.userIdx] ? (
                              <Loader2 size={10} className="anim-spin" />
                            ) : (
                              <GitBranch size={10} />
                            )}
                            分叉
                          </button>
                        )}
                      </div>
                    )}

                    {segments.map((seg) =>
                      seg.kind === "process" ? (
                        <ProcessGroup
                          key={`p${seg.idxs[0]}`}
                          indices={seg.idxs}
                          messages={messages}
                          results={results}
                          expanded={expanded}
                          wallClockMs={wallClockMs}
                          onToggle={() => setTurnOverride((prev) => ({ ...prev, [turn.start]: !expanded }))}
                          onOpenFile={onOpenFile}
                          sessionId={sessionId}
                          entryIds={entryIds}
                          onRemember={onRemember}
                        />
                      ) : (
                        <div key={`a${seg.idx}`} data-idx={seg.idx} className="py-1.5">
                          <MessageView
                            message={messages[seg.idx]}
                            results={results}
                            onOpenFile={onOpenFile}
                            sessionId={sessionId}
                            entryId={entryIds[seg.idx] ?? null}
                            onRemember={onRemember}
                          />
                        </div>
                      ),
                    )}
                  </div>
                );
              })}

            {searchMatches === null && streamState.isStreaming && streamState.streamingMessage && (
              <div className="py-1.5">
                <AssistantMessageView
                  message={streamState.streamingMessage}
                  results={results}
                  streaming
                  onOpenFile={onOpenFile}
                />
              </div>
            )}
            {searchMatches === null && phaseLabel && (
              <StreamingIndicator phaseLabel={phaseLabel} waitKey={agentPhaseKind} />
            )}
            <div ref={bottomAnchor} />
        </div>
      </div>

      {/* Jump to bottom */}
      {!atBottom && (
        <button
          onClick={onScrollToBottom}
          className="absolute right-5 bottom-4 flex size-8 cursor-pointer items-center justify-center rounded-full border border-line bg-raised text-muted shadow-lg t-fast hover:text-fg"
          title="回到底部"
        >
          <ArrowDown size={14} />
        </button>
      )}
      <ScrollTailHelper containerRef={scrollContainerRef} bottomAnchor={bottomAnchor} />
    </div>
  );
}

/**
 * 一轮的「过程」区。
 *
 * 设计目标：聊天主体看起来就是**一问一答** —— 用户气泡与最终回答始终可见，
 * 中间的思考与工具调用收成一条横向分割线（不做成卡片，否则看起来像又一条回复）。
 * 需要细节时点开，内容嵌在分割线与回答之间。
 */
function ProcessGroup({
  indices,
  messages,
  results,
  expanded,
  wallClockMs,
  onToggle,
  onOpenFile,
  sessionId,
  entryIds,
  onRemember,
}: {
  indices: number[];
  messages: AgentMessage[];
  results: Map<string, ToolResultMessage>;
  expanded: boolean;
  /** 所属一轮的墙钟时长（毫秒），缺失时不显示 */
  wallClockMs?: number;
  onToggle: () => void;
  onOpenFile?: (path: string) => void;
  sessionId?: string | null;
  entryIds: string[];
  onRemember?: (text: string, scope: "project" | "global") => void;
}) {
  const { thinking, tools, failed } = useMemo(
    () => summarizeProcess(messages, results, indices),
    [messages, results, indices],
  );
  const parts: string[] = [];
  if (thinking > 0) parts.push(`思考 ${thinking}`);
  if (tools > 0) parts.push(`工具 ${tools}`);
  return (
    <div className="py-0.5" data-testid="process-group">
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        title={expanded ? "收起这一轮的过程" : "展开这一轮的思考与工具调用"}
        className="group flex w-full cursor-pointer items-center gap-2.5 py-1.5"
      >
        <span className="h-px flex-1 bg-line-soft" />
        <span
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] t-fast",
            expanded
              ? "border-accent/30 bg-accent-soft/60 text-accent"
              : failed > 0
                ? "border-warn/30 bg-warn/10 text-warn"
                : "border-line bg-panel-2 text-dim group-hover:border-accent/30 group-hover:text-muted",
          )}
        >
          <ChevronRight size={10} className={cn("shrink-0 transition-transform", expanded && "rotate-90")} />
          <span>过程</span>
          {parts.length > 0 && <span className="opacity-70">· {parts.join(" · ")}</span>}
          {failed > 0 && <span>· {failed} 失败</span>}
          {wallClockMs !== undefined && (
            <span className="opacity-70 tabular-nums" title="这一轮从提问到收尾的墙钟时长">
              · {formatDuration(wallClockMs)}
            </span>
          )}
        </span>
        <span className="h-px flex-1 bg-line-soft" />
      </button>
      {expanded && (
        /* 展开态走时间线：左侧轨道上每步一个节点 + 时刻。
           步骤内容仍然是 MessageView 本体（思考块懒加载 / 工具卡 / bash 卡 / 文件预览
           全部不变）—— 换的只是「列怎么排」，不是「每步怎么渲染」，所以这里的
           改动不会连带影响任何一种消息的展示。 */
        <div className="mt-1 mb-2 border-l border-line-soft pl-3">
          {indices.map((i) => {
            const ts = (messages[i] as { timestamp?: unknown }).timestamp;
            return (
              <div key={i} data-idx={i} className="timeline-step relative py-1">
                <span
                  aria-hidden
                  className="absolute -left-[13px] top-[7px] size-1.5 -translate-x-1/2 rounded-full bg-dim/50"
                />
                {typeof ts === "number" && (
                  <div className="mb-0.5 flex items-center gap-1.5" data-testid="process-time">
                    <span className="font-mono text-[10px] leading-none tabular-nums text-dim">
                      {formatClock(ts)}
                    </span>
                  </div>
                )}
                <MessageView
                  message={messages[i]}
                  results={results}
                  onOpenFile={onOpenFile}
                  sessionId={sessionId}
                  entryId={entryIds[i] ?? null}
                  onRemember={onRemember}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ScrollTailHelper({
  containerRef,
  bottomAnchor,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  bottomAnchor: React.RefObject<HTMLDivElement | null>;
}) {
  // Keeps the anchor mounted so external callers can scroll to it
  useEffect(() => {
    if (!bottomAnchor.current || !containerRef.current) return;
  }, [bottomAnchor, containerRef]);
  return null;
}

function phaseToLabel(phase: AgentPhase, running: boolean): string {
  /* 守卫：phase 与 running 不一致时不能只信 phase。
     之前只要有 waiting_model 就无条件渲染，一旦出现「phase 残留 + 已经不在运行」
     就会永久卡着一行「等待模型…」，而此时输入框是发送态（没有停止按钮）——
     用户看到的是一个既没在跑、又不能中断的死状态。 */
  if (phase?.kind === "waiting_model") return running ? "等待模型…" : "";
  if (phase?.kind === "running_command") return "执行命令…";
  if (phase?.kind === "running_tools") {
    const active = phase.tools[phase.tools.length - 1];
    return active ? `工具执行中 · ${active.name}${active.progress ? ` · ${active.progress}` : ""}` : "工具执行中…";
  }
  if (running) return "思考中…";
  return "";
}

function EmptyChatState({ title }: { title: string }) {
  return (
    <EmptyState
      icon={<Sparkles size={20} />}
      title={title || "开始新对话"}
      hint={
        <>
          在下方输入框输入任务描述，Agent 将开始工作。支持 <code className="font-mono">@文件</code> 引用与{" "}
          <code className="font-mono">/命令</code>。
        </>
      }
    />
  );
}

/** 大小写不敏感的关键词高亮 */
function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let pos = 0;
  let idx = lower.indexOf(q);
  let key = 0;
  while (idx >= 0) {
    if (idx > pos) parts.push(text.slice(pos, idx));
    parts.push(
      <mark key={key++} className="rounded-sm bg-accent-soft px-0.5 text-accent">
        {text.slice(idx, idx + q.length)}
      </mark>,
    );
    pos = idx + q.length;
    idx = lower.indexOf(q, pos);
  }
  if (pos < text.length) parts.push(text.slice(pos));
  return <>{parts}</>;
}
