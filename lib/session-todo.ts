/**
 * 会话任务清单摘要（服务端只读推导）。
 *
 * 数据源 = 会话里最后一条成功 `todo_write` 工具结果的 details.todos（全量提交 → 最后一条即完整状态）；
 * 从尾部向前扫、命中即停：没有用过清单的会话只多一次浅扫，不引入 IO。
 * 用途：工作台「运行中」卡片等处展示实时任务进度（与网页端 lib/todo-view 同口径）。
 */
import { coerceTodoItems, todoProgress } from "@/extensions/elenva-todo/state";

export interface SessionTodoSummary {
  done: number;
  total: number;
  /** 进行中任务文案（无则 null） */
  active: string | null;
  /** 最近一次更新时间（epoch ms；来自 tool result details） */
  updatedAt: number | null;
}

type MinimalEntry = {
  type?: unknown;
  message?: { role?: unknown; toolName?: unknown; details?: unknown };
};

/**
 * 取「最后一条成功的 todo_write」的清单摘要；没有清单 / 已被清空时返回 null。
 * 失败的调用没有 details（校验不过直接 throw），会被跳过、继续向前找——与扩展侧口径一致。
 */
export function latestSessionTodo(entries: readonly unknown[]): SessionTodoSummary | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i] as MinimalEntry | null;
    if (!entry || entry.type !== "message") continue;
    const message = entry.message;
    if (!message || message.role !== "toolResult" || message.toolName !== "todo_write") continue;
    const details = message.details as { todos?: unknown; updatedAt?: unknown } | undefined;
    const items = coerceTodoItems(details?.todos);
    if (!items) continue;
    if (items.length === 0) return null; // 已被清空
    const progress = todoProgress(items);
    return {
      done: progress.done,
      total: progress.total,
      active: progress.active ? progress.active.text : null,
      updatedAt: typeof details?.updatedAt === "number" ? details.updatedAt : null,
    };
  }
  return null;
}
