/**
 * ELENVA 工作记录 —— 给 Agent 补上「情景记忆的当前段」。
 *
 * ## 它在补什么
 *
 * 记忆（pi-hermes-memory + elenva-memory）管的是**跨会话长期有效**的事实与教训，有界（4000 字符）；
 * 但「我们这轮在做什么、做到哪一步、验证过什么」没有任何持久载体 —— 会话一压缩就丢，
 * 用户问「到哪了」只能现场口述。旧的 pi-memory 有 SCRATCHPAD，换到 hermes 后这一层没了。
 *
 * 《深入理解 AI Agent》ch2 L851「Agent 状态栏」给了完整解法：
 * - **L855**：把任务进度/环境状态整理成摘要，持续注入上下文，模型每轮「瞥一眼」；
 *   对治的正是「无限循环、状态遗忘、目标偏离」；
 * - **L914**：注入位置是**上下文末尾的一条 user 消息**，不是 system（改 system 会破坏整个前缀的 KV Cache）；
 * - **实验 2-8**：带状态栏后每次迭代的思考 token / 延迟 / 花费降约一个数量级。
 *
 * ## 三件事
 *
 * 1. **状态栏注入**（`context` 钩子）：每轮 LLM 调用前，把最近一条工作记录 + 未完成待办
 *    作为 user 消息追加到消息列表末尾；注入前先摘掉上一轮注入的那条（实现一：每轮替换，
 *    只让「上次注入之后新增的后缀」失效，前缀缓存不受影响 —— 见 ch2 L945）。
 * 2. **worklog_write / worklog_read**：写入与读取工作记录（一次工作一条：目标/做了什么/证据/待办）。
 * 3. 命令 `/worklog`：用户随时查看。
 *
 * ## 与记忆的分工（ch3 L170 的三类记忆）
 *
 * 工作记录 = 情景记忆的当前段（滚动窗口）；记忆 = 语义记忆（长期、有界）。
 * 整理时把工作记录里值得长期留下的**提炼**进记忆，别什么都往 4000 字符里塞。
 *
 * 安装：`node extensions/elenva-worklog/install.mjs`（复制到 `<agentRoot>/extensions/elenva-worklog/`）。
 */
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { appendEntry, nowStamp, readWorklog, renderWorklog, type WorklogEntry, type WorklogStatus } from "./store.js";
import { buildStatusBlock, statusBudget, stripStatusMessages } from "./status.js";

const STATUS_VALUES: WorklogStatus[] = ["done", "doing", "blocked"];

function optionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function asStatus(value: unknown): WorklogStatus {
  return STATUS_VALUES.includes(value as WorklogStatus) ? (value as WorklogStatus) : "done";
}

export default function elenvaWorklog(pi: ExtensionAPI): void {
  // ── 1. 状态栏：每轮 LLM 调用前注入（ch2 L851 / L914 / L945）───────────────
  pi.on("context", async (event, ctx) => {
    try {
      if (statusBudget() <= 0) return;
      const file = readWorklog(ctx.cwd);
      const block = buildStatusBlock(file);
      if (!block) return;
      const messages = stripStatusMessages(event.messages);
      return {
        messages: [...messages, { role: "user", content: block, timestamp: Date.now() }],
      };
    } catch {
      // 状态栏坏掉不能拖垮会话；静默跳过本轮注入
      return;
    }
  });

  // ── 2. 写入：worklog_write ────────────────────────────────────────────────
  pi.registerTool({
    name: "worklog_write",
    label: "写工作记录",
    description:
      "把本轮工作记进项目工作记录（一次工作一条：目标/做了什么/证据/待办）。一段工作收尾时调用；用户问「做到哪一步了」时也靠它回答。记录的最新一条会以状态栏形式注入后续每一轮，所以标题与待办要短（标题 ≤40 字）。",
    parameters: Type.Object({
      title: Type.String({ description: "一句话标题：这轮做成了什么（≤40 字）" }),
      goal: Type.Optional(Type.String({ description: "目标：这轮要解决什么问题" })),
      did: Type.Optional(Type.String({ description: "做了什么：改动的文件 / 模块" })),
      evidence: Type.Optional(Type.String({ description: "证据：跑过哪些验证、结果如何（tsc / 夹具 / 实测 / 截图）" })),
      todo: Type.Optional(Type.String({ description: "未完成的待办；没有就省略。它会出现在状态栏里" })),
      status: Type.Optional(Type.String({ description: "done（默认）| doing | blocked" })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const entry: WorklogEntry = {
        at: nowStamp(),
        title: optionalText(params.title) ?? "（未命名）",
        status: asStatus(params.status),
        goal: optionalText(params.goal),
        did: optionalText(params.did),
        evidence: optionalText(params.evidence),
        todo: optionalText(params.todo),
      };
      const result = appendEntry(ctx.cwd, entry);
      const lines = [
        `已记入工作记录（${result.file.projectName ?? "本目录"}）：${entry.title}`,
        `文件：${result.file.path}`,
      ];
      if (result.archived) lines.push(`最旧的条目已归档 → ${result.archived}`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { path: result.file.path, entries: result.file.entries.length },
      };
    },
  });

  // ── 3. 读取：worklog_read ────────────────────────────────────────────────
  pi.registerTool({
    name: "worklog_read",
    label: "读工作记录",
    description:
      "读项目工作记录（最近的工作、验证证据与待办）。接手一个长任务、被问「做到哪一步了」、或需要知道上一段工作的结论时用它。",
    parameters: Type.Object({
      tail: Type.Optional(Type.Number({ description: "看最近几条，默认 5" })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const file = readWorklog(ctx.cwd);
      if (file.entries.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `还没有工作记录（${file.path}）。一段工作收尾时用 worklog_write 记一条。`,
            },
          ],
          details: { entries: 0 },
        };
      }
      const tail = Number.isFinite(params.tail) ? Math.max(1, Math.min(50, Number(params.tail))) : 5;
      return {
        content: [{ type: "text", text: renderWorklog(file, tail) }],
        details: { entries: file.entries.length, path: file.path },
      };
    },
  });

  // ── 4. 命令：/worklog ────────────────────────────────────────────────────
  pi.registerCommand("worklog", {
    description: "看当前项目的工作记录（最近的工作、证据与待办）",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      try {
        const file = readWorklog(ctx.cwd);
        if (file.entries.length === 0) {
          const message = `还没有工作记录（${file.path}）。`;
          ctx.ui?.notify?.(message, "info");
          console.log(message);
          return;
        }
        const tail = /--all\b/.test(args) ? 50 : 5;
        const text = renderWorklog(file, tail);
        ctx.ui?.notify?.(`工作记录：${file.entries.length} 条（最近 ${Math.min(tail, file.entries.length)} 条已打印）`, "info");
        console.log(text);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui?.notify?.(`读工作记录失败：${message}`, "error");
        console.log(`读工作记录失败：${message}`);
      }
    },
  });
}
