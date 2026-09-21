/**
 * ELENVA 双层记忆 —— 常驻「索引层」 + 整理层（tidy）
 *
 * ## 它在补什么
 *
 * `pi-hermes-memory` 的默认模式（legacy-inject）把 MEMORY.md / USER.md / 项目记忆**全文**塞进
 * 每一轮的系统提示词，四份文件长期贴顶后每轮要背 9K+ 字符；而真正常用的检索（memory_search）
 * 只在溢出时才有机会被用到。
 *
 * 《深入理解 AI Agent》ch3 的两条结论正好构成解法：
 * - **L482（文件系统范式 / L0-L1-L2 渐进披露）**：知识应有「摘要常驻、按需取全文」的分层，
 *   并显式维护索引页与链接 —— 否则知识越多越难检索；
 * - **实验 3-11 结语（双层记忆架构）**：少量关键事实常驻（概览），海量细节用检索按需取（细节），
 *   「只靠常驻会丢细节，只靠检索会没全局视野」。
 *
 * 所以这一层做三件事：
 * 1. **常驻索引**：每轮注入每条目一行摘要（预算内），并明确要求「细节先 memory_search 取原文」；
 * 2. **访问计数**：钩住 `tool_result`，记忆检索命中即回写计数 —— 补上 pi-hermes-memory
 *    「last_referenced 只在写入时更新」的缺口（ch3 L221 的重要性评分需要访问频率）；
 * 3. **整理（tidy）**：去重、冲突识别（**保留冲突、标注待确认，不强行合并**，ch3 L505）、
 *    按重要性给出淘汰建议；`--apply` 时把被淘汰/被合并的条目**归档**而不是删除。
 *
 * ## 依据与偏离
 *
 * 依据（章节 + 行号）：ch3 L221、L482、L505、L594 结语，见 `docs/agent-design-standard.md`「记忆系统的评估」。
 * 偏离（已登记）：书里的 L0/L1 摘要由模型在**写入时**生成；我们先用**确定性截断摘要**（零模型调用、
 * 可回归），若评估显示可检索性下降再升级为 LLM 摘要。
 *
 * ## 与 pi-hermes-memory 的分工
 *
 * | 谁 | 管什么 |
 * |---|---|
 * | pi-hermes-memory | 记忆的**读写工具**（memory_add / replace / remove / search）、存储格式、配额 |
 * | 本扩展 | （配置为 `memoryMode: "policy-only"` 后）**常驻索引的注入**、访问计数、整理与归档 |
 *
 * 两边的契约是**文件格式**（`\n§\n` 分隔 + 尾部 `<!-- created=…, last=… -->`），
 * 本扩展从不改这个格式，也只改「条目集合」，不动条目内部文本（除归档动作）。
 *
 * ## 注入位置（2026-09-20 改）
 *
 * 索引块作为**上下文末尾的一条 user 消息**注入（`pi.on("context")` + `<memory_index>` 标记包裹），
 * 不再是改系统提示词 —— 依据 ch2 **L914**（动态信息追加末尾、静态前缀不动；改 system 会让整个前缀的 KV Cache 失效）；
 * 更新方式用 **L945 的实现一**：注入前先摘掉上轮那条，只让上次注入后的短后缀失效。
 *
 * ## 安装
 *
 *   node extensions/elenva-memory/install.mjs         # 复制到 ~/.pi/agent/extensions/elenva-memory/
 *   # 然后把 ~/.pi/agent/hermes-memory-config.json 的 memoryMode 改成 "policy-only"
 *
 * 两侧（网页内核与 CLI / 飞书守护进程）都会从 agent 目录的 extensions/ 自动加载。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { buildIndexBlock, stripIndexMessages } from "./index-block.js";
import { loadState, recordAccess, recordEvidence, recordToolCall, saveState, stateDirFor } from "./state.js";
import { runTidy, renderTidyReport } from "./tidy.js";
import { readAllStores } from "./stores.js";
import { renderSearchResults, searchEntries } from "./search.js";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** 注入索引的字符预算（可用环境变量覆盖；0 表示关闭注入）。 */
function indexBudget(): number {
  const raw = process.env.ELENVA_MEMORY_INDEX_BUDGET;
  if (raw === undefined) return 1600;
  if (raw.trim() === "off") return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1600;
}

function indexEnabled(): boolean {
  return process.env.ELENVA_MEMORY_INDEX !== "off" && indexBudget() > 0;
}

