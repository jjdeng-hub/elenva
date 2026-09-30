/**
 * elenva-todo 的纯函数核心 —— 任务清单的状态、校验、渲染与注入。
 *
 * 依据《深入理解 AI Agent》ch2（docs/agent-design-standard.md）：
 * - **L912 任务规划**：把任务分解为清晰步骤（TODO 列表）放在轨迹末尾，
 *   持续提醒模型进展与后续目标（对治「只盯局部子任务、丢失原始诉求」）。
 * - **L924 / L938-947**：状态以 **user 消息**注入上下文末尾（借 user 槽位；
 *   不改 system，保住前缀 KV Cache），并可用标签包裹以示「框架生成」。
 * - **L955 实现一（每轮替换）**：更新时先摘掉上一轮注入的那条，只让短后缀失效。
 * - **L963-971（实验 2-9）**：TODO 列表起「外部记忆」作用；启用后平均 15 次迭代
 *   完成任务（禁用 21 次、常漏子任务）。实验版是双工具 + 四状态（含 cancelled）——
 *   本项目取舍见 docs/agent-design-standard.md「偏离登记」。
 * - **L986**：状态栏尽量用代码维护 —— 校验、渲染、注入全在代码侧，
 *   模型只通过 todo_write 声明内容。
 *
 * 本文件同时被扩展（agent 侧、复制安装）与网页端（UI 渲染）引用，保持零依赖。
 */

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  text: string;
  status: TodoStatus;
}

export const TODO_MARK_OPEN = "<elenva_todos>";
export const TODO_MARK_CLOSE = "</elenva_todos>";
export const MAX_TODO_ITEMS = 20;
export const MAX_TODO_TEXT_LENGTH = 160;
export const DEFAULT_TODO_STATUS_BUDGET = 400;

const STATUS_SET: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"]);

