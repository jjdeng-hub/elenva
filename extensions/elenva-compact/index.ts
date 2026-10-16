/**
 * elenva-compact —— Claude Code 式上下文压缩机制全量复刻（pi 扩展）。
 *
 * ## 三件套
 *
 * ① 微压缩（`context` 事件）：旧的大工具结果 →「落盘 + 指针」，不调用模型。
 *    保留最近 3 次调用；从最旧起压到剩余 ≤ 预算（默认 40000 token）；自动模式
 *    仅当「已过提示线」且「预计省 ≥ 20000 token」时生效；同一 toolCallId 幂等。
 * ② 摘要升级（`session_before_compact`）：CC 式 9 段模板 + <analysis>/<summary>
 *    两段式 + Additional Instructions 合并 + 续接头与转录回读指针 + 按 reason
 *    附续跑句 + usage 回传；生成失败返回 undefined 走 pi 默认压缩（绝不吞会话）。
 * ③ 状态重建：压缩后近期读取文件回注（≤5 / 总量 ≤50k / 单文件 ≤5k）+ 待办回注。
 *
 * 另有：turn_end 补触发 + 百分比覆盖 env + 状态行（trigger.ts 交互说明）、
 * /context 与 /microcompact 命令、本地遥测 jsonl（telemetry.ts）。
 *
 * ## 环境变量（全部可选）
 *
 * | 变量 | 默认 | 说明 |
 * |---|---|---|
 * | PI_ELENVA_COMPACT_DISABLE | — | =1 整扩展静默（不注册行为） |
 * | PI_ELENVA_MICRO_DISABLE | — | =1 关微压缩（摘要升级保留） |
 * | PI_ELENVA_MICRO_BUDGET | 40000 | 微压缩「剩余 ≤ 预算」目标（token） |
 * | PI_ELENVA_KEEP_RECENT | 3 | 微压缩保留最近 N 次调用 |
 * | PI_ELENVA_COMPACT_TRIGGER_DISABLE | — | =1 关扩展侧 turn_end 补触发 |
 * | PI_AUTOCOMPACT_PCT_OVERRIDE | — | 触发线按窗口百分比覆盖（1..100，对齐 CC 语义） |
 * | PI_ELENVA_SUMMARY_MODEL | — | 摘要模型 "provider/id"；默认同当前模型 |
 *
 * 安装：`node extensions/elenva-compact/install.mjs`
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	convertToLlm,
	serializeConversation,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { uuidv7 } from "@earendil-works/pi-ai";
import {
	buildCachePath,
	buildMicroPointer,
	collectMicroCandidates,
	MICRO_BUDGET_TOKENS,
	KEEP_RECENT_CALLS,
	MIN_AUTO_SAVINGS_TOKENS,
	selectMicroSpans,
	type ToolResultSpan,
} from "./micro.js";
import {
	assembleContinuationSummary,
	buildCompactPrompt,
	formatCleanedSummary,
	parseSummaryOutput,
} from "./summary.js";
import {
	buildRecentFilesSection,
	buildStateAttachments,
	extractLatestTodos,
	pickRecentFiles,
	renderTodoSection,
} from "./rebuild.js";
import {
	autoTriggerTokens,
	contextLeftUntilCompactPercent,
	lowContextText,
	parsePctOverride,
	statusLeftText,
	warningTokens,
} from "./trigger.js";
import {
	appendTelemetry,
	makeTelemetryEvent,
	resolveAgentDir,
	telemetryPath,
} from "./telemetry.js";

/** pi 默认摘要输出上限口径（同官方示例 custom-compaction；README 说明）。 */
const SUMMARY_MAX_TOKENS = 8192;

const STATUS_KEY = "elenva-compact";

/**
 * 扩展侧 turn_end 补触发用的哨兵指令。
 *
 * pi 把扩展触发的 ctx.compact() 记为 reason="manual"（v0.86.1 agent-session.js:1592），
 * 拿不到 threshold 语义；CC 语义里「自动压缩」应附续跑句。所以扩展触发时带精确匹配的
 * 哨兵，session_before_compact 里识别后按 threshold 处理（且不把哨兵当附加指令展开）。
 */
const AUTO_TRIGGER_INSTRUCTIONS = "[elenva-compact:auto-trigger] Context crossed the auto-compact line; trigger continuation like an automatic compaction.";

