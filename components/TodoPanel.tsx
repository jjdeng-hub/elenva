"use client";

import { useState } from "react";
import { ChevronDown, ListTodo } from "lucide-react";
import { cn } from "@/components/lib/utils";
import { TodoList } from "@/components/TodoList";
import { todoProgress } from "@/extensions/elenva-todo/state";
import type { SessionTodoState } from "@/lib/todo-view";

/**
 * 输入框上方的任务清单面板 —— 「需求进行到哪一步」的常驻入口。
 *
 * 默认只占一行（任务 2/5 · 进行中：…）；点击展开完整清单。
 * 数据由会话消息流推导（lib/todo-view），会话里没有清单时不渲染。
 */
export function TodoPanel({ todos }: { todos: SessionTodoState | null }) {
  const [open, setOpen] = useState(false);
  if (!todos || todos.items.length === 0) return null;

  const { done, total, active } = todoProgress(todos.items);
  const allDone = done === total;

  return (
    <div className="chat-col">
      <div className="mb-1.5 overflow-hidden rounded-card border border-line bg-panel-2/60" data-testid="todo-panel">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1 text-left hover:bg-hover/60"
          title="任务清单：点击展开 / 收起"
        >
          <ListTodo size={12} className={cn("shrink-0", allDone ? "text-success" : "text-accent")} />
          <span className="shrink-0 text-[12px] tabular-nums text-fg">
            {done}/{total}
          </span>
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[12px]",
              allDone ? "text-success" : "text-muted",
            )}
          >
            {allDone ? "全部完成" : active ? `进行中：${active.text}` : "待开始"}
          </span>
          <ChevronDown
            size={12}
            className={cn("shrink-0 text-dim transition-transform", open && "rotate-180")}
          />
        </button>
        {open && (
          <div className="border-t border-line px-3 py-2">
            <TodoList items={todos.items} />
          </div>
        )}
      </div>
    </div>
  );
}