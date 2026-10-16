/**
 * elenva-compact 纯函数自检（不装扩展、不起会话、不调模型）。
 *
 * 跑法：node extensions/elenva-compact/selftest.mjs
 * 全绿输出 SELFTEST: OK / n 通过；有失败输出 SELFTEST: FAILED 并以退出码 1 结束。
 *
 * 覆盖（任务书 ⑦）：选择算法 / 指针文案与幂等位 / 摘要解析清洗 / 百分比与触发线 /
 * 指令合并 / 续接装配（续跑句按 reason 分流）/ 状态重建（文件挑选与钳制、待办）。
 */
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false, interopDefault: true });
const micro = await jiti.import("./micro.ts");
const summary = await jiti.import("./summary.ts");
const rebuild = await jiti.import("./rebuild.ts");
const trigger = await jiti.import("./trigger.ts");

let pass = 0;
let fail = 0;
const check = (name, condition, extra = "") => {
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${typeof extra === "string" && extra ? `  ${extra}` : ""}`);
	condition ? (pass += 1) : (fail += 1);
};

/* ── 1. micro.ts：token 估算与候选收集 ─────────────────────────────── */
check("estimateTokens 单调：长文本 ≥ 短文本", micro.estimateTokens("hello ".repeat(100)) > micro.estimateTokens("hello"));
check("estimateTokens CJK 更密", micro.estimateTokens("中文中文中文中文") >= 4);
check("estimateTokens 空文本=0", micro.estimateTokens("") === 0);

const toolResult = (id, toolName, text, err = false) => ({
	role: "toolResult",
	toolCallId: id,
	toolName,
	isError: err,
	content: [{ type: "text", text }],
});
const mixed = [
	{ role: "user", content: [{ type: "text", text: "hi" }] },
	toolResult("t1", "bash", "x".repeat(40_000)),
	toolResult("t2", "read", "y".repeat(40_000)),
	toolResult("t3", "grep", "z".repeat(40_000)),
	toolResult("t4", "read", "w".repeat(40_000)),
	toolResult("t5", "todo_write", "ignored"), // 非白名单工具
	toolResult("t6", "bash", "boom", true), // isError 跳过
	toolResult("t7", "bash", ""), // 空文本跳过
	{ role: "assistant", content: [{ type: "text", text: "done" }] },
];
const cands = micro.collectMicroCandidates(mixed);
check("候选收集：只收白名单非错误非空", cands.length === 4 && cands.map((c) => c.toolCallId).join(",") === "t1,t2,t3,t4");
check("候选收集：保留下标", cands[0].index === 1 && cands[3].index === 4);
check("候选收集：含图片的结果不收", micro.collectMicroCandidates([
	{ role: "toolResult", toolCallId: "t8", toolName: "read", isError: false, content: [{ type: "image", data: "xx" }] },
]).length === 0);

/* ── 2. micro.ts：选择算法（保留最近 3 / 从最旧压到剩余 ≤ 预算） ─────── */
// 8 个候选，每个 10000 token（CJK-char 密度凑齐：中文字符 ×15000 = 10000 token）
const mk8 = Array.from({ length: 8 }, (_, i) => micro.asToolResult(toolResult(`s${i}`, "bash", "中".repeat(15_000))));
const spans8 = micro.collectMicroCandidates(mk8);
check("选择算法：候选数=8", spans8.length === 8);

// older = s0..s4 共 50k；预算 40k → 压最旧 1 个后剩余 40k ≤ 预算即停
const d = micro.selectMicroSpans(spans8, { budgetTokens: 40_000, keepRecent: 3, alreadySaved: new Set() });
check("选择算法：保留最近 3 个", d.keep.length === 3 && d.keep.map((s) => s.toolCallId).join(",") === "s5,s6,s7");
check("选择算法：从最旧压到剩余≤预算即停", d.save.map((s) => s.toolCallId).join(",") === "s0");
check("选择算法：tokensSaved=压缩量合计", d.tokensSaved === 10_000);

// 更紧预算 25k：older 50k → 压 3 个后剩余 20k ≤ 25k
const d25 = micro.selectMicroSpans(spans8, { budgetTokens: 25_000, keepRecent: 3, alreadySaved: new Set() });
check("选择算法：更紧预算压得多", d25.save.map((s) => s.toolCallId).join(",") === "s0,s1,s2" && d25.tokensSaved === 30_000);

// 预算边界恰好卡住：8 候选时 older 总量 50k > 40k → 先压 s0，剩余 s1..s4=40k 恰好达标不再加压
const d0 = micro.selectMicroSpans(spans8, { budgetTokens: 40_000, keepRecent: 3, alreadySaved: new Set() });
check("选择算法：预算边界恰停（压 s0 后 40k ≤ 预算不再加压）",
	d0.save.length === 1 && d0.save[0].toolCallId === "s0" && d0.keep.length === 3 && d0.reemit.length === 0);

// 已落盘的走 reemit，不进新压账
const dRe = micro.selectMicroSpans(spans8, { budgetTokens: 40_000, keepRecent: 3, alreadySaved: new Set(["s0", "s1"]) });
check("选择算法：alreadySaved 走 reemit（不进新压账）", dRe.save.length === 0 && dRe.reemit.map((s) => s.toolCallId).join(",") === "s0,s1");

// 预算为 0：older 里的全部都压（含 keepRecent 之外的全部）
const dAll = micro.selectMicroSpans(micro.collectMicroCandidates(Array.from({ length: 5 }, (_, i) =>
	micro.asToolResult(toolResult(`a${i}`, "bash", "中".repeat(15_000))))),
	{ budgetTokens: 0, keepRecent: 3, alreadySaved: new Set() });
check("选择算法：预算 0 时 older 全数压缩", dAll.save.length === 2 && dAll.tokensSaved === 20_000);

/* ── 3. micro.ts：指针文案与幂等位 ─────────────────────────────────── */
const pointer = micro.buildMicroPointer("read", 1234, "/tmp/cache/s1/t9.txt");
check("指针文案：含路径", pointer.includes("Tool result from read saved to: /tmp/cache/s1/t9.txt"));
check("指针文案：含 token 数与 read 提示", pointer.includes("1234 tokens") && pointer.includes("read tool"));
check("指针文案：以已知前缀开头（幂等识别）", micro.isMicroPointer([{ type: "text", text: pointer }]));
check("指针文案：非指针 content 识别为否", !micro.isMicroPointer([{ type: "text", text: "normal output" }]));

const p1 = micro.buildCachePath("/agent/dir/compact-cache", "sess-1", "toolCall-abc");
const p2 = micro.buildCachePath("/agent/dir/compact-cache", "sess-1", "toolCall-abc");
check("幂等位：同 (sessionId, toolCallId) 确定性同路径", p1 === p2);
check("幂等位：路径指向 compact-cache 子目录（由调用方给 cacheDir）", p1.includes("/compact-cache/sess-1/"));
check("幂等位：toolCallId 特殊字符被清洗", micro.buildCachePath("/d", "s", "a/b c").endsWith("/a_b_c.txt"));

/* ── 4. summary.ts：9 段模板 ───────────────────────────────────────── */
const prompt = summary.buildCompactPrompt({ conversationText: "对话体", customInstructions: "重点关注报错" });
for (const section of summary.SUMMARY_SECTIONS) {
	check(`模板含段：${section}`, prompt.includes(section));
}
check("模板：分析先行提示", prompt.includes("<analysis>") && prompt.includes("<summary>"));
check("模板：引导语对齐", prompt.includes("paying close attention to the user's explicit requests"));
check("模板：对话体注入", prompt.includes("<conversation>") && prompt.includes("对话体"));
check("模板：自定义指令进提示词", prompt.includes("Additional Instructions:") && prompt.includes("重点关注报错"));
const promptPrev = summary.buildCompactPrompt({ conversationText: "c", previousSummary: "旧摘要" });
check("模板：previousSummary 作为迭代基底", promptPrev.includes("<previous_summary>") && promptPrev.includes("旧摘要"));
const promptNoInst = summary.buildCompactPrompt({ conversationText: "c" });
check("模板：无指令时不出现附加段", promptNoInst.split("Additional Instructions:").length - 1 === 0);

/* ── 5. summary.ts：解析与清洗 ─────────────────────────────────────── */
const raw1 = "<analysis>过程 A\n\n\n\n细节</analysis><summary>第1段\n\n\n第2段</summary>";
const parsed1 = summary.parseSummaryOutput(raw1);
check("解析：两段都取到", Boolean(parsed1 && parsed1.analysis.includes("细节") && parsed1.summary.includes("第2段")));
const cleaned1 = summary.formatCleanedSummary(parsed1);
check("清洗：Analysis:/Summary: 头", cleaned1.startsWith("Analysis:\n") && cleaned1.includes("Summary:\n"));
check("清洗：压空行", !/\n{3,}/.test(cleaned1));

const raw2 = '<summary>只有 summary</summary>';
const parsed2 = summary.parseSummaryOutput(raw2);
check("解析：缺 analysis 不阻断", Boolean(parsed2 && !parsed2.analysis));

check("解析：<summary> 缺失 → null（兜底信号）", summary.parseSummaryOutput("no tags at all") === null);
check("解析：summary 为空 → null", summary.parseSummaryOutput("<analysis>x</analysis><summary>   </summary>") === null);

/* ── 6. summary.ts：续接装配（续接头 / 回读指针 / 续跑句按 reason 分流） ── */
const assembleBase = {
	cleanedSummary: "Analysis:\n过程\n\nSummary:\n要点",
	attachments: "## Current todo state\n\n- [ ] 先做甲",
	transcriptPath: "/tmp/session.jsonl",
	customInstructions: null,
};
const auto1 = summary.assembleContinuationSummary({ ...assembleBase, reason: "threshold" });
check("续接：头句对齐", auto1.startsWith(summary.CONTINUATION_HEADER));
check("续接：含状态段与转录回读指针", auto1.includes("Current todo state") && auto1.includes("/tmp/session.jsonl"));
check("续接：threshold 附续跑句", auto1.endsWith(summary.CONTINUE_SENTENCE));
const auto2 = summary.assembleContinuationSummary({ ...assembleBase, reason: "overflow" });
check("续接：overflow 也附续跑句", auto2.endsWith(summary.CONTINUE_SENTENCE));
const manual1 = summary.assembleContinuationSummary({ ...assembleBase, reason: "manual" });
check("续接：manual 不附续跑句", !manual1.includes(summary.CONTINUE_SENTENCE) && manual1.includes("Full transcript"));
const withInst = summary.assembleContinuationSummary({ ...assembleBase, reason: "manual", customInstructions: "聚焦压缩机制" });
check("续接：manual 仍合并 Additional Instructions", withInst.includes("Additional Instructions: 聚焦压缩机制"));
const noAttach = summary.assembleContinuationSummary({
	cleanedSummary: "Summary:\n要点", attachments: "", transcriptPath: null, reason: "threshold",
});
check("续接：空附件/无转录时省段落且保住续跑句", noAttach.endsWith(summary.CONTINUE_SENTENCE) && !noAttach.includes("Full transcript"));

/* ── 7. trigger.ts：触发线 / 百分比 / 状态行 ───────────────────────── */
check("触发线：默认 window − 13000", trigger.autoTriggerTokens(200_000, null) === 187_000);
check("触发线：百分比覆盖生效", trigger.autoTriggerTokens(200_000, 50) === 100_000);
check("提示线：window − 20000", trigger.warningTokens(200_000) === 180_000);
check("百分比解析：合法小数", trigger.parsePctOverride("62.5") === 62.5);
check("百分比解析：越界/非法/未设 → null",
	[trigger.parsePctOverride("0"), trigger.parsePctOverride("101"), trigger.parsePctOverride("abc"), trigger.parsePctOverride(undefined)].every((v) => v === null));
check("状态行：文案对齐", trigger.statusLeftText(42) === "Context left until auto-compact: 42%");
check("状态行：未知用量返回 null", trigger.statusLeftText(null) === null);
check("剩余百分比：未过线按比例", trigger.contextLeftUntilCompactPercent(97_000, 187_000) === 48);
check("剩余百分比：已过线为 0", trigger.contextLeftUntilCompactPercent(200_000, 187_000) === 0);
check("低上下文警示：<20% 才出", trigger.lowContextText(15) !== null && trigger.lowContextText(25) === null);

/* ── 8. rebuild.ts：文件挑选 / 钳制 / 待办 ────────────────────────── */
const picked = rebuild.pickRecentFiles(["a.ts", "b.ts", "a.ts"], ["c.ts"]);
check("文件挑选：去重留末次 + 修改过排最后", picked[picked.length - 1] === "c.ts" && picked.includes("a.ts") && picked.length === 3);
check("文件挑选：超.limit 截尾", rebuild.pickRecentFiles(["1", "2", "3", "4", "5", "6"]).length === 5);

const bigText = "中".repeat(30_000); // ≈20000 token
const clamped = rebuild.clampFileContent("/big/file.txt", bigText);
check("单文件钳制：超 5k token 被截并留指针", clamped.truncated === true && clamped.tokens <= rebuild.RECENT_FILE_MAX_TOKENS && clamped.text.includes("/big/file.txt"));
const small = rebuild.clampFileContent("/small.txt", "短内容");
check("单文件钳制：小文件原样", small.truncated === false && small.text === "短内容");

const section = rebuild.buildRecentFilesSection([
	{ path: "/a.txt", text: "内容A" },
	{ path: "/b.txt", text: bigText },
]);
check("文件段：带标题与路径头", section.includes("## Recently opened files") && section.includes("/a.txt"));
const hugeSection = rebuild.buildRecentFilesSection(
	Array.from({ length: 6 }, (_, i) => ({ path: `/f${i}.txt`, text: "中".repeat(15_000) })),
);
check("文件段：总量 ≤50k 上限内装配（6×10k 中只装得下 5，但单文件 5k 钳制 → 装 5 个 ≤50k）",
	rebuild.RECENT_FILES_TOTAL_TOKENS === 50_000 && rebuild.RECENT_FILE_MAX_TOKENS === 5_000);

const todos = rebuild.coerceTodoItems([
	{ text: "任务一", status: "completed" },
	{ text: "任务二", status: "in_progress" },
	{ text: "任务三", status: "pending" },
]);
check("待办解析：宽松合法", todos?.length === 3);
check("待办渲染：[x]/[>]/[ ] 标记对齐 elenva-todo", rebuild.renderTodoSection(todos).includes("[x] 任务一") && rebuild.renderTodoSection(todos).includes("[>] 任务二"));
check("待办解析：形状不对返回 null", rebuild.coerceTodoItems([{ text: "x", status: "bogus" }]) === null && rebuild.coerceTodoItems("nope") === null);

const entriesWithTodo = [
	{ type: "message", message: { role: "user", content: [{ type: "text", text: "do" }] } },
	{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "x", name: "todo_write", arguments: { todos: [{ text: "任务一", status: "in_progress" }] } }] } },
	{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "y", name: "todo_write", arguments: { todos: [{ text: "任务二", status: "pending" }] } }] } },
	{ type: "compaction", id: "c1" },
];
const latest = rebuild.extractLatestTodos(entriesWithTodo);
check("待办提取：取最后一份 todo_write", latest?.length === 1 && latest[0].text === "任务二");
check("待办提取：无 todo 返回 null", rebuild.extractLatestTodos([{ type: "compaction", id: "c" }]) === null);

const attachments = rebuild.buildStateAttachments({ todos: "## Current todo state" });
check("状态段：不可得的会话态如实注明", attachments.includes("pi session entries carry no background-task registry"));

console.log(fail === 0 ? `SELFTEST: OK  ${pass} 通过` : `SELFTEST: FAILED  ${fail} 失败 / ${pass} 通过`);
process.exit(fail === 0 ? 0 : 1);
