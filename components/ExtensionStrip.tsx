"use client";

import { Puzzle } from "lucide-react";
import { cn } from "@/components/lib/utils";
import type { ExtensionStatusItem, ExtensionWidgetItem } from "@/lib/types";

/**
 * 渲染扩展通过 Pi Extension UI 协议提供的自定义内容：
 * - extensionWidgets：多行文本挂件（aboveEditor / belowEditor 两个挂载位）
 * - extensionStatuses：扩展自报的运行状态行（仅编辑器上方显示一次）
 * 扩展未提供任何内容时不渲染，避免占用版面。
 */
export function ExtensionStrip({
  widgets,
  statuses,
  placement,
}: {
  widgets: ExtensionWidgetItem[];
  statuses: ExtensionStatusItem[];
  placement: "aboveEditor" | "belowEditor";
}) {
  const scoped = widgets.filter((w) => w.placement === placement);
  const showStatuses = placement === "aboveEditor" && statuses.length > 0;
  if (scoped.length === 0 && !showStatuses) return null;

  return (
    <div className="mx-auto w-full max-w-3xl px-2" data-testid={`extension-strip-${placement}`}>
      {showStatuses && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-1 pb-1">
          {statuses.map((s) => (
            <span key={s.key} className="flex items-center gap-1 text-[11px] text-dim">
              <span className="size-1 rounded-full bg-success" />
              {s.text}
            </span>
          ))}
        </div>
      )}
      {scoped.map((w) => (
        <div
          key={w.key}
          className={cn(
            "overflow-hidden rounded-card border border-line bg-panel-2",
            placement === "aboveEditor" ? "mb-1.5" : "mt-1.5",
          )}
        >
          <div className="flex items-center gap-1 border-b border-line-soft px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide text-dim">
            <Puzzle size={10} /> 扩展
          </div>
          <pre className="max-h-40 overflow-auto px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-muted whitespace-pre-wrap">
            {w.lines.join("\n")}
          </pre>
        </div>
      ))}
    </div>
  );
}
