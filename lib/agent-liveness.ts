/**
 * 空闲看门狗（活性判定）。
 *
 * 依据《深入理解 AI Agent》ch5 L189：流式连接最危险的失败不是断开（会立即报错），
 * 而是**静默卡死**——连接建立成功但数据流停止；「每个长连接都需要活性信号，
 * 而非仅依赖连接超时」。
 *
 * 本文件只做**判定与文案**（纯函数，零副作用、零依赖），不碰任何连接状态：
 * 按项目约定「只新增排查输出、不改现有行为」，看门狗**只报不杀**，
 * 挂起的流仍交给既有的重连 / 停止按钮处理。
 */

/** 超过这么久没有任何内核事件 → 提示（可能只是首字慢或长工具静默执行） */
export const AGENT_IDLE_WARN_MS = 60_000;
/** 超过这么久仍无任何事件 → 判定疑似静默卡死，给出排查口径 */
export const AGENT_IDLE_STALL_MS = 180_000;

export type LivenessState = "fresh" | "idle" | "stalled";

export interface LivenessProbe {
  /** 本次提交的开始时刻（收到用户输入时打点） */
  startedAt: number;
  /** 最近一次收到内核事件的时刻；本次提交后一次都没收到则为 null */
  lastEventAt: number | null;
  /** 当前时刻 */
  now: number;
}

export interface LivenessAssessment {
  state: LivenessState;
  /** 距离最近一次事件（没有事件则以提交时刻起算）已经过去多久 */
  idleMs: number;
  /** 本次提交至今的总时长 */
  elapsedMs: number;
  /** 本次提交后是否至少收到过一个事件 */
  sawAnyEvent: boolean;
}

/** 判定当前是否「长时间没有反馈」。阈值来自常量，便于按真实延迟调整。 */
export function assessLiveness(
  probe: LivenessProbe,
  thresholds: { warnMs?: number; stallMs?: number } = {},
): LivenessAssessment {
  const warnMs = thresholds.warnMs ?? AGENT_IDLE_WARN_MS;
  const stallMs = thresholds.stallMs ?? AGENT_IDLE_STALL_MS;

  const elapsedMs = Math.max(0, probe.now - probe.startedAt);
  const since = probe.lastEventAt === null ? probe.startedAt : probe.lastEventAt;
  const idleMs = Math.max(0, probe.now - since);
  const sawAnyEvent = probe.lastEventAt !== null;

  const state: LivenessState = idleMs >= stallMs ? "stalled" : idleMs >= warnMs ? "idle" : "fresh";
  return { state, idleMs, elapsedMs, sawAnyEvent };
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

/**
 * 「一条事件都没收到」时的提示：说明卡在哪一步、已经等了多久、下一步该看什么。
 * 刻意不做过度断言——首字延迟、长工具静默执行、真卡死在这里长得一样。
 */
export function formatNoEventNotice(options: {
  assessment: LivenessAssessment;
  /** 当前阶段的中文标签（连接中 / 等待模型… 等） */
  phaseLabel: string;
  /** 事件流连接状态描述，例如「已连接」「重连中（第 2 次）」 */
  connectionLabel?: string;
}): string {
  const { assessment, phaseLabel, connectionLabel } = options;
  const parts = [
    `已等待 ${seconds(assessment.elapsedMs)}，尚未收到内核任何事件（阶段：${phaseLabel}）`,
  ];
  if (connectionLabel) parts.push(`事件流：${connectionLabel}`);
  parts.push(
    assessment.state === "stalled"
      ? "可能是：上游首字延迟极大 / 长工具静默执行 / 连接已静默卡死。可点停止后重发；服务端日志（ELENVA_DIAG=1 可看全程）能区分是哪一种。"
      : "仍在等待，尚未判定为卡死。",
  );
  return parts.join(" · ");
}

/** 「收到过事件、但后续停住了」时的提示：带出最后一次事件距今多久 */
export function formatStalledNotice(options: {
  assessment: LivenessAssessment;
  phaseLabel: string;
  connectionLabel?: string;
}): string {
  const { assessment, phaseLabel, connectionLabel } = options;
  const parts = [
    `已 ${seconds(assessment.idleMs)} 没有新的内核事件（阶段：${phaseLabel}，本次已运行 ${seconds(assessment.elapsedMs)}）`,
  ];
  if (connectionLabel) parts.push(`事件流：${connectionLabel}`);
  parts.push("长工具执行、压缩上下文期间本来就会静默；若日志里也没有新行，则是上游卡住。");
  return parts.join(" · ");
}
