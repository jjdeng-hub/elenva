/**
 * 微压缩（microcompact）纯函数核心 —— 对齐 Claude Code 的「大工具结果落盘 + 指针」机制。
 *
 * ## 它在做什么
 *
 * pi 长会话里 read / bash / grep 等工具结果在上下文里只增不减，是 token 浪费的最大来源。
 * 微压缩把「旧的大工具结果」替换成一条指针文本（内容已落盘，可用 read 工具回读），
 * 不调用模型、不碰会话文件本身（context 事件是非破坏式的，每轮重放同一指针即幂等）。
 *
 * ## 设计锚点（复刻自 CC 逆向报告 report.txt §2.2，不拷代码）
 *
 * - 只处理「可压缩工具集」的结果（CC 8 工具 → pi 名映射见 COMPACTABLE_TOOLS）
 * - 保留最近 N 次调用不动（默认 3，kd5=3）
 * - 从最旧开始压缩，压到「未压缩旧结果总量 ≤ 预算」（默认 40000，vd5=40k）
 * - 自动模式门槛由调用方（index.ts）用 usage 信息执行：已过提示线 + 预计省 ≥ 20000（yd5）
 * - 幂等：同一 toolCallId 只落盘一次（deterministic path + 文件存在即跳过写入）
 *
 * 本文件零运行时依赖（类型也只在编译期引入），供 selftest.mjs 独立加载。
 */

/** CC 8 种可微压缩工具 → pi 工具名映射。
 *  read←Read, bash/powershell←Bash, grep←Grep, find←Glob(pi 的 find≈CC glob),
 *  edit←Edit, write←Write, ls←pi 特有（与 find 同类的只读列举，一并纳入）。 */
export const COMPACTABLE_TOOLS: ReadonlySet<string> = new Set([
	"read",
	"bash",
	"powershell",
	"grep",
	"find",
	"edit",
	"write",
	"ls",
]);

/** 未压缩旧结果总量预算（token，对齐 CC 自动默认 40000）。 */
export const MICRO_BUDGET_TOKENS = 40_000;
/** 保留最近 N 次调用不压（对齐 CC kd5=3）。 */
export const KEEP_RECENT_CALLS = 3;
/** 自动模式「预计省 ≥ 20000」门槛（对齐 CC yd5）。 */
export const MIN_AUTO_SAVINGS_TOKENS = 20_000;
/** CC 对单张图片的固定估值为 2000 token（Yy2）——本实现不压图片，仅作估算参考。 */
export const IMAGE_TOKEN_ESTIMATE = 2_000;

/* ── 最小本地形状（刻意不依赖 SDK 运行时类型，selftest 可独立加载） ── */

export interface MinimalTextBlock {
	type: string;
	text?: string;
}

export interface MinimalToolResult {
	role: string;
	toolCallId: string;
	toolName: string;
	isError?: boolean;
	content: MinimalTextBlock[];
}

/* ── token 估算（启发式，与 pi 内部估算同量级） ── */

/** 粗估 token：ASCII ≈ 4 字符/token，CJK ≈ 1.5 字符/token（混合取舍的保守近似）。 */
export function estimateTokens(text: string): number {
	let ascii = 0;
	let cjk = 0;
	for (const ch of text) {
		if (ch.codePointAt(0)! > 0x2e80) cjk += 1;
		else ascii += 1;
	}
	return Math.ceil(ascii / 4 + cjk / 1.5);
}

/* ── 候选收集 ── */

export interface ToolResultSpan {
	/** 在 event.messages 里的下标（替换时用） */
	index: number;
	toolCallId: string;
	toolName: string;
	/** 结果全文（纯文本；含图片的结果不参与压缩，text 为 null） */
	text: string | null;
	tokens: number;
}

function joinTextBlocks(blocks: MinimalTextBlock[]): string | null {
	const parts: string[] = [];
	for (const block of blocks) {
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		else if (block.type !== "text") return null; // 混有图片/其它形态 → 不碰，避免丢视觉上下文
	}
	const text = parts.join("\n");
	return text.length > 0 ? text : null;
}

/** 把一条消息收窄成 MinimalToolResult；不是工具结果返回 null。 */
export function asToolResult(message: unknown): MinimalToolResult | null {
	if (!message || typeof message !== "object") return null;
	const msg = message as Record<string, unknown>;
	if (msg.role !== "toolResult") return null;
	if (typeof msg.toolCallId !== "string" || typeof msg.toolName !== "string") return null;
	if (!Array.isArray(msg.content)) return null;
	return {
		role: "toolResult",
		toolCallId: msg.toolCallId,
		toolName: msg.toolName,
		isError: Boolean(msg.isError),
		content: msg.content as MinimalTextBlock[],
	};
}

