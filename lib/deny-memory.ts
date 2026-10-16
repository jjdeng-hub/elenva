/**
 * 「拒绝记忆」（模块 5「治理与安全」· 第 3 轮）。
 *
 * 审批历史的**读取辅助**：从已经落盘的决策日志里，找出同一个危险动作（同
 * `ruleKey`）上一次的结果，生成一行人话附注（「上次同类操作：昨天 09:12 被拒绝
 * （递归或强制删除文件）」），好让同一个操作第二次走到闸门时，弹窗 / 队列 /
 * 拒绝文案里带着上下文 —— 而不是和第一次一模一样。
 *
 * 三条硬边界：
 *  · **只提示，不判决**：本模块的返回值只被拼进显示文案，审批拦不拦、放不放
 *    一字不看它（接入点在 `host-guardrails-extension.ts`，判定路径零改动）。
 *  · **纯函数优先**：本文件不 `import` 任何 `node:*`，也不直接读文件 —— 读日志
 *    由调用方以 `readEntries` 回调注入。这样既能在 Node 自测里直载，将来若
 *    界面复用也不会把 Node 专有模块带进客户端包。
 *  · **绝不阻塞审批**：附注生成失败（读日志异常 / 坏数据）一律静默返回 `null`，
 *    调用方拿到空值就按原文案走。
 */

import type { ApprovalDecision, ApprovalLogEntry } from "./approval-log";

export interface LastDecisionOptions {
  /** 排除该会话自身的记录，避免把「当前这次操作刚产生的历史」当成上一次（自指） */
  excludeSessionId?: string | null;
  /** 测试可注入固定时间；缺省取当前时间 */
  now?: Date | number;
}

/** 决定 → 人话动词 */
const DECISION_TEXT: Record<ApprovalDecision, string> = {
  approved: "被批准",
  denied: "被拒绝",
  timeout: "超时未决定",
  queued: "被加入待审批队列",
};

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

/**
 * 决策时刻的人话：今天 / 昨天用相对说法（「多久前」一眼可见），更早用 `MM-DD`；
 * ts 不可解析时返回空串（调用方退化成只显示决定本身）。
 */
function formatStamp(ts: string, now: Date): string {
  const at = new Date(ts);
  if (Number.isNaN(at.getTime())) return "";
  const time = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  if (sameDay(at, now)) return `今天 ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(at, yesterday)) return `昨天 ${time}`;
  return `${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${time}`;
}

/**
 * 找同 `ruleKey` 的最近一条决定。按 `ts` 取最新；`ts` 相同或不可解析时取数组中
 * 靠后的那条（读取端给出的顺序是旧 → 新或新 → 旧都能用，不依赖入参顺序）。
 *
 * `ruleKey` 为空 / 非字符串一律返回 `null` —— 缺省键（老条目没有该字段）不参与
 * 匹配，避免 `undefined === undefined` 把历史里第一个没有键的操作误配过来。
 */
export function findLastDecision(
  entries: readonly ApprovalLogEntry[] | null | undefined,
  ruleKey: string | null | undefined,
  options: LastDecisionOptions = {},
): ApprovalLogEntry | null {
  if (typeof ruleKey !== "string" || ruleKey.trim() === "") return null;
  const exclude = typeof options.excludeSessionId === "string" ? options.excludeSessionId : "";
  let found: ApprovalLogEntry | null = null;
  let foundAt = Number.NEGATIVE_INFINITY;
  for (const entry of entries ?? []) {
    if (!entry || entry.ruleKey !== ruleKey) continue;
    if (exclude && entry.sessionId === exclude) continue;
    const at = Date.parse(entry.ts);
    const weight = Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
    if (found === null || weight >= foundAt) {
      found = entry;
      foundAt = weight;
    }
  }
  return found;
}

/**
 * 把一条决定转成一行附注：「上次同类操作：<时间> <决定>（<原因>）」。
 * 无记录返回 `null`；时间解析失败则省略时间；原因缺失则不写括号。
 */
export function describeLastDecision(
  entry: ApprovalLogEntry | null | undefined,
  now: Date | number = new Date(),
): string | null {
  if (!entry) return null;
  const at = now instanceof Date ? now : new Date(now);
  const when = formatStamp(entry.ts, at);
  const decision = DECISION_TEXT[entry.decision] ?? "有了结果";
  const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
  const head = when ? `${when} ${decision}` : decision;
  return `上次同类操作：${head}${reason ? `（${reason}）` : ""}`;
}

/** 把附注拼到原文案后面（`\n\n` 分段）；无附注原样返回，不产生多余空行。 */
export function appendLastDecisionNote(text: string, note: string | null | undefined): string {
  const base = typeof text === "string" ? text : "";
  const extra = typeof note === "string" ? note.trim() : "";
  if (!extra) return base;
  return `${base}\n\n${extra}`;
}

/**
 * 读日志 → 找最近同类决定 → 生成附注，一步到位；**任何异常都吞掉返回 `null`**。
 *
 * 读文件那层由调用方以 `readEntries` 注入（宿主传 `readApprovalLog().entries`），
 * 所以本函数仍是纯的、可自测（传一个会抛的 `readEntries` 即可验证「不抛」）。
 */
export function safeLastDecisionNote(
  ruleKey: string | null | undefined,
  readEntries: () => readonly ApprovalLogEntry[],
  options: LastDecisionOptions = {},
): string | null {
  if (typeof ruleKey !== "string" || ruleKey.trim() === "") return null;
  try {
    const entries = readEntries();
    return describeLastDecision(
      findLastDecision(entries, ruleKey, options),
      options.now ?? new Date(),
    );
  } catch {
    return null;
  }
}
