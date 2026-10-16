/**
 * 状态重建纯函数核心 —— 压缩后不迷路（CC 附加件机制，report.txt §2.5）。
 *
 * ## 锚点
 *
 * - 近期读取文件内容回注：≤5 个文件（Fd5=5）、总量 ≤50k token（maxTokens=50k）、单文件 ≤5k
 * - 待办回注：从会话条目提取 elenva-todo 的最新清单（数据形态对齐 elenva-todo state.ts：
 *   TodoItem { text, status: pending | in_progress | completed }，标记 [ ] [>] [x]）
 * - pi 的会话条目没有后台任务登记处，无法可证地重建该状态 —— 处理办法是显式注明「未重建」，
 *   而不是编造（Task ③「不可得如实注明」）
 *
 * 本文件零运行时依赖（文件存在性/内容由 index.ts 的回调注入，保持纯函数可自检）。
 */

import { estimateTokens } from "./micro.js";

export const RECENT_FILES_MAX = 5;
export const RECENT_FILES_TOTAL_TOKENS = 50_000;
export const RECENT_FILE_MAX_TOKENS = 5_000;

export const NO_BACKGROUND_STATE_NOTE =
	"Other session state (background tasks etc.): pi session entries carry no background-task registry, so none could be re-injected here.";

/* ── 近期文件挑选 ── */

/**
 * 从 fileOps 的累计清单里挑「值得回注」的文件：后读的优先（CC 语义：最近状态），
 * 修改过的文件排最后出现（最后一次触碰定序），去重取最后一次出现位置。
 */
export function pickRecentFiles(readFiles: readonly string[], modifiedFiles: readonly string[] = []): string[] {
	const lastSeen = new Map<string, number>();
	const order: string[] = [];
	const visit = (file: string) => {
		if (!file) return;
		if (!lastSeen.has(file)) order.push(file);
		lastSeen.set(file, order.indexOf(file));
	};
	for (const file of readFiles) visit(file);
	// 修改过的文件以更近的优先级重新定序（磁盘内容已是修改后的，回注价值最高）
	const modifiedSeen = new Set<string>(modifiedFiles);
	const renumber: string[] = [];
	for (const file of order) {
		if (modifiedSeen.has(file)) continue;
		renumber.push(file);
	}
	for (const file of modifiedFiles) renumber.push(file);
	return renumber.slice(-RECENT_FILES_MAX);
}

export interface ClampedFileContent {
	path: string;
	text: string;
	truncated: boolean;
	tokens: number;
}

/** 单文件钳制：超出 5k token 时保留头部，并留「继续读原文件」提示。 */
export function clampFileContent(path: string, text: string, maxTokens = RECENT_FILE_MAX_TOKENS): ClampedFileContent {
	const tokens = estimateTokens(text);
	if (tokens <= maxTokens) return { path, text, truncated: false, tokens };
	// 收敛保留字符量：先按 4 字符/token 粗切，再按实测密度逐步收缩（CJK 密度高于 4/token）
	let kept = text.slice(0, Math.max(1, Math.floor(maxTokens * 4 * 0.95)));
	for (let i = 0; i < 8 && estimateTokens(kept) > maxTokens; i += 1) {
		const actual = estimateTokens(kept);
		kept = kept.slice(0, Math.max(1, Math.floor((kept.length * maxTokens) / actual)));
	}
	const marker =
		`\n\n[File re-injection truncated here (showing early ≈${estimateTokens(kept)} of ${tokens} tokens). ` +
		`Use the read tool on ${path} for the full content.]`;
	return { path, text: kept + marker, truncated: true, tokens: estimateTokens(kept) };
}

/**
 * 多文件装配：单文件先钳 5k，再按顺序累计总量 ≤50k（装不下的整份丢弃，不半份塞入）。
 * files 为按 pickRecentFiles 输出顺序、内容已由调用方读盘的结果。
 */
export function buildRecentFilesSection(
	files: { path: string; text: string }[],
	limits?: { maxFiles?: number; totalTokens?: number; perFileTokens?: number },
): string {
	const maxFiles = limits?.maxFiles ?? RECENT_FILES_MAX;
	const totalTokens = limits?.totalTokens ?? RECENT_FILES_TOTAL_TOKENS;
	const perFileTokens = limits?.perFileTokens ?? RECENT_FILE_MAX_TOKENS;
	const sections: string[] = [];
	let budget = totalTokens;
	for (const file of files.slice(0, maxFiles)) {
		const clamped = clampFileContent(file.path, file.text, perFileTokens);
		if (clamped.tokens > budget) break;
		budget -= clamped.tokens;
		sections.push(`Path: ${clamped.path}${clamped.truncated ? " (truncated)" : " (full content below)"}\n\n${clamped.text}`);
	}
	if (!sections.length) return "";
	return `## Recently opened files (re-injected from disk after compaction)\n\n${sections.join("\n\n")}`;
}

/* ── 待办回注（数据形态对齐 elenva-todo，不跨扩展 import） ── */

export type TodoStatusLite = "pending" | "in_progress" | "completed";

export interface TodoItemLite {
	text: string;
	status: TodoStatusLite;
}

const TODO_STATUS_SET: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"]);

/** 宽松解析 todo_write 参数里的 todos（形状对不上返回 null）。 */
export function coerceTodoItems(value: unknown): TodoItemLite[] | null {
	if (!Array.isArray(value)) return null;
	const items: TodoItemLite[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== "object") return null;
		const record = raw as Record<string, unknown>;
		const status = typeof record.status === "string" && TODO_STATUS_SET.has(record.status) ? (record.status as TodoStatusLite) : null;
		if (typeof record.text !== "string" || !record.text.trim() || !status) return null;
		items.push({ text: record.text.trim(), status });
	}
	return items.length > 0 ? items : null;
}

const STATUS_MARK: Record<TodoStatusLite, string> = {
	pending: "[ ]",
	in_progress: "[>]",
	completed: "[x]",
};

export function renderTodoSection(items: TodoItemLite[]): string {
	const lines = items.map((item) => `- ${STATUS_MARK[item.status]} ${item.text}`);
	return `## Current todo state (re-injected after compaction)\n\n${lines.join("\n")}`;
}

/**
 * 从会话条目提取最新一份 todo 清单：扫 assistant 的 toolCall，取最后一条合法的 todo_write。
 * entries 形状由调用方给（SessionEntry[] 的最小必要切片），纯函数无 SDK 依赖。
 */
export function extractLatestTodos(entries: unknown[]): TodoItemLite[] | null {
	const minimal = entries as Array<Record<string, unknown>>;
	let latest: TodoItemLite[] | null = null;
	for (const entry of minimal) {
		if (!entry || entry.type !== "message") continue;
		const message = entry.message as Record<string, unknown> | undefined;
		if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content as Array<Record<string, unknown>>) {
			if (!block || block.type !== "toolCall" || block.name !== "todo_write") continue;
			const args = block.arguments as Record<string, unknown> | undefined;
			const todos = coerceTodoItems(args?.todos);
			if (todos) latest = todos;
		}
	}
	return latest;
}

/** 状态重建段拼装：近期文件 + 待办 + 不可得注明；全空返回空串（调用方省略该段）。 */
export function buildStateAttachments(inputs: { recentFiles?: string | null; todos?: string | null }): string {
	const parts: string[] = [];
	if (inputs.recentFiles) parts.push(inputs.recentFiles);
	if (inputs.todos) parts.push(inputs.todos);
	parts.push(NO_BACKGROUND_STATE_NOTE);
	return parts.join("\n\n");
}