export function statusMark(status: TodoStatus): string {
  return status === "completed" ? "[x]" : status === "in_progress" ? "[>]" : "[ ]";
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function readStatus(value: unknown): TodoStatus | null {
  return typeof value === "string" && STATUS_SET.has(value) ? (value as TodoStatus) : null;
}

/**
 * 宽松解析（UI 只读路径）：只要求形状正确，不做上限校验，形状不对返回 null。
 * 用于网页端从工具调用参数里重建清单，或在扩展重建历史状态时容错。
 */
export function coerceTodoItems(value: unknown): TodoItem[] | null {
  if (!Array.isArray(value)) return null;
  const items: TodoItem[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return null;
    const record = raw as Record<string, unknown>;
    const status = readStatus(record.status);
    if (typeof record.text !== "string" || !record.text.trim() || !status) return null;
    items.push({ text: record.text.trim(), status });
  }
  return items;
}

export type TodoValidation = { ok: true; todos: TodoItem[] } | { ok: false; error: string };

/** 严格校验（todo_write 执行路径）：错误信息写给模型看，引导它修正后全量重提。 */
export function validateTodoWrite(input: unknown): TodoValidation {
  const todosValue = (input as { todos?: unknown } | null | undefined)?.todos;
  if (!Array.isArray(todosValue)) {
    return { ok: false, error: "参数 todos 必须是数组（每项 {text, status}）" };
  }
  if (todosValue.length > MAX_TODO_ITEMS) {
    return { ok: false, error: `共 ${todosValue.length} 项，超过上限 ${MAX_TODO_ITEMS} 项——请合并或删减` };
  }
  const todos: TodoItem[] = [];
  let inProgress = 0;
  for (let i = 0; i < todosValue.length; i += 1) {
    const record = (todosValue[i] ?? {}) as Record<string, unknown>;
    if (typeof record.text !== "string" || !record.text.trim()) {
      return { ok: false, error: `第 ${i + 1} 项缺少 text` };
    }
    const text = record.text.trim();
    if (text.length > MAX_TODO_TEXT_LENGTH) {
      return { ok: false, error: `第 ${i + 1} 项文本 ${text.length} 字，超过上限 ${MAX_TODO_TEXT_LENGTH} 字——请精简` };
    }
    const status = readStatus(record.status);
    if (!status) {
      return { ok: false, error: `第 ${i + 1} 项 status 无效（应为 pending / in_progress / completed）` };
    }
    if (status === "in_progress") inProgress += 1;
    todos.push({ text, status });
  }
  if (inProgress > 1) {
    return {
      ok: false,
      error: `同时有 ${inProgress} 项 in_progress——「进行中」同一时刻只能一项，其余请置为 pending 或 completed`,
    };
  }
  return { ok: true, todos };
}

export interface TodoProgress {
  done: number;
  total: number;
  active: TodoItem | null;
}

export function todoProgress(items: readonly TodoItem[]): TodoProgress {
  let done = 0;
  let active: TodoItem | null = null;
  for (const item of items) {
    if (item.status === "completed") done += 1;
    else if (item.status === "in_progress" && !active) active = item;
  }
  return { done, total: items.length, active };
}

/** 一行式摘要（工具卡 / 观测栏 meta 用）。 */
export function todoSummaryLine(items: readonly TodoItem[]): string {
  const { done, total, active } = todoProgress(items);
  if (total > 0 && done === total) return `任务清单（${done}/${total} · 全部完成）`;
  if (active) return `任务清单（${done}/${total} · 进行中：${active.text}）`;
  return `任务清单（${done}/${total}）`;
}

/** todo_write 的工具返回正文（模型看的内容；「复述清单」本身也在强化注意力，L971）。 */
export function renderTodoChecklist(items: readonly TodoItem[]): string {
  if (items.length === 0) return "任务清单已清空。";
  const { done, total, active } = todoProgress(items);
  const tail = active ? `，进行中：${active.text}` : done === total ? "，全部完成" : "";
  const head = `任务清单已更新（${done}/${total} 完成${tail}）：`;
  const rows = items.map((item) => `${statusMark(item.status)} ${item.text}`);
  return [head, ...rows].join("\n");
}

export function todoStatusBudget(): number {
  if (typeof process === "undefined" || !process.env) return DEFAULT_TODO_STATUS_BUDGET;
  const raw = process.env.ELENVA_TODO_STATUS_BUDGET;
  if (raw === undefined) return DEFAULT_TODO_STATUS_BUDGET;
  if (raw.trim() === "off") return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TODO_STATUS_BUDGET;
}

/**
 * 注入块：`<elenva_todos>` 包裹的任务清单（状态栏的一种，L912/L924）。
 * 空清单返回 null（不注入）；超预算时逐级收缩；预算过小宁可返回 null，也不注入超预算内容。
 */
export function buildTodoBlock(items: readonly TodoItem[], budget = todoStatusBudget()): string | null {
  if (budget <= 0 || items.length === 0) return null;
  const { done, total, active } = todoProgress(items);
  const allDone = done === total;
  const footerLong = "（todo_write 全量更新；完成后无需再维护）";
  const footerShort = "（todo_write 维护）";

  const build = (itemMax: number, maxItems: number, footer: string): string => {
    const state = allDone
      ? `${done}/${total} · 全部完成`
      : active
        ? `${done}/${total} · 进行中：${clip(active.text, Math.min(itemMax, 48))}`
        : `${done}/${total}`;
    const lines = [TODO_MARK_OPEN, `任务清单（${state}）：`];
    const shown = items.slice(0, maxItems);
    for (const item of shown) lines.push(`${statusMark(item.status)} ${clip(item.text, itemMax)}`);
    if (shown.length < items.length) lines.push(`…另 ${items.length - shown.length} 项`);
    lines.push(footer, TODO_MARK_CLOSE);
    return lines.join("\n");
  };

  // 逐级收缩：先压单行长度，再截列表长度（清单越长越要保证「瞥一眼」可用），
  // 最后退到只剩状态行的最小心跳。全放不下时返回 null，而不是注一条超预算的。
  for (const [itemMax, maxItems, footer] of [
    [64, 20, footerLong],
    [40, 20, footerLong],
    [28, 20, footerShort],
    [20, 20, footerShort],
    [20, 6, footerShort],
    [20, 0, footerShort],
  ] as const) {
    const block = build(itemMax, maxItems, footer);
    if (block.length <= budget) return block;
  }
  return null;
}

/**
 * 注入内容的识别 —— 下一轮替换旧状态时靠它找到自己上轮注入的那条消息。
 *
 * 判据必须是「整条消息就是注入块」：trim 后以 `<elenva_todos>` 开头、以
 * `</elenva_todos>` 结尾。曾经的 includes() 写法会把**引用了标记的真实用户消息**
 * （例如「请解释 <elenva_todos> 是什么」）当成旧注入静默删掉——本地实测踩过这个坑。
 */
export function isTodoText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith(TODO_MARK_OPEN) && trimmed.endsWith(TODO_MARK_CLOSE);
}

function isTodoContent(content: unknown): boolean {
  if (typeof content === "string") return isTodoText(content);
  if (Array.isArray(content)) {
    const textParts = content.filter((part) => (part as { type?: unknown } | null)?.type === "text");
    if (textParts.length !== 1) return false;
    const text = (textParts[0] as { text?: unknown } | null)?.text;
    return typeof text === "string" && isTodoText(text);
  }
  return false;
}

/**
 * 摘掉上轮注入的任务清单消息 —— 实现一（每轮替换），见 ch2 L955。
 * 只动「整条就是注入块」的 user 消息，不碰真实用户消息与其它扩展的注入。
 */
export function stripTodoMessages<T>(messages: readonly T[]): T[] {
  return messages.filter((message) => {
    const candidate = message as { role?: unknown; content?: unknown } | null;
    if (!candidate || candidate.role !== "user") return true;
    return !isTodoContent(candidate.content);
  });
}