interface SavedRecord {
	path: string;
	tokens: number;
}

interface MicroStats {
	count: number;
	tokensSaved: number;
}

function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function envEnabled(name: string): boolean {
	return process.env[name] === "1";
}

/** fileOps → CompactionDetails 同形清单（保持 pi 跨压缩文件追踪的累加口径）。 */
function fileOpsLists(fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> }): {
	readFiles: string[];
	modifiedFiles: string[];
} {
	const modified = new Set<string>([...fileOps.written, ...fileOps.edited]);
	return {
		readFiles: [...fileOps.read].filter((file) => !modified.has(file)),
		modifiedFiles: [...modified],
	};
}

export default function elenvaCompact(pi: ExtensionAPI): void {
	if (envEnabled("PI_ELENVA_COMPACT_DISABLE")) return;

	const agentDir = resolveAgentDir();
	const cacheDir = path.join(agentDir, "compact-cache");
	const microDisabled = envEnabled("PI_ELENVA_MICRO_DISABLE");
	const triggerDisabled = envEnabled("PI_ELENVA_COMPACT_TRIGGER_DISABLE");
	const microBudget = envInt("PI_ELENVA_MICRO_BUDGET", MICRO_BUDGET_TOKENS);
	const keepRecent = envInt("PI_ELENVA_KEEP_RECENT", KEEP_RECENT_CALLS);

	/* ── 会话内状态（session_start 重置；落盘缓存 keyed by sessionId 天然幂等） ── */
	let sessionId: string | undefined;
	let savedResults = new Map<string, SavedRecord>();
	let microStats: MicroStats = { count: 0, tokensSaved: 0 };
	let manualMicroPending: { budgetTokens: number } | null = null;
	let triggerArmed = true;
	let warnedLow = false;
	/** 本扩展成功生成摘要后待匹配的 tokensBefore：session_compact 里对上则跳过重复记录
	 *  （session_before_compact 成功路径与 session_compact 事件对应同一次压缩，pi 记的
	 *  reason 可能为 manual 而语义是 threshold —— 历史行以修正后的语义为准，恰一行）。 */
	let pendingRecordedTokensBefore: number | undefined;

	const compactionHistory: { ts: string; reason: string; tokensBefore: number }[] = [];

	/** 解析某 toolCallId 是否已落盘：内存 → deterministic 路径 + 文件存在性。 */
	const resolveSavedPath = (toolCallId: string): string | undefined => {
		const known = savedResults.get(toolCallId);
		if (known) return known.path;
		if (!sessionId) return undefined;
		const deterministic = buildCachePath(cacheDir, sessionId, toolCallId);
		try {
			if (fs.existsSync(deterministic)) {
				savedResults.set(toolCallId, { path: deterministic, tokens: 0 });
				return deterministic;
			}
		} catch {
			return undefined;
		}
		return undefined;
	};

	/** 落盘（幂等：文件已存在即跳过写入）。 */
	const saveIfAbsent = (span: ToolResultSpan): string => {
		const target = buildCachePath(cacheDir, sessionId ?? "anon", span.toolCallId);
		if (!fs.existsSync(target)) {
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, span.text ?? "", "utf8");
		}
		return target;
	};

	/* ── ① 微压缩 ── */
	pi.on("context", (event, ctx) => {
		if (microDisabled) return;
		const manual = manualMicroPending;
		if (manual) manualMicroPending = null;
		if (!sessionId) sessionId = ctx.sessionManager.getSessionId();

		const candidates = collectMicroCandidates(event.messages);
		if (!candidates.length) return;

		// 先把「已落盘」的候选登记好（内存 & 文件存在性幂等判定），剩下的走选择算法
		const alreadySaved = new Set<string>();
		for (const span of candidates) {
			if (resolveSavedPath(span.toolCallId)) alreadySaved.add(span.toolCallId);
		}
		const decision = selectMicroSpans(candidates, {
			budgetTokens: manual?.budgetTokens ?? microBudget,
			keepRecent,
			alreadySaved,
		});

		// 自动模式门槛：已过提示线 + 预计省 ≥ 20000（manual 跳过门槛）
		let maySaveNew = true;
		if (!manual) {
			const usage = ctx.getContextUsage();
			const usageOk = Boolean(usage?.tokens && usage.contextWindow > 0 && usage.tokens >= warningTokens(usage.contextWindow));
			maySaveNew = usageOk && decision.tokensSaved >= MIN_AUTO_SAVINGS_TOKENS;
		}
		const toApply = [...decision.reemit, ...(maySaveNew ? decision.save : [])];
		if (!toApply.length) return;

		const pointers = new Map<number, string>();
		for (const span of toApply) {
			const savedPath = saveIfAbsent(span);
			if (!savedResults.has(span.toolCallId)) {
				savedResults.set(span.toolCallId, { path: savedPath, tokens: span.tokens });
			}
			pointers.set(span.index, buildMicroPointer(span.toolName, span.tokens, savedPath));
		}
		if (maySaveNew && decision.save.length) {
			microStats = {
				count: microStats.count + decision.save.length,
				tokensSaved: microStats.tokensSaved + decision.tokensSaved,
			};
			appendTelemetry(
				makeTelemetryEvent("microcompact", sessionId, {
					tools: decision.save.length,
					tokensSaved: decision.tokensSaved,
					reemit: decision.reemit.length,
					budget: manual?.budgetTokens ?? microBudget,
					trigger: manual ? "manual" : "auto",
				}),
			);
		}
		return { messages: event.messages.map((message, index) => {
			const pointer = pointers.get(index);
			if (pointer === undefined) return message;
			return { ...message, content: [{ type: "text", text: pointer }] };
		}) };
	});

	/* ── ② 摘要升级 + ③ 状态重建 ── */
	pi.on("session_before_compact", async (event, ctx) => {
		const startedAt = Date.now();
		const { preparation, reason: rawReason, signal } = event;
		// 扩展补触发（哨兵精确匹配）→ 语义上是自动压缩：reason 按 threshold 处理，
		// 哨兵本身不当附加指令展开
		const autoTriggered = event.customInstructions === AUTO_TRIGGER_INSTRUCTIONS;
		const reason = autoTriggered ? ("threshold" as const) : rawReason;
		const customInstructions = autoTriggered ? undefined : event.customInstructions;

		// 摘要模型：默认同当前模型（PI_ELENVA_SUMMARY_MODEL 可换，先留配置项）
		let model = ctx.model;
		const override = process.env.PI_ELENVA_SUMMARY_MODEL;
		if (override) {
			const slash = override.indexOf("/");
			if (slash > 0) {
				const found = ctx.modelRegistry.find(override.slice(0, slash), override.slice(slash + 1));
				if (found) model = found;
			}
		}
		if (!model) return; // 无模型 → 兜底走 pi 默认压缩

		const allMessages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
		if (!allMessages.length) return;
		const conversationText = serializeConversation(convertToLlm(allMessages));
		const prompt = buildCompactPrompt({
			conversationText,
			customInstructions,
			previousSummary: preparation.previousSummary,
		});

		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: prompt }],
							timestamp: Date.now(),
						},
					],
				},
				{ maxTokens: SUMMARY_MAX_TOKENS, signal, cacheRetention: "none", sessionId: uuidv7() },
			);
			const rawText = response.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join("\n");

			const parsed = parseSummaryOutput(rawText);
			if (!parsed) {
				appendTelemetry(makeTelemetryEvent("compact_failed", sessionId, {
					reason, stage: "parse", detail: "summary tag missing or empty; falling back to pi default",
				}));
				return undefined; // 兜底走 pi 默认压缩，绝不吞会话
			}

			// ③ 状态重建：近期文件回注 + 待办回注（其它会话态如实注明， 见 rebuild.ts）
			const lists = fileOpsLists(preparation.fileOps);
			const recentBlocks = pickRecentFiles(lists.readFiles, lists.modifiedFiles)
				.map((file) => {
					try {
						if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
						return { path: file, text: fs.readFileSync(file, "utf8") };
					} catch {
						return null;
					}
				})
				.filter((block): block is { path: string; text: string } => block !== null);
			const recentFiles = buildRecentFilesSection(recentBlocks);
			const todos = extractLatestTodos(ctx.sessionManager.getEntries());
			const attachments = buildStateAttachments({
				recentFiles,
				todos: todos ? renderTodoSection(todos) : null,
			});

			// 续接三件套：续接头 + 转录回读指针 + 按 reason 分流的续跑句
			const summary = assembleContinuationSummary({
				cleanedSummary: formatCleanedSummary(parsed),
				attachments,
				transcriptPath: ctx.sessionManager.getSessionFile(),
				reason,
				customInstructions,
			});
			if (!summary.trim()) {
				appendTelemetry(makeTelemetryEvent("compact_failed", sessionId, { reason, stage: "assemble" }));
				return undefined;
			}

			compactionHistory.unshift({
				ts: new Date().toISOString(),
				reason,
				tokensBefore: preparation.tokensBefore,
			});
			pendingRecordedTokensBefore = preparation.tokensBefore;
			appendTelemetry(makeTelemetryEvent("compact", sessionId, {
				reason,
				pre: preparation.tokensBefore,
				usage: response.usage ?? null,
				ms: Date.now() - startedAt,
				summaryTokens: Math.round(rawText.length / 4),
			}));
			return {
				compaction: {
					summary,
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					usage: response.usage,
					// 细节保持 {readFiles, modifiedFiles} 同形，保住 pi 内建的跨压缩文件累加
					details: { ...lists, elenvaCompact: { reason, ms: Date.now() - startedAt } },
				},
			};
		} catch (error) {
			appendTelemetry(makeTelemetryEvent("compact_failed", sessionId, {
				reason,
				stage: "generate",
				error: error instanceof Error ? error.message : String(error),
			}));
			return undefined; // 生成失败 → pi 默认压缩兜底
		}
	});

	pi.on("session_compact", (event) => {
		warnedLow = false;
		// 本扩展已记录（pendingRecordedTokensBefore 对上）→ 只复位警示位，不重复入史；
		// 对不上（pi 默认压缩兜底等路径）→ 按 event.reason 正常记录
		if (
			pendingRecordedTokensBefore !== undefined &&
			event.compactionEntry.tokensBefore === pendingRecordedTokensBefore
		) {
			pendingRecordedTokensBefore = undefined;
			return;
		}
		pendingRecordedTokensBefore = undefined;
		compactionHistory.unshift({
			ts: new Date().toISOString(),
			reason: event.reason,
			tokensBefore: event.compactionEntry.tokensBefore,
		});
	});

	pi.on("session_compact_failed", (event) => {
		appendTelemetry(makeTelemetryEvent("compact_failed", sessionId, {
			reason: event.reason,
			stage: "session",
			error: event.errorMessage ?? null,
			aborted: event.aborted ?? null,
		}));
	});

	/* ── 状态复位 ── */
	pi.on("session_start", (_event, ctx) => {
		sessionId = ctx.sessionManager.getSessionId();
		savedResults = new Map();
		microStats = { count: 0, tokensSaved: 0 };
		triggerArmed = true;
		warnedLow = false;
		pendingRecordedTokensBefore = undefined;
	});

	/* ── ④ 触发与提示（agent_settled 补触发 + turn_end 状态行；两条线的交互见 trigger.ts 头注 / README） ── */
	pi.on("turn_end", (_event, ctx) => {
		if (triggerDisabled) return;
		const usage = ctx.getContextUsage();
		if (!usage) return;
		const pctOverride = parsePctOverride(process.env.PI_AUTOCOMPACT_PCT_OVERRIDE);
		const triggerLine = autoTriggerTokens(usage.contextWindow, pctOverride);
		const percent = contextLeftUntilCompactPercent(usage.tokens, triggerLine);

		const status = statusLeftText(percent);
		if (status) ctx.ui.setStatus(STATUS_KEY, status);
		else if (usage.tokens === null) ctx.ui.setStatus(STATUS_KEY, undefined);

		const low = lowContextText(percent);
		if (low && !warnedLow && usage.tokens !== null) {
			warnedLow = true;
			ctx.ui.notify(low, "warning");
		}
	});

	// 补触发挂 agent_settled：v0.86.1 的 ctx.compact() 会先 abort 当前 agent 操作再压缩
	// （agent-session.js compact docstring），在 live run 中点火等于掐断正在收尾的 turn；
	// 且最后一个 turn_end 发生在 run 结算之前（isIdle 仍为 false），之后不再有 turn_end。
	// 所以：live 轮内交给 pi 原生 in-run 阈值检查，扩展在 run 完全结算后检查触发线，
	// 补的正是「tool batch 终结即 run 结束、无排队消息」原生跳过的缝隙。
	pi.on("agent_settled", (_event, ctx) => {
		if (triggerDisabled || !ctx.isIdle()) return;
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null) return;
		const triggerLine = autoTriggerTokens(usage.contextWindow, parsePctOverride(process.env.PI_AUTOCOMPACT_PCT_OVERRIDE));
		if (!triggerArmed && usage.tokens < triggerLine) triggerArmed = true;
		if (!triggerArmed || usage.tokens < triggerLine) return;
		triggerArmed = false;
		ctx.compact({
			customInstructions: AUTO_TRIGGER_INSTRUCTIONS,
			onComplete: () => {
				warnedLow = false;
			},
			onError: (error) => {
				// 会话 teardown / reload 后回调里的 ctx 可能已失效（assertActive 抛 stale）：
				// 失败已由 session_compact_failed 落遥测，这里只尽力提示
				try {
					ctx.ui.notify(`Error compacting conversation: ${error.message}`, "error");
				} catch {
					console.error(`[elenva-compact] compaction failed: ${error.message}`);
				}
			},
		});
	});

	/* ── ⑤ 命令 ── */
	const registerCompat = (name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]): void => {
		try {
			pi.registerCommand(name, options);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`[elenva-compact] 注册 /${name} 失败（可能重名）：${message}`);
		}
	};

	registerCompat("context", {
		description: "上下文治理报告：用量 / 触发线 / 微压缩统计 / 压缩历史",
		handler: async (_args, ctx) => {
			const report = buildContextReport(ctx, {
				microStats,
				history: compactionHistory,
				pctOverride: parsePctOverride(process.env.PI_AUTOCOMPACT_PCT_OVERRIDE),
				cacheDir,
				telemetryFile: telemetryPath(agentDir),
			});
			ctx.ui.notify(report, "info");
		},
	});

	registerCompat("microcompact", {
		description: "手动微压缩：下次模型调用前把旧的大工具结果落盘+指针（可带预算 token 数）",
		handler: async (args, _ctx) => {
			if (microDisabled) {
				_ctx.ui.notify("微压缩已被 PI_ELENVA_MICRO_DISABLE 关闭", "warning");
				return;
			}
			const argTokens = Number(args.trim());
			const budgetTokens = Number.isFinite(argTokens) && argTokens > 0 ? Math.floor(argTokens) : microBudget;
			manualMicroPending = { budgetTokens };
			_ctx.ui.notify(`微压缩已排定（budget=${budgetTokens}，手动模式跳过自动门槛）：下一次模型调用前执行`, "info");
		},
	});
}