/** 收集本上下文里所有可微压缩的工具结果（按出现顺序）。 */
export function collectMicroCandidates(messages: unknown[]): ToolResultSpan[] {
	const spans: ToolResultSpan[] = [];
	for (let index = 0; index < messages.length; index += 1) {
		const asTool = asToolResult(messages[index]);
		if (!asTool || asTool.isError) continue;
		if (!COMPACTABLE_TOOLS.has(asTool.toolName)) continue;
		if (isMicroPointer(asTool.content)) continue; // 已经是指针（理论少见：context 非破坏式，但防重放叠加）
		const text = joinTextBlocks(asTool.content);
		if (text === null) continue;
		spans.push({ index, toolCallId: asTool.toolCallId, toolName: asTool.toolName, text, tokens: estimateTokens(text) });
	}
	return spans;
}

/** 判断一条工具结果的 content 是否已是本扩展的指针文本（幂等兜底）。 */
export function isMicroPointer(content: MinimalTextBlock[]): boolean {
	const block = content[0];
	return Boolean(block && block.type === "text" && block.text?.startsWith(MICRO_POINTER_PREFIX));
}

/* ── 指针文案（对齐 CC「Tool result saved to: <path> / Use read to view」风格，按 pi 语境改写） ── */

export const MICRO_POINTER_PREFIX = "Tool result from";

export function buildMicroPointer(toolName: string, tokens: number, path: string): string {
	return [
		`${MICRO_POINTER_PREFIX} ${toolName} saved to: ${path}`,
		`Original size ≈ ${tokens} tokens. Use the read tool to view the full result if needed.`,
	].join("\n");
}

/** 落盘路径：`<agentDir>/compact-cache/<sessionId>/<toolCallId>.txt`（deterministic → 幂等）。 */
export function buildCachePath(cacheDir: string, sessionId: string, toolCallId: string): string {
	return `${cacheDir.replace(/\/+$/, "")}/${sessionId}/${toolCallId.replace(/[^A-Za-z0-9_-]/g, "_")}.txt`;
}

/* ── 选择算法（对齐 CC：保留最近 N，从最旧起压到剩余 ≤ 预算） ── */

export interface MicroDecision {
	/** 新选中要落盘的（最旧在前，前缀切片） */
	save: ToolResultSpan[];
	/** 已落盘过、本轮仅重放指针的（幂等：不重复写文件） */
	reemit: ToolResultSpan[];
	/** 保留原样不动的 */
	keep: ToolResultSpan[];
	/** 新落盘部分的 token 数（即本轮新省下的量，供 auto 门槛判断） */
	tokensSaved: number;
}

export interface MicroSelectOptions {
	budgetTokens: number;
	keepRecent: number;
	/** 已落盘的 toolCallId（跨轮状态，由 index.ts 维护） */
	alreadySaved: ReadonlySet<string>;
}

export function selectMicroSpans(spans: ToolResultSpan[], opts: MicroSelectOptions): MicroDecision {
	const { budgetTokens, keepRecent, alreadySaved } = opts;
	const reemit: ToolResultSpan[] = [];
	const fresh: ToolResultSpan[] = [];
	for (const span of spans) {
		if (alreadySaved.has(span.toolCallId)) reemit.push(span);
		else fresh.push(span);
	}

	// 新结果按序排好后：最后 keepRecent 个保留；对更旧的前缀从最旧起保存，直到剩余总量 ≤ 预算
	const keep = fresh.slice(Math.max(0, fresh.length - keepRecent));
	const older = fresh.slice(0, Math.max(0, fresh.length - keepRecent));
	const olderTotal = older.reduce((sum, span) => sum + span.tokens, 0);

	// 从最旧开始累加保存量，停在「剩余（尚未保存的 older 后缀）≤ 预算」的第一处
	let acc = 0;
	let cut = 0;
	while (cut < older.length && olderTotal - acc > budgetTokens) {
		acc += older[cut].tokens;
		cut += 1;
	}
	const save = older.slice(0, cut);
	return { save, reemit, keep, tokensSaved: save.reduce((sum, span) => sum + span.tokens, 0) };
}
