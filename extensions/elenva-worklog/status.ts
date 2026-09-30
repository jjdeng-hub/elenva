/**
 * 状态栏（Agent Status Bar）的构造 —— 纯函数。
 *
 * 依据《深入理解 AI Agent》ch2 L851「Agent 状态栏：通过元信息增强 Agent 轨迹管理」：
 * - **L855**：状态栏 = Agent 框架在上下文里持续注入的**状态摘要**（任务进度 / 环境观察 / 工具计数），
 *   不是对话主体内容；模型每次生成回复都能「瞥一眼」当前状态。对治的是「无限循环、状态遗忘、目标偏离」。
 * - **L861**：为什么有效 —— 上下文学习更像检索而非推理：模型擅长从已有内容里捞信息，
 *   但不会自动把轨迹「数一遍、建索引、总结成结论」。把隐式状态提炼成显式知识，省掉每轮现算。
 * - **L914**：位置 —— 作为一条 **user 消息追加到上下文末尾**（不是改 system 消息，否则破坏整个前缀的 KV Cache）；
 *   末尾也意味着离新生成的 token 最近，注意力权重最高。
 * - **实验 2-8**：带状态栏后，每次迭代的思考 token、延迟、花费降低约一个数量级。
 *
 * 本实现做的是 L902 三类信息里的「任务规划」：最近一条工作记录 + 未完成待办。
 * 不含工具调用计数（那是另一类技术，等有真实摩擦再加）。
 */
import type { WorklogEntry, WorklogFile } from "./store.js";

/** 状态块的字符预算（可用 ELENVA_WORKLOG_STATUS_BUDGET 覆盖；0 = 关闭注入） */
export const DEFAULT_STATUS_BUDGET = 320;

const MARK_OPEN = "<agent_status>";
const MARK_CLOSE = "</agent_status>";

export function statusBudget(): number {
  const raw = process.env.ELENVA_WORKLOG_STATUS_BUDGET;
  if (raw === undefined) return DEFAULT_STATUS_BUDGET;
  if (raw.trim() === "off") return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_STATUS_BUDGET;
}

const STATUS_MARK: Record<WorklogEntry["status"], string> = {
  done: "✅",
  doing: "🚧",
  blocked: "⛔",
};

/**
 * 注入内容的识别标记 —— 下一轮替换旧状态时靠它找到自己上轮注入的那条消息。
 *
 * 判据必须是「整条消息就是注入块」：trim 后以 `<agent_status>` 开头、以
 * `</agent_status>` 结尾。includes() 写法会把**引用了标记的真实用户消息**误删——
 * 同一陷阱在 elenva-todo 侧已实测到过（探针消息被静默吃掉）。
 */
export function isStatusText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith(MARK_OPEN) && trimmed.endsWith(MARK_CLOSE);
}

/**
 * 摘掉上轮注入的状态栏消息 —— 实现一（每轮替换），见 ch2 L945：
 * 只让「上次注入之后新增的后缀」失效，前缀缓存不受影响；也避免陈旧状态累积。
 */
export function stripStatusMessages<T>(messages: readonly T[]): T[] {
  return messages.filter((message) => {
    const candidate = message as { role?: unknown; content?: unknown } | null;
    if (!candidate || candidate.role !== "user") return true;
    const content = candidate.content;
    if (typeof content === "string") return !isStatusText(content);
    if (Array.isArray(content)) {
      const textParts = content.filter((part) => (part as { type?: unknown } | null)?.type === "text");
      if (textParts.length !== 1) return true;
      const text = (textParts[0] as { text?: unknown } | null)?.text;
      return !(typeof text === "string" && isStatusText(text));
    }
    return true;
  });
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * 构造状态块。没有工作记录 → 返回 null（不注入，零成本）。
 * 超预算时逐级收缩（先砍待办、再砍标题、最后换短尾句）；预算小到装不下有意义的内容时返回 null，
 * 而不是注一条超预算的。
 */
export function buildStatusBlock(file: WorklogFile, budget = statusBudget()): string | null {
  if (budget <= 0) return null;
  const latest = file.entries[0];
  if (!latest) return null;

  const who = file.projectName ?? "本目录";
  const head = `工作记录（${who}）· 最近一条 ${latest.at} · ${clip(latest.title, 80)} ${STATUS_MARK[latest.status]}`;
  const tails = [
    "（更早的用 worklog_read；本轮收尾时用 worklog_write 记一条）",
    "（worklog_read 看更早，worklog_write 记一条）",
    "（worklog_read / worklog_write）",
  ];

  const build = (headMax: number, todoMax: number, tailIndex: number): string => {
    const lines = [MARK_OPEN, clip(head, headMax)];
    if (latest.todo && todoMax > 0) lines.push(`待办：${clip(latest.todo, todoMax)}`);
    lines.push(tails[tailIndex], MARK_CLOSE);
    return lines.join("\n");
  };

  for (const [headMax, todoMax, tailIndex] of [
    [200, 120, 0],
    [160, 80, 0],
    [120, 60, 1],
    [100, 0, 1],
    [60, 0, 2],
  ] as const) {
    const block = build(headMax, todoMax, tailIndex);
    if (block.length <= budget) return block;
  }
  // 预算小到连最短的状态都装不下：宁可不注入，也不注一条超预算的
  return null;
}
