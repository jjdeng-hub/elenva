import type { AgentMessage, ToolResultMessage } from "./types";

/**
 * 工具调用的时间信息 —— 过程时间线的数据源。
 *
 * 起点取【发起这次调用的 assistant 消息时间戳】，终点取对应 toolResult 的时间戳。
 * 之所以不是「工具自己的开始时间」：内核没有为工具调用单独落时间戳，只有消息级
 * 时间。语义因此是「消息发出 → 结果返回」，一条消息里的并行调用共用同一个起点
 * （与工具卡里展示的耗时口径一致，不在 UI 上假装能分辨并行）。
 *
 * 实测覆盖：25 个会话 1861 条调用，耗时全部可算、零负值、零缺起始时间。
 */
export interface ToolTiming {
  /** 发起该调用的 assistant 消息时间戳（毫秒）。流式消息尚无时间戳时缺失 */
  startedAt?: number;
  /** 对应 toolResult 的时间戳 */
  endedAt?: number;
  /** 耗时（毫秒）。两端任一缺失或终点早于起点时缺失 */
  durationMs?: number;
  /** 还没有结果 */
  running: boolean;
}

/** 单次调用。result 为 undefined 即「正在执行」 */
export function toolTiming(
  startedAt: number | undefined,
  result: ToolResultMessage | undefined,
): ToolTiming {
  const endedAt = typeof result?.timestamp === "number" ? result.timestamp : undefined;
  const durationMs =
    typeof startedAt === "number" && typeof endedAt === "number" && endedAt >= startedAt
      ? endedAt - startedAt
      : undefined;
  return { startedAt, endedAt, durationMs, running: result === undefined };
}

/**
 * 一轮的墙钟时长：该轮首尾两条有时间戳消息之间的间隔。
 *
 * 不是「agent 实际干活的时间」（那需要减掉等待用户的空转，内核没给），
 * 所以只用在折叠 pill 上作参考值，且超长时按 formatDuration 的 h/m 档显示。
 */
export function turnWallClock(
  messages: AgentMessage[],
  start: number,
  end: number,
): number | undefined {
  let first: number | undefined;
  let last: number | undefined;
  for (let i = Math.max(0, start); i < Math.min(end, messages.length); i += 1) {
    const ts = (messages[i] as { timestamp?: unknown }).timestamp;
    if (typeof ts !== "number") continue;
    if (first === undefined) first = ts;
    last = ts;
  }
  if (first === undefined || last === undefined || last <= first) return undefined;
  return last - first;
}
