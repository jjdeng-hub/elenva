/**
 * 从会话消息流里重建「当前任务清单」（网页端只读路径）。
 *
 * 数据源 = 最后一条成功的 todo_write 工具调用的参数（全量提交 → 参数即完整状态）；
 * 失败调用不改变清单；回滚/切分支后消息流本身已变，重算即正确（无需额外同步）。
 */
import type { AgentMessage, ToolResultMessage } from "@/lib/types";
import { coerceTodoItems, type TodoItem } from "@/extensions/elenva-todo/state";

export interface SessionTodoState {
  items: TodoItem[];
  /** 发起这次更新的消息时间戳（可选） */
  updatedAt?: number;
  /** 该消息在消息数组里的下标（观测栏跳转用） */
  messageIndex: number;
}

export function latestTodoState(
  messages: readonly AgentMessage[],
  results?: ReadonlyMap<string, ToolResultMessage>,
): SessionTodoState | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    for (let j = message.content.length - 1; j >= 0; j -= 1) {
      const block = message.content[j];
      if (block.type !== "toolCall" || block.toolName !== "todo_write") continue;
      const result = block.toolCallId ? results?.get(block.toolCallId) : undefined;
      if (result?.isError) continue; // 失败的调用未改变清单，继续向前找
      const items = coerceTodoItems((block.input as { todos?: unknown } | undefined)?.todos);
      if (!items) continue; // 流式进行中/参数不完整：保持旧状态（继续向前）
      return { items, updatedAt: message.timestamp, messageIndex: i };
    }
  }
  return null;
}