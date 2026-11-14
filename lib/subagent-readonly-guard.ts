import type { BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import { isReadOnlyShellCommand } from "./readonly-command";

/**
 * 只读子代理的 shell 护栏 —— 把「不许改东西」从**提示词自觉**变成**工具面强制**。
 *
 * ## 为什么需要
 *
 * 内置「复核员」模板要给 `bash`（它必须能跑检查拿真实输出，见
 * 《深入理解 AI Agent》ch10「多 Agent 何时真正优于单 Agent」：审核者必须引入
 * 执行反馈 / 工具反馈才有效），但 `bash` 本身是可写的（`echo > f` / `rm -rf`）。
 * 模板的 `systemPrompt` 里写了「禁止修改」，那只是**自觉**：模型一时走神，
 * 工具面就会如实执行写命令，而事后无法从「核验失效」里分辨是哪一步越的界。
 *
 * 这里补的是工具面的闸门：**只读子代理**的非只读 shell 命令直接拒绝，
 * 拒绝理由写进 toolResult 返回给模型，让它自己换一条只读命令、或把改动写进结论。
 *
 * ## 判据（与任务书口径一致，单一事实来源）
 *
 *   · **只读子代理** = 该子代理的活动工具集**既不含 `edit` 也不含 `write`**。
 *     工具集是子代理 profile 的显式声明，`bash` 缺了写工具即是「我不改东西」的意思；
 *     工具面此前与这个声明矛盾，护栏把它对齐。
 *   · **只读命令** = 复用 `lib/readonly-command.ts` 的 `isReadOnlyShellCommand`
 *     （与计划模式 / 节律 readonly 档同一判据、同一保证范围：它是启发式分类器，
 *     不是沙箱；见该文件头「保证范围」）。
 *
 * ## 已知缺口（有意保留，别当它拦得住）
 *
 *   · 该判据只覆盖 `bash`。`powershell` **不在内**：`isReadOnlyShellCommand` 的白名单
 *     是 POSIX 语义的，拿它判 PowerShell（`Get-ChildItem`…）会把合法只读命令全拒，
 *     反而废掉 Windows 上的复核员。要覆盖需另写 PowerShell 分类器，本轮不做。
 *   · 只挡「模型直接发的 bash 调用」。扩展工具内部再调 shell（codemode 的 executeTool
 *     之类的嵌套调用）走的是内核另一条钩子（`_beforeToolCall(context, parentToolCallId)`），
 *     不经过这里。当前三个内置只读模板都不加载扩展，实际不可达。
 *   · 分类器放过「测试运行器」（`pytest` / `npm test`…，见 readonly-command 文件头）——
 *     这是**有意**的：只读子代理的核心勘察手段就是跑检查，它可能写临时文件，接受。
 *
 * ## 与内核钩子的关系（契约以内核代码为准，勿凭记忆改）
 *
 * 内核在构造时**已经占用了** `agent.beforeToolCall`：
 * `dist/core/agent-session.js:309-310` 的 `_installAgentToolHooks()` 把
 * `agent.beforeToolCall = (context) => this._beforeToolCall(context)`，
 * 用于派发扩展的 `tool_call` 事件（宿主护栏、审批闸门都在那条链上）。
 * 因此这里**包一层、保留原调用链**（先跑原钩子，再叠加只读策略），绝不覆盖。
 *
 * 返回值契约（`dist/core/extensions/types.d.ts:1046` 的 `ToolCallEventResult`；
 * 消费点在 `@earendil-works/pi-agent-core/dist/agent-loop.js` 的 `prepareToolCall`）：
 *   · 返回 `undefined` → 放行；
 *   · 返回 `{ block: true, reason?: string, terminate?: boolean }` → 工具不执行，
 *     以 `reason` 作为 `isError: true` 的 toolResult 返回给模型；
 *   · 钩子抛错 → 被 `prepareToolCall` 捕获，同样变成 `isError` 的 toolResult（不崩会话）。
 */

/** 判定「只读子代理」时视为写工具的两个内置工具名（大写无关，工具名本就是小写） */
const WRITE_TOOL_NAMES = ["edit", "write"] as const;

/** 受本护栏约束的 shell 工具名（见「已知缺口」：powershell 有意不在内） */
const GUARDED_SHELL_TOOLS = new Set(["bash"]);

/** 拒绝理由里回显命令的上限，避免超长命令刷屏 */
const MAX_COMMAND_CHARS = 200;

export type BeforeToolCallHookLike = (
  context: BeforeToolCallContext,
  signal?: AbortSignal,
) => Promise<BeforeToolCallResult | undefined>;

/** 子代理的「只读」判据：活动工具集不含 write、也不含 edit */
export function isReadOnlySubagentTools(tools: readonly string[]): boolean {
  return !WRITE_TOOL_NAMES.some((name) => tools.includes(name));
}

function commandOf(args: unknown): string {
  if (args !== null && typeof args === "object" && typeof (args as { command?: unknown }).command === "string") {
    return (args as { command: string }).command;
  }
  return "";
}

function truncateCommand(command: string): string {
  const trimmed = command.trim();
  return trimmed.length <= MAX_COMMAND_CHARS ? trimmed : `${trimmed.slice(0, MAX_COMMAND_CHARS - 1)}…`;
}

/**
 * 纯判定：这次工具调用是否要被只读子代理护栏拦下。
 * 命中返回 `{ block: true, reason }`，否则 `undefined`（放行）。
 */
export function readOnlySubagentViolation(
  toolName: unknown,
  args: unknown,
): BeforeToolCallResult | undefined {
  if (typeof toolName !== "string" || !GUARDED_SHELL_TOOLS.has(toolName)) return undefined;
  const command = commandOf(args);
  if (isReadOnlyShellCommand(command)) return undefined;
  const shown = truncateCommand(command);
  return {
    block: true,
    reason: [
      "该子代理为只读：只做勘察与验证，不接受写入 / 删除 / 改动类命令。",
      shown ? `被拒绝的命令：${shown}` : "被拒绝的命令：<空命令>",
      "请改用只读命令（例如 git status / rg / cat）；需要改动的部分写进结论，交由委派者执行。",
    ].join("\n"),
  };
}

/**
 * 给子代理会话装上只读 shell 护栏。**只读子代理**（工具集不含 edit/write）才装，
 * 其余原样返回。返回是否真的装上了（供调用点记录 / 自测断言）。
 *
 * 保留原钩子：先跑内核/扩展链，再叠加本护栏 —— 这样既不改动既有 `tool_call`
 * 语义（宿主护栏、审批闸门照常生效），又能在参数被扩展改写后判最终的 `args`。
 */
export function installReadOnlySubagentGuard(
  agent: { beforeToolCall?: BeforeToolCallHookLike },
  tools: readonly string[],
): boolean {
  if (!isReadOnlySubagentTools(tools)) return false;
  const previous = agent.beforeToolCall;
  agent.beforeToolCall = async (context, signal) => {
    const upstream = previous ? await previous(context, signal) : undefined;
    if (upstream?.block) return upstream; // 内核/扩展已经拦了：以它为准，不抢结论
    return readOnlySubagentViolation(context?.toolCall?.name, context?.args) ?? upstream;
  };
  return true;
}
