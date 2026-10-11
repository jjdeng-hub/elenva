/**
 * 内部状态标记块的输出侧兜底。
 *
 * 框架在每轮 LLM 调用前注入三类状态块（记忆索引 / 任务清单 / 工作记录），它们只供模型参考，
 * 不应出现在回复里。提示词（lib/host-prompt.ts 的 internal-state 段）是第一道约束；
 * 这里是第二道：界面渲染助手文本前，把完整的标记块剥掉。
 *
 * 只剥「成对出现的完整块」。标记只出现一半（例如流式输出中途）时不动，避免误删正文。
 */
export const INTERNAL_STATE_TAGS = ["memory_index", "elenva_todos", "agent_status"] as const;

export function stripInternalStateTags(text: string): string {
  let out = text;
  for (const tag of INTERNAL_STATE_TAGS) {
    out = out.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>\\n?`, "g"), "");
  }
  return out;
}