/* ── /context 报告（纯函数，供测试） ── */

export interface ContextReportInputs {
	microStats: MicroStats;
	history: { ts: string; reason: string; tokensBefore: number }[];
	pctOverride: number | null;
	cacheDir: string;
	telemetryFile: string;
}

export function buildContextReport(
	ctx: ExtensionContext,
	inputs: ContextReportInputs,
): string {
	const lines: string[] = [];
	const usage = ctx.getContextUsage();
	if (usage) {
		const pctOverride = inputs.pctOverride;
		const triggerLine = autoTriggerTokens(usage.contextWindow, pctOverride);
		const percent = contextLeftUntilCompactPercent(usage.tokens, triggerLine);
		lines.push(
			"Context window: " + usage.contextWindow + " tokens",
			typeof usage.tokens === "number"
				? `Context used: ${usage.tokens} (${usage.percent === null ? "?" : Math.round(usage.percent)}%)`
				: "Context used: unknown (no reading yet)",
			`Auto-compact trigger line: ${triggerLine}${pctOverride !== null ? ` (PI_AUTOCOMPACT_PCT_OVERRIDE=${pctOverride})` : ""}`,
			percent !== null ? `Context left until auto-compact: ${percent}%` : "Context left until auto-compact: unknown",
		);
	} else {
		lines.push("Context usage unavailable（尚无用量读数）");
	}
	lines.push(
		"",
		`Microcompact this session: ${inputs.microStats.count} tool results, ≈${inputs.microStats.tokensSaved} tokens saved`,
		`Cache dir: ${inputs.cacheDir}`,
		`Telemetry: ${inputs.telemetryFile}`,
	);
	if (inputs.history.length) {
		lines.push("", "Compaction history (newest first):");
		for (const entry of inputs.history.slice(0, 10)) {
			lines.push(`  - ${entry.ts}  reason=${entry.reason}  tokensBefore=${entry.tokensBefore}`);
		}
	} else {
		lines.push("", "Compaction history: none yet");
	}
	return lines.join("\n");
}
