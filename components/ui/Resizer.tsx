"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/components/lib/utils";

/**
 * 栏位宽度：可拖拽 + 持久化。
 *
 * 为什么需要：此前所有栏宽都写死在组件里（主侧栏 220 / 会话列表 256 / 观测栏 320），
 * 用户既不能按自己的屏幕调，也无法在「聊天区太空」和「栏位太挤」之间取舍。
 *
 * 用 pointer events + movementX 而不是 mousemove：
 *  · setPointerCapture 保证鼠标移出元素、甚至移出窗口时仍能收到事件
 *  · 拖动期间禁止选中文本（否则会选中整屏文字）
 */
export function usePersistedWidth(
  storageKey: string,
  defaultWidth: number,
  min: number,
  max: number,
): {
  width: number;
  setWidth: (next: number) => void;
  /** 拖拽增量（正数 = 变宽） */
  grow: (deltaPx: number) => void;
  /** 复位到默认宽度（双击手柄触发） */
  reset: () => void;
} {
  const clamp = useCallback((v: number) => Math.min(max, Math.max(min, v)), [min, max]);
  const [width, setWidthState] = useState(defaultWidth);
  const widthRef = useRef(defaultWidth);

  /* 首帧后读取本地存储（不能在 useState 初值里读，否则 SSR 与首帧不一致） */
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey));
      if (Number.isFinite(saved) && saved > 0) {
        const next = clamp(saved);
        widthRef.current = next;
        setWidthState(next);
      }
    } catch {
      /* 隐身模式等场景忽略 */
    }
  }, [storageKey, clamp]);

  const setWidth = useCallback(
    (next: number) => {
      const clamped = clamp(next);
      widthRef.current = clamped;
      setWidthState(clamped);
      try {
        localStorage.setItem(storageKey, String(clamped));
      } catch {
        /* ignore */
      }
    },
    [clamp, storageKey],
  );

  const grow = useCallback(
    (deltaPx: number) => {
      setWidth(widthRef.current + deltaPx);
    },
    [setWidth],
  );

  const reset = useCallback(() => setWidth(defaultWidth), [setWidth, defaultWidth]);

  return { width, setWidth, grow, reset };
}

/**
 * 拖拽手柄。放在两个栏位之间，拖动改变**相邻栏位**的宽度。
 * 视觉上是一条 1px 线，命中区域 8px 宽（太细抓不住）。
 */
export function Resizer({
  onDrag,
  onDraggingChange,
  onDoubleClick,
  invert = false,
  side = "right",
  label,
}: {
  /** 拖动增量回调（px，正数表示手柄向右移动） */
  onDrag: (deltaPx: number) => void;
  /**
   * 是否反转方向。**右侧栏位必须开启**：手柄在栏位左边缘，向右拖意味着
   * 左边界右移 = 栏位变窄。之前直接把 movementX 当增量传给宽度，
   * 结果右栏拖拽方向是反的（实测反馈）。
   */
  invert?: boolean;
  onDraggingChange?: (dragging: boolean) => void;
  /** 双击复位到默认宽度 */
  onDoubleClick?: () => void;
  /** 该手柄调整的是哪一侧的栏位（用于提示文案） */
  side?: "left" | "right";
  label?: string;
}) {
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    onDraggingChange?.(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    /* 拖拽期间全局禁用过渡。
       容器上若有 width 过渡（如 SessionSidebar 的 .t-slow 200ms），拖拽时
       每一次宽度变化都会重新触发一次过渡，宽度永远追不上鼠标 ——
       实测拖 200px 只跟了 80px（偏差 124px），而没挂过渡的观测栏只差 10px。
       在这里统一处理，比在 6 个调用方各加一份 dragging 状态可靠。 */
    document.body.classList.add("is-resizing");
  };

  const finish = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    onDraggingChange?.(false);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    document.body.classList.remove("is-resizing");
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label ?? `调整${side === "left" ? "左侧" : "右侧"}栏位宽度`}
      data-testid="pane-resizer"
      onPointerDown={onPointerDown}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        const delta = invert ? -e.movementX : e.movementX;
        if (delta !== 0) onDrag(delta);
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onDoubleClick={onDoubleClick}
      title="拖动调整宽度 · 双击复位"
      className={cn(
        "group relative z-10 -mx-[3px] w-[7px] shrink-0 cursor-col-resize",
        "before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:content-[''] before:bg-transparent",
        "hover:before:bg-accent/40",
      )}
    />
  );
}
