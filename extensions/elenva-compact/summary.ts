/**
 * 摘要升级纯函数核心 —— 对齐 Claude Code 的结构化摘要压缩（经典压缩路径）。
 *
 * ## 锚点（CC 逆向报告 report.txt §2.4，机制对齐、措辞重写）
 *
 * - 摘要提示词要求「先 <analysis> 分析、后 <summary> 输出」两段式
 * - <summary> = 9 段结构（Primary Request and Intent / Key Technical Concepts /
 *   Files and Code Sections / Errors and fixes / Problem Solving / All user messages /
 *   Pending Tasks / Current Work / Optional Next Step）
 * - 引导语「paying close attention to the user's explicit requests and your previous actions」
 * - 自定义指令（/compact 参数或钩子注入）→ 提示词与摘要里都出现「Additional Instructions:」段
 * - 解析清洗：<analysis> → 「Analysis:」、<summary> → 「Summary:」、压空行
 * - 续接三件套：续接头 + 转录回读指针 + 按 reason 分流的续跑句（manual 不加）
 *
 * 本文件零运行时依赖（类型只在编译期引入），供 selftest.mjs 独立加载。
 */

/* ── 关键文案（对齐 CC 关键短句；其余措辞为本实现重写） ── */

export const SUMMARY_SYSTEM_PROMPT = "You are a helpful AI assistant tasked with summarizing conversations.";

export const CONTINUATION_HEADER =
	"This session is being continued from a previous conversation that ran out of context. " +
	"The conversation is summarized below:";

/** 续跑句：只对 threshold / overflow 附着（对齐 CC 双参数语义；manual 手动压缩不续跑）。 */
export const CONTINUE_SENTENCE =
	"Please continue the conversation from where we left it off without asking the user any further questions. " +
	"Continue with the last task that you were asked to work on.";

/** 9 段结构段名（与 CC 相同；内容要求为本实现措辞）。 */
export const SUMMARY_SECTIONS = [
	"Primary Request and Intent",
	"Key Technical Concepts",
	"Files and Code Sections",
	"Errors and fixes",
	"Problem Solving",
	"All user messages",
	"Pending Tasks",
	"Current Work",
	"Optional Next Step",
] as const;

export const ADDITIONAL_INSTRUCTIONS_PREFIX = "Additional Instructions:";

/* ── 摘要提示词 ── */

export interface CompactPromptInputs {
	conversationText: string;
	customInstructions?: string | null;
	/** 上一次压缩的摘要（迭代压缩时作为基底更新而非重写）。 */
	previousSummary?: string | null;
}

export function buildCompactPrompt(inputs: CompactPromptInputs): string {
	const lines: string[] = [
		SUMMARY_SYSTEM_PROMPT,
		"",
		"Your task is to create a detailed summary of the conversation below,",
		"paying close attention to the user's explicit requests and your previous actions.",
		"The summary will be the only thing carried into a fresh context, so it must contain everything",
		"needed to pick the work back up without re-reading the full transcript.",
		"",
		"First, write your analysis inside <analysis> tags:",
		"- Walk through the conversation chronologically, starting from the user's first request.",
		"- For each step, note what was done and why: approach, key decisions, file names, important",
		"  code, errors encountered and how they were fixed, and every correction or direction change",
		"  the user made.",
		"",
		"Then write the summary itself inside <summary> tags, with exactly these sections in order:",
		"1. Primary Request and Intent: what the user asked for, including all stated constraints,",
		"   goals and requirements. Preserve their exact wording where it matters.",
		"2. Key Technical Concepts: technologies, modules, domain terms and conventions that matter.",
		"3. Files and Code Sections: files touched or central to the work; include the important code",
		"   or signatures—not whole files—so the next session can act immediately.",
		"4. Errors and fixes: every error, its root cause and the fix that worked. Only list fixes",
		"   that were verified; pending attempts go to Pending Tasks.",
		"5. Problem Solving: open problems, trade-offs analysed and approaches that were rejected.",
		"6. All user messages: reproduce every user message faithfully and completely. Do not omit,",
		"   paraphrase away, or summarize-away user corrections and decisions; these are the highest-",
		"   importance signals for the next session.",
		"7. Pending Tasks: what remains to be done, as an actionable checklist.",
		"8. Current Work: what was being worked on right before this summary, step by step.",
		"9. Optional Next Step: the concrete next action, quoting the user request or previous",
		"   statement it derives from so the next session cannot drift from intent.",
		"",
	];
	if (inputs.previousSummary && inputs.previousSummary.trim()) {
		lines.push(
			"This conversation was compacted before; treat the following earlier summary as the baseline and",
			"update it with what happened since, rather than summarizing from scratch:",
			"<previous_summary>",
			inputs.previousSummary.trim(),
			"</previous_summary>",
			"",
		);
	}
	if (inputs.customInstructions && inputs.customInstructions.trim()) {
		lines.push(
			ADDITIONAL_INSTRUCTIONS_PREFIX,
			inputs.customInstructions.trim(),
			"(Follow these additional instructions throughout the summary; if they ask for special focus,",
			" re-order or emphasize accordingly.)",
			"",
		);
	}
	lines.push("The conversation:", "<conversation>", inputs.conversationText, "</conversation>");
	return lines.join("\n");
}

