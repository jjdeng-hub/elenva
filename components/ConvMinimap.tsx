"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/components/lib/utils";
import { centerElementInContainer } from "@/lib/scroll";
import type { AgentMessage } from "@/lib/types";

/** 少于这个数不显示导航细条（新会话无意义） */
const MIN_ENTRIES = 3;
/** 悬停/预览文本的最大长度 */
const PREVIEW_CHARS = 160;

export type UserMessageEntry = { index: number; text: string };

/**
 * 抽出用户消息导航条目。
 *
 * 这是**纯浏览**索引：只用于「跳到某条消息 + 闪烁」，不含任何会话状态。
 * 范围 = 当前已加载的消息窗口（服务端 tail 分页；上翻加载后自动补齐）——
 * 只有已渲染的消息才有 `data-idx` 锚点，指向窗口外的下标无处可跳，
 * 所以这里刻意不做「全量索引」。
 */
export function buildUserMessageEntries(messages: AgentMessage[]): UserMessageEntry[] {
  const out: UserMessageEntry[] = [];
  messages.forEach((m, i) => {
    if (m.role !== "user") return;
    const raw =
      typeof m.content === "string"
        ? m.content
        : m.content
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join(" ");
    const flat = raw.replace(/\s+/g, " ").trim();
    out.push({ index: i, text: flat || "(图片/附件)" });
  });
  return out;
}

function preview(text: string): string {
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}

/**
 * 对话导航细条（DeepSeek 式）——常驻消息区右缘的浏览工具。
 *
 * 形态：折叠态是一条细轨，每根用户消息一个小横条，等距、整体垂直居中；
 * 悬停展开消息索引面板，点击 = 滚动跳转 + 闪烁高亮。
 *
 * 与状态的关系：**只读**。不调用 navigate_tree、不改任何会话状态、不关任何面板。
 * 定位：绝对覆盖层，不占布局、不改 `--chat-col`；水平放在原生滚动条内侧与其错开。
 */
export function ConvMinimap({
  messages,
  scrollContainerRef,
  onJump,
}: {
  messages: AgentMessage[];
  /** 消息滚动容器（与 ChatWindow 共用同一个 ref） */
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  /** 点击导航：父级负责「居中滚动 + 闪烁」（复用搜索跳转那一套） */
  onJump: (index: number) => void;
}) {
  const entries = useMemo(() => buildUserMessageEntries(messages), [messages]);
  const [open, setOpen] = useState(false);
  /** 当前消息（scroll spy 跟随滚动，点击时乐观更新） */
  const [activeIdx, setActiveIdx] = useState(-1);
  /** 悬停的条/行（用于联动高亮与预览） */
  const [hoverIdx, setHoverIdx] = useState(-1);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const activeRowRef = useRef<HTMLButtonElement | null>(null);

  /* ---------- scroll spy：当前标记跟随滚动 ----------
     以「消息中心过视口中线」为准：取最后一条中心尚未越过视口中线的用户消息。
     这样读到某轮回答的中段时，标记停在该轮的提问上，而不是提前跳去下一个提问。 */
  useEffect(() => {
    const sc = scrollContainerRef.current;
    if (!sc || entries.length === 0) return;
    let raf = 0;
    const compute = () => {
      raf = 0;
      const contRect = sc.getBoundingClientRect();
      const mid = contRect.height / 2;
      let next = entries[0].index;
      for (const e of entries) {
        const el = sc.querySelector<HTMLElement>(`[data-idx="${e.index}"]`);
        if (!el) continue;
        if (el.getBoundingClientRect().top - contRect.top <= mid) next = e.index;
        else break;
      }
      setActiveIdx((prev) => (prev === next ? prev : next));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(compute);
    };
    sc.addEventListener("scroll", onScroll, { passive: true });
    compute();
    return () => {
      sc.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scrollContainerRef, entries]);

  /* 面板打开时自动居中到当前条目 */
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const row = activeRowRef.current;
    if (panel && row) centerElementInContainer(panel, row);
  }, [open, activeIdx]);

  if (entries.length < MIN_ENTRIES) return null;

  const jump = (index: number) => {
    setActiveIdx(index);
    onJump(index);
  };

  return (
    /* 覆盖层与中间层都不吃事件；只有细轨与面板本身可交互 ——
       透明区域（含整条全高的中间层）不挡消息文本与滚动条 */
    <div className="pointer-events-none absolute inset-y-0 right-3 z-20 flex items-center py-2">
      <div
        className="pointer-events-none flex h-full items-center"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => {
          setOpen(false);
          setHoverIdx(-1);
        }}
      >
        {open && (
          <div
            ref={panelRef}
            data-testid="conv-minimap-panel"
            className="pointer-events-auto flex max-h-full w-60 flex-col gap-0.5 overflow-y-auto rounded-lg border border-line bg-panel p-1 shadow-lg"
          >
            {entries.map((e) => {
              const active = e.index === activeIdx;
              const hovered = e.index === hoverIdx;
              return (
                <button
                  key={e.index}
                  ref={active ? activeRowRef : undefined}
                  type="button"
                  data-testid="conv-minimap-row"
                  title={preview(e.text)}
                  onClick={() => jump(e.index)}
                  onMouseEnter={() => setHoverIdx(e.index)}
                  className={cn(
                    "flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-left text-[12px] leading-snug t-fast",
                    active
                      ? "bg-accent-soft font-medium text-accent"
                      : hovered
                        ? "bg-hover text-fg"
                        : "text-muted hover:bg-hover hover:text-fg",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "mt-1.5 size-1 shrink-0 rounded-full",
                      active ? "bg-accent" : "bg-dim/50",
                    )}
                  />
                  <span className="line-clamp-2 min-w-0 flex-1">{e.text}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* 折叠态细轨：等距小横条、整体垂直居中；条多时两端渐隐 */}
        <div
          data-testid="conv-minimap"
          className="pointer-events-auto flex max-h-full flex-col items-center justify-center gap-1 overflow-hidden py-3"
          style={{
            maskImage: "linear-gradient(to bottom, transparent, black 10%, black 90%, transparent)",
            WebkitMaskImage: "linear-gradient(to bottom, transparent, black 10%, black 90%, transparent)",
          }}
        >
          {entries.map((e) => {
            const active = e.index === activeIdx;
            const hovered = e.index === hoverIdx;
            return (
              <button
                key={e.index}
                type="button"
                data-testid="conv-minimap-bar"
                title={preview(e.text)}
                aria-label={`跳转到：${preview(e.text)}`}
                aria-current={active}
                onClick={() => jump(e.index)}
                onMouseEnter={() => setHoverIdx(e.index)}
                className={cn(
                  "h-[3px] w-3 shrink-0 cursor-pointer rounded-full t-fast",
                  active ? "bg-accent" : hovered ? "bg-muted" : "bg-dim/40",
                )}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
