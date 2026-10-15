import type { AgentMessage, AssistantMessage, ToolResultMessage } from "./types";

/**
 * 逐轮趋势汇总（观测栏「近 N 轮」小节的数据源）。
 *
 * 存在动机：「运行统计」回答**本轮**、累计统计回答**整场会话**，中间那层是空的 ——
 * 回答不了「最近是不是越跑越稳、钱花在哪几轮、失败多不多」。这里按用户消息切轮，
 * 逐轮给 花费 / 工具调用 / 失败数。
 *
 * 口径（与内核一致，不在前端做价格换算）：
 * - 花费：消息自带的 `usage.cost.total`（内核结算）逐轮求和，不查价格表。
 * - 工具调用：assistant 消息里 `toolCall` 内容块的个数（与 session-stats 同源）。
 * - 失败：见 `countFailures` 的注释。
 *
 * 输入是**活动消息列表**（ChatView 当前渲染的 messages）：被压缩掉的历史轮不在此列，
 * 这正是「近 N 轮」的语义（压缩条目自身花费不计入逐轮）。
 */

export interface TurnTrend {
  /** 从 1 起，按提供列表顺序（与真实轮号无关，`maxRounds` 截取后仍从 1 起） */
  index: number;
  /** 首条用户消息的纯文本：多行折成一行、截前 24 字；无文本则「（空消息）」 */
  label: string;
  /** 该轮首条消息（用户消息）的 timestamp；缺失则 undefined */
  startedAt?: number;
  /** 该轮 usage.cost.total 之和（USD） */
  cost: number;
  /** 该轮 assistant 侧 toolCall 块计数 */
  toolCalls: number;
  /** 该轮失败数（口径见 countFailures） */
  failures: number;
}

export interface TurnTrendsResult {
  rounds: TurnTrend[];
  totals: { cost: number; toolCalls: number; failures: number };
}

const LABEL_MAX = 24;

/** 用户消息取纯文本：content 可能是字符串或内容块数组（含图片），只收文本块。 */
function messageText(message: AgentMessage): string {
  if (message.role !== "user") return "";
  const { content } = message;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block.type === "text")
      .map((block) => (block as { text?: string }).text ?? "")
      .join(" ");
  }
  return "";
}

/** 多行折叠 + 截断：把空白（换行 / 制表 / 连续空格）折成单空格，去首尾，超长加省略号。 */
function labelOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "（空消息）";
  return flat.length > LABEL_MAX ? `${flat.slice(0, LABEL_MAX)}…` : flat;
}

function usageCost(message: AgentMessage): number {
  const usage = (message as AssistantMessage | ToolResultMessage).usage;
  return usage?.cost?.total ?? 0;
}

function toolCallCount(message: AgentMessage): number {
  if (message.role !== "assistant") return 0;
  return Array.isArray(message.content) ? message.content.filter((c) => c.type === "toolCall").length : 0;
}

/**
 * 失败计数（不双计）。
 *
 * 两个来源对应两条**互斥的内核路径**：
 * - `toolResult.isError` —— 模型调 bash 工具的结果（`role="toolResult"`，带 toolCallId）；
 * - `bashExecution` 且 `exitCode` 为非 0 数字 —— 用户在输入框敲 `!命令` 的直接执行
 *   （`AgentSession.executeBash` → `recordBashResult` 生成，**没有** toolCallId）。
 *
 * 源码核对（`@earendil-works/pi-coding-agent` dist/core/agent-session.js：`executeBash` /
 * `recordBashResult` 只由交互 / RPC 的 `!` 命令触发）确认：一条失败命令只会落到其中一种
 * 消息形态，不存在同一失败既进 toolResult 又进 bashExecution 的情况，故直接相加不会双计。
 * 反过来，若把 `exitCode !== 0` 的 bashExecution 也当 toolResult 处理反而会漏计 ——
 * bashExecution 没有 toolCallId，无法与任何 toolResult 建立关联。
 *
 * `cancelled` 的命令 exitCode 为 undefined，落不进 `typeof === "number"` 分支，不计失败。
 */
function countFailures(message: AgentMessage): number {
  if (message.role === "toolResult") return message.isError === true ? 1 : 0;
  if (message.role === "bashExecution") {
    return typeof message.exitCode === "number" && message.exitCode !== 0 ? 1 : 0;
  }
  return 0;
}

/**
 * 按用户消息切轮，逐轮汇总；`maxRounds` 只保留**最近** N 轮，`totals` 只统计被保留的轮。
 *
 * 宽容：缺 usage / 缺 timestamp / content 非字符串等情况都不抛错。
 * 轮次边界之前、或会话中段与轮无关的孤立消息（前一角色非 user、又不在某轮内）忽略。
 */
export function computeTurnTrends(messages: AgentMessage[], maxRounds = 10): TurnTrendsResult {
  const all: TurnTrend[] = [];
  let current: TurnTrend | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      current = {
        index: 0, // 全量跑完后再按保留顺序重编号
        label: labelOf(messageText(message)),
        startedAt: typeof message.timestamp === "number" ? message.timestamp : undefined,
        cost: 0,
        toolCalls: 0,
        failures: 0,
      };
      all.push(current);
      continue;
    }
    if (!current) continue; // 第一条用户消息之前的内容（理论上不应有）：忽略
    if (message.role === "custom") continue; // 与轮次统计无关（session-stats 同样跳过）
    current.cost += usageCost(message);
    current.toolCalls += toolCallCount(message);
    current.failures += countFailures(message);
  }

  const limit = Number.isFinite(maxRounds) && maxRounds > 0 ? Math.floor(maxRounds) : 10;
  const rounds = all.slice(-limit).map((round, i) => ({ ...round, index: i + 1 }));

  const totals = rounds.reduce(
    (acc, round) => ({
      cost: acc.cost + round.cost,
      toolCalls: acc.toolCalls + round.toolCalls,
      failures: acc.failures + round.failures,
    }),
    { cost: 0, toolCalls: 0, failures: 0 },
  );

  return { rounds, totals };
}
