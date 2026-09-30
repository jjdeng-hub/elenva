"use client";

import { Check, Circle, Loader2 } from "lucide-react";
import { cn } from "@/components/lib/utils";
import type { TodoItem } from "@/extensions/elenva-todo/state";

/**
 * 任务清单的行式渲染（输入框上方面板 / 观测栏「任务」区 / 对话里工具卡共用）。
 * 状态语义：completed=完成（灰）· in_progress=进行中（高亮 + 转圈）· pending=待办（弱化）。
 */
export function TodoList({ items, className }: { items: TodoItem[]; className?: string }) {
  return (
    <ul className={cn("flex flex-col", className)} data-testid="todo-list">
      {items.map((item, i) => (
        <li key={`${i}:${item.text}`} className="flex items-start gap-2 py-0.5 text-[12px] leading-relaxed">
          <span className="mt-[3px] flex size-3 shrink-0 items-center justify-center">
            {item.status === "completed" ? (
              <Check size={12} className="text-success" />
            ) : item.status === "in_progress" ? (
              <Loader2 size={12} className="anim-spin text-accent" />
            ) : (
              <Circle size={10} className="text-dim/70" />
            )}
          </span>
          <span
            className={cn(
              "min-w-0 flex-1 break-words",
              item.status === "completed"
                ? "text-dim"
                : item.status === "in_progress"
                  ? "text-fg"
                  : "text-muted",
            )}
          >
            {item.text}
          </span>
        </li>
      ))}
    </ul>
  );
}