/**
 * 计划步骤的归一与渲染（纯函数，宿主扩展与界面共用）。
 *
 * 背景：计划卡片化后，同一份 `steps` 参数会被多处消费 —— 扩展（审批弹窗文本）、
 * 界面（MessageView 步骤列表）。两处若各自解析 input，对「空 title / 超长 / 条数超限」
 * 的处理很容易分叉，出现弹窗一套、卡片另一套。归一与 markdown 渲染都收在这里，
 * 谁读都走同一套容错（模型参数、会话里读回的历史记录都过它）。
 */

export interface PlanStep {
  title: string;
  /** 实现细节（可选）：卡片里作为标题下一行的次要文本 */
  detail?: string;
}

/** 单条步骤各字段的截断上限（字符），与卡片 / 弹窗的展示口径对齐 */
export const PLAN_STEP_TITLE_MAX = 120;
export const PLAN_STEP_DETAIL_MAX = 400;
/** 步骤条数上限（与 present_plan 的 schema maxItems 对齐） */
export const PLAN_STEP_MAX = 12;

function truncate(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value;
}

/**
 * 容错归一：非数组 → []；逐条丢弃「非对象」与「title 为空」；
 * title / detail 去首尾空白；title 截 120、detail 截 400；最多 12 条。
 */
export function normalizePlanSteps(input: unknown): PlanStep[] {
  if (!Array.isArray(input)) return [];
  const steps: PlanStep[] = [];
  for (const raw of input) {
    if (steps.length >= PLAN_STEP_MAX) break;
    if (typeof raw !== "object" || raw === null) continue;
    const { title, detail } = raw as { title?: unknown; detail?: unknown };
    if (typeof title !== "string") continue;
    const trimmedTitle = truncate(title.trim(), PLAN_STEP_TITLE_MAX);
    if (trimmedTitle === "") continue;
    const step: PlanStep = { title: trimmedTitle };
    if (typeof detail === "string") {
      const trimmedDetail = truncate(detail.trim(), PLAN_STEP_DETAIL_MAX);
      if (trimmedDetail !== "") step.detail = trimmedDetail;
    }
    steps.push(step);
  }
  return steps;
}

/**
 * 步骤 → 审批弹窗里的 markdown 文本：`1. **标题** —— 细节`；无细节只留标题。
 * 空数组 → ""（调用方据此省略「步骤：」小节）。
 */
export function stepsToMarkdown(steps: PlanStep[]): string {
  return steps
    .map((step, index) => {
      const head = `${index + 1}. **${step.title}**`;
      return step.detail ? `${head} —— ${step.detail}` : head;
    })
    .join("\n");
}
