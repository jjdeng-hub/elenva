/**
 * elenva-todo —— 会话内任务清单（任务拆解），给 Elen 补上「外部记忆」。
 *
 * ## 它在补什么
 *
 * 多步骤任务里，轨迹一长，模型容易只盯当前子任务，忘记原始诉求与后续步骤
 * （《深入理解 AI Agent》ch2 L912）。TODO 列表把任务分解为清晰步骤、
 * 放在轨迹末尾持续提醒（ch2 L912 / L924）；实验 2-9（L963-971）实测：
 * 启用后平均 15 次迭代完成任务，禁用则 21 次且常漏步骤。
 *
 * ## 三件事
 *
 * 1. **`todo_write` 工具**：模型全量提交清单；校验（≤20 项 / 单项 ≤160 字 /
 *    同一时刻仅一项 in_progress）在代码侧强制（ch2 L986：状态由代码维护）。
 * 2. **状态注入**（`context` 钩子）：每轮 LLM 调用前，把当前清单作为
 *    `<elenva_todos>` user 消息追加到上下文末尾；先摘上一轮注入的（实现一，L955）。
 * 3. **`/todos` 命令**：CLI 里随时查看。
 *
 * ## 状态存哪
 *
 * tool result details（不是外部文件）——切分支 / 回滚 / 恢复历史点时，
 * 清单自动跟随该分支的 history 重建，与内核 todo 扩展示例同一机制。
 *
 * 安装：`node extensions/elenva-todo/install.mjs`（复制到 `<agentRoot>/extensions/elenva-todo/`）。
 */
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  buildTodoBlock,
  coerceTodoItems,
  renderTodoChecklist,
  stripTodoMessages,
  validateTodoWrite,
  type TodoItem,
} from "./state.js";

const TOOL_NAME = "todo_write";

export default function elenvaTodo(pi: ExtensionAPI): void {
  /** 本会话当前清单（从分支重建 / 随 execute 更新） */
  let current: TodoItem[] = [];

  /**
   * 从会话分支重建状态：扫描本分支上所有 todo_write 的成功结果（details.todos），
   * 最后一条即当前状态。分支切换 / 回滚后自动正确（内核 todo 示例同款机制）。
   */
  const reconstruct = (ctx: ExtensionContext) => {
    current = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (msg.role !== "toolResult" || msg.toolName !== TOOL_NAME) continue;
      const details = msg.details as { todos?: unknown } | undefined;
      const items = coerceTodoItems(details?.todos);
      if (items) current = items;
    }
  };

  /** 懒重建保险：若首轮请求赶在 session_start 重建之前，至少补一次 */
  let lazyReconstructed = false;

  pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
  pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));

  // ── 1. 工具：todo_write（全量提交）────────────────────────────────────────
  pi.registerTool({
    name: TOOL_NAME,
    label: "任务清单",
    description:
      "创建或整体更新本会话的任务清单（任务拆解）。清单会以状态栏形式注入你的后续每一轮，提醒进展与后续步骤。用法：多步骤任务（约 3 步以上）在动手前先调用它，把全部步骤按执行顺序列出；此后每次开始或完成一步都调用它全量重写——开始一步先把它置为 in_progress，完成立即置为 completed。同一时刻只能有一项 in_progress。任务全部完成后无需再调用；清空清单传空数组 []。",
    promptSnippet: "维护多步任务的清单（创建 / 推进 / 完成，全量提交）",
    promptGuidelines: [
      "多步骤任务（约 3 步以上）在动手前先用 todo_write 列出完整步骤；简单任务或纯问答不要用。",
      "每开始一步先调用 todo_write 把该项置为 in_progress（同一时刻只能一项），完成一步后立即置为 completed 并同步下一步。",
      "清单变化时全量重写提交（不是增量补丁）；任务全部完成后无需再调用。",
    ],
    parameters: Type.Object({
      todos: Type.Array(
        Type.Object({
          text: Type.String({ description: "步骤内容（简短动词短语，≤160 字）" }),
          status: Type.String({
            description: "pending（待办）| in_progress（进行中，同一时刻仅一项）| completed（已完成）",
          }),
        }),
        { description: "完整清单（全量提交，最多 20 项，按执行顺序排列）" },
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const result = validateTodoWrite(params);
      if (!result.ok) {
        throw new Error(`任务清单未更新：${result.error}。清单保持原样；修正后请重新调用 todo_write 全量提交。`);
      }
      current = result.todos;
      return {
        content: [{ type: "text", text: renderTodoChecklist(result.todos) }],
        details: { todos: result.todos, updatedAt: Date.now() },
      };
    },
  });

  // ── 2. 状态注入：每轮 LLM 调用前（ch2 L912 / L924 / L955）───────────────
  pi.on("context", async (event, ctx) => {
    try {
      // 迟到保险：极少数情况下（打开会话后立刻发送）首轮会赶在 session_start 之前，
      // 此时懒重建一次，避免首轮没有清单注入。只补一次；之后靠 session_start / tree / execute 维护。
      if (!lazyReconstructed) {
        lazyReconstructed = true;
        if (current.length === 0) reconstruct(ctx);
      }
      const stripped = stripTodoMessages(event.messages);
      const hadStale = stripped.length !== event.messages.length;
      const block = current.length > 0 ? buildTodoBlock(current) : null;
      if (!block) return hadStale ? { messages: stripped } : undefined;
      return {
        messages: [...stripped, { role: "user", content: block, timestamp: Date.now() }],
      };
    } catch {
      // 注入坏掉不能拖垮会话；静默跳过本轮
      return;
    }
  });

  // ── 3. 命令：/todos ──────────────────────────────────────────────────────
  pi.registerCommand("todos", {
    description: "看当前会话的任务清单（任务拆解与进度）",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const text = current.length > 0 ? renderTodoChecklist(current) : "当前会话还没有任务清单。";
      ctx.ui?.notify?.(text.split("\n")[0] ?? text, "info");
      console.log(text);
    },
  });
}