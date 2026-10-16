/**
 * 触发与提示纯函数 —— 对齐 CC 触发公式与状态行语义。
 *
 * ## 锚点（CC 逆向报告 report.txt §二）
 *
 * - 自动压缩线 = 预算 − 13000（Pz0）；本扩展取「窗口预算 = contextWindow」
 * - 提示线（微压缩自动模式武装线）= 预算 − 20000（md5）
 * - 百分比覆盖环境变量：CC 用 CLAUDE_AUTOCOMPACT_PCT_OVERRIDE，本扩展对齐为
 *   PI_AUTOCOMPACT_PCT_OVERRIDE（1..100，表示「已用 ≥ 窗口的 X%」即触发）
 * - 状态行「Context left until auto-compact: X%」为相对触发线的倒计时
 *
 * 与 pi 原生触发的两条线（README 详述）：
 *   pi 原生 = window − reserveTokens（默认 16384）→ 通常先于本扩展触发；
 *   本扩展 turn_end 线 = window − 13000 → 兜底覆盖 pi 内部检查跳过的轮次
 *   （compaction.md：「tool batch 终结且无排队消息时跳过轮间检查」）与
 *   settings 里 compaction.enabled=false 的场景。无论谁触发，
 *   session_before_compact 的摘要升级都生效。
 */

/** 自动压缩预留（对齐 CC Pz0=13000）。 */
export const AUTO_TRIGGER_RESERVE_TOKENS = 13_000;
/** 提示线预留（对齐 CC md5=20000）；微压缩自动模式要求已过此线。 */
export const WARNING_RESERVE_TOKENS = 20_000;
/** pi 原生 reserveTokens 默认值（口径同步用，README 引用）。 */
export const PI_DEFAULT_RESERVE_TOKENS = 16_384;

/** 百分比覆盖解析：非法/未设 → null；合法范围 1..100（允许小数，如 62.5）。 */
export function parsePctOverride(raw: string | undefined | null): number | null {
	if (!raw) return null;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 1 || value > 100) return null;
	return value;
}

/** 自动压缩触发线（token 已用量）：百分比覆盖优先，否则 = window − 13000。 */
export function autoTriggerTokens(contextWindow: number, pctOverride: number | null): number {
	if (pctOverride !== null) return Math.round((contextWindow * pctOverride) / 100);
	return contextWindow - AUTO_TRIGGER_RESERVE_TOKENS;
}

/** 提示线（token 已用量）：window − 20000（不随百分比覆盖变化，对齐 CC）。 */
export function warningTokens(contextWindow: number): number {
	return contextWindow - WARNING_RESERVE_TOKENS;
}

/** 「距离自动压缩还剩 X%」：相对触发线，已过线为 0，未过线按剩余比例，clamp 0..100。 */
export function contextLeftUntilCompactPercent(tokens: number | null, triggerLine: number): number | null {
	if (tokens === null || !Number.isFinite(triggerLine) || triggerLine <= 0) return null;
	const pct = ((triggerLine - tokens) / triggerLine) * 100;
	if (!Number.isFinite(pct)) return null;
	return Math.max(0, Math.min(100, Math.round(pct)));
}

export const STATUS_LEFT_PREFIX = "Context left until auto-compact: ";
export const LOW_CONTEXT_PREFIX = "Context low (";
export const LOW_CONTEXT_SUFFIX = "% remaining) · Run /compact to compact now";

/** 状态行文案；percent 为 null（用量未知）返回 null（调用方清除状态）。 */
export function statusLeftText(percent: number | null): string | null {
	if (percent === null) return null;
	return `${STATUS_LEFT_PREFIX}${percent}%`;
}

/** 低上下文警示（对齐 CC：低于 20% 剩余时提示）；不触线返回 null。 */
export function lowContextText(percent: number | null, threshold = 20): string | null {
	if (percent === null || percent >= threshold) return null;
	return `${LOW_CONTEXT_PREFIX}${percent}${LOW_CONTEXT_SUFFIX}`;
}