/* ── 解析与清洗 ── */

export interface ParsedSummaryOutput {
	analysis: string;
	summary: string;
}

function firstTagContent(text: string, tag: string): string | null {
	const open = `<${tag}>`;
	const close = `</${tag}>`;
	const start = text.indexOf(open);
	if (start === -1) return null;
	const end = text.indexOf(close, start + open.length);
	if (end === -1) return null;
	return text.slice(start + open.length, end);
}

/** 压空行：3 个以上连续换行 → 2 个；首尾 trim。 */
export function collapseBlankLines(text: string): string {
	return text
		.replace(/\n{3,}/g, "\n\n")
		.split("\n")
		.map((line) => (line.trim() === "" ? "" : line.trimEnd()))
		.join("\n")
		.replace(/^\n+/, "")
		.replace(/\n+$/, "");
}

/**
 * 解析模型输出：<analysis> 与 <summary> 各取首段；<summary> 缺失 → null（触发兜底，
 * 返回 undefined 走 pi 默认压缩，绝不吞会话）。
 */
export function parseSummaryOutput(raw: string): ParsedSummaryOutput | null {
	const summary = firstTagContent(raw, "summary");
	if (summary === null || !collapseBlankLines(summary).length) return null;
	const analysis = firstTagContent(raw, "analysis") ?? "";
	return { analysis: collapseBlankLines(analysis), summary: collapseBlankLines(summary) };
}

/** 清洗落地：analysis → 「Analysis:」段、summary → 「Summary:」段。 */
export function formatCleanedSummary(parsed: ParsedSummaryOutput): string {
	const parts: string[] = [];
	if (parsed.analysis) parts.push(`Analysis:\n${parsed.analysis}`);
	parts.push(`Summary:\n${parsed.summary}`);
	return parts.join("\n\n");
}

/* ── 续接摘要装配 ── */

export interface AssembleContinuationInputs {
	/** 已清洗的 Analysis:/Summary: 文本 */
	cleanedSummary: string;
	/** 状态重建段（近期文件回注 / 待办 / 其它会话态说明），可为空串 */
	attachments?: string | null;
	/** 本会话转录 jsonl 路径（回读指针；拿不到则省略该段） */
	transcriptPath?: string | null;
	/** manual = /compact 手动；threshold/overflow = 自动（自动才附续跑句） */
	reason: "manual" | "threshold" | "overflow";
	customInstructions?: string | null;
}

export function assembleContinuationSummary(inputs: AssembleContinuationInputs): string {
	const parts: string[] = [CONTINUATION_HEADER, "", inputs.cleanedSummary.trim()];
	if (inputs.customInstructions && inputs.customInstructions.trim()) {
		parts.push("", `${ADDITIONAL_INSTRUCTIONS_PREFIX} ${inputs.customInstructions.trim()}`);
	}
	if (inputs.attachments && inputs.attachments.trim()) {
		parts.push("", inputs.attachments.trim());
	}
	if (inputs.transcriptPath && inputs.transcriptPath.trim()) {
		parts.push(
			"",
			"Full transcript of the compacted session (one JSON entry per line; read it with the read tool if details are needed):",
			inputs.transcriptPath.trim(),
		);
	}
	if (inputs.reason !== "manual") {
		parts.push("", CONTINUE_SENTENCE);
	}
	return collapseBlankLines(parts.join("\n"));
}