export default function elenvaMemory(pi: ExtensionAPI): void {
  // ── 1. 常驻索引：每轮把「记忆目录」追加到**上下文末尾** ────────────────────
  //
  // 依据《深入理解 AI Agent》ch2 L914：状态类动态信息应当**追加到上下文末尾**，
  // 而不是修改开头的 system 消息 —— 改 system 会让整个前缀的 KV Cache 失效；
  // 追加在末尾则离新生成的 token 最近（注意力权重最高），且前缀始终稳定。
  // L945 的「实现一（每轮替换）」：注入前先摘掉上轮那条，只让上次注入后的短后缀失效。
  pi.on("context", async (event, ctx) => {
    if (!indexEnabled()) return;
    try {
      const state = loadState();
      const stores = readAllStores(ctx.cwd);
      const block = buildIndexBlock(stores, state, indexBudget());
      if (!block) return;
      writeIndexLog(ctx, stores, block);
      return {
        messages: [
          ...stripIndexMessages(event.messages),
          { role: "user", content: block, timestamp: Date.now() },
        ],
      };
    } catch (error) {
      // 索引层坏掉不能拖垮会话；但要在会话里说清楚，别静默降级。
      const message = error instanceof Error ? error.message : String(error);
      return {
        messages: [
          ...stripIndexMessages(event.messages),
          {
            role: "user",
            content: `<memory_index>\n（ELENVA 记忆索引注入失败：${message}。这轮没有记忆概览，需要时用 memory_search 检索。）\n</memory_index>`,
            timestamp: Date.now(),
          },
        ],
      };
    }
  });

  // ── 2. 检索工具：多信号重排 + 上下文前缀 + 来源标记（ch3 L385 / L594 / L542）───
  pi.registerTool({
    name: "memory_find",
    label: "记忆检索（重排）",
    description:
      "在长期记忆里检索，返回带来源与重排分数的原文。比 memory_search 多三样：相关性重排（词面+相似+重要性）、每条来源置信（scope/日期/引用次数/写入方式）、与其它条目的冲突标注。想不起细节、需要确认某条约定时先用它。",
    parameters: Type.Object({
      query: Type.String({ description: "检索词：人名、项目名、命令、数字、关键词，中英文都行" }),
      limit: Type.Optional(Type.Number({ description: "返回条数，默认 5" })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const stores = readAllStores(ctx.cwd);
      const state = loadState();
      const limit = Number.isFinite(params.limit) ? Math.max(1, Math.min(20, Number(params.limit))) : 5;
      const hits = searchEntries(stores, state, String(params.query ?? ""), limit);
      return {
        content: [{ type: "text", text: renderSearchResults(hits, String(params.query ?? "")) }],
        details: { hits: hits.length },
      };
    },
  });

  // ── 3. 检索命中回写访问计数（ch3 L221）＋写入回写证据（ch3 L505）──────
  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return;
    const text = event.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n");
    if (!text) return;
    try {
      const stores = readAllStores(ctx.cwd);
      if (event.toolName.startsWith("memory_") || event.toolName === "session_search") {
        recordToolCall(event.toolName);
        saveState();
      }
      if (event.toolName === "memory_search" || event.toolName === "session_search" || event.toolName === "memory_find") {
        if (recordAccess(stores, text) > 0) saveState();
        return;
      }
      if (event.toolName === "memory_add" || event.toolName === "memory_replace") {
        // 内容取自**入参**：这两个工具的返回值不回显正文（只有 "Entry added."）
        const raw = ["content", "new_text", "text"]
          .map((key) => (event.input as Record<string, unknown> | undefined)?.[key])
          .find((value): value is string => typeof value === "string" && value.trim().length > 0);
        if (raw && recordEvidence(stores, event.toolName, raw, ctx.cwd) > 0) saveState();
      }
    } catch {
      // 计数/留痕失败不影响检索与写入本身
    }
  });

  // ── 3. 整理：/memory-tidy [--apply] ────────────────────────────────────────
  pi.registerCommand("memory-tidy", {
    description: "整理记忆：去重、标注冲突、按重要性给出淘汰建议（--apply 执行归档）",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await handleTidy(args, ctx);
    },
  });

  // ── 4. 周期整理：距上次整理超过 N 天，开场静默跑一次（只报告，不动数据）──
  pi.on("session_start", async (_event, ctx) => {
    try {
      const state = loadState();
      const last = state.tidy?.lastRunAt ? Date.parse(state.tidy.lastRunAt) : 0;
      const days = (Date.now() - last) / 86400000;
      if (last > 0 && days < 3) return;
      const stores = readAllStores(ctx.cwd);
      const result = runTidy(stores, state, { apply: false });
      state.tidy = {
        lastRunAt: new Date().toISOString(),
        lastSummary: result.summary,
        report: renderTidyReport(result),
      };
      state.conflicts = result.conflicts;
      saveState(state);
    } catch {
      // 周期整理失败不打扰会话；/memory-tidy 仍可手动跑
    }
  });
}

async function handleTidy(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const apply = /(^|\s)--apply(\s|$)/.test(args);
  try {
    const state = loadState();
    const stores = readAllStores(ctx.cwd);
    const result = runTidy(stores, state, { apply });
    state.tidy = {
      lastRunAt: new Date().toISOString(),
      lastSummary: result.summary,
      report: renderTidyReport(result),
    };
    state.conflicts = result.conflicts;
    saveState(state);

    const report = renderTidyReport(result);
    ctx.ui?.notify?.(
      `记忆整理${apply ? "（已应用）" : "（仅报告）"}：${result.summary}`,
      "info",
    );
    console.log(report);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui?.notify?.(`记忆整理失败：${message}`, "error");
    console.log(`记忆整理失败：${message}`);
  }
}

/** index-log 节流：context 钩子在**每次 LLM 调用前**都触发（含工具循环），不节流会把日志写爆。 */
let lastIndexLogAt = 0;
const INDEX_LOG_INTERVAL_MS = 30_000;

/** 把「这轮索引注入了多少字符」落到状态目录，供评估与自查读取。 */
function writeIndexLog(ctx: ExtensionContext, stores: ReturnType<typeof readAllStores>, block: string): void {
  try {
    const now = Date.now();
    if (now - lastIndexLogAt < INDEX_LOG_INTERVAL_MS) return;
    lastIndexLogAt = now;
    const dir = stateDirFor();
    fs.mkdirSync(dir, { recursive: true });
    const record = {
      at: new Date().toISOString(),
      cwd: ctx.cwd,
      chars: block.length,
      storedChars: stores.stores.reduce((sum, store) => sum + store.rawChars, 0),
      entries: stores.stores.reduce((sum, store) => sum + store.entries.length, 0),
    };
    fs.appendFileSync(path.join(dir, "index-log.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    /* 日志失败不影响注入 */
  }
}
