/**
 * elenva-host-guard —— CLI / 飞书侧的宿主硬护栏（模块 5 · 第 5 轮）。
 *
 * ## 它在补什么
 *
 * web 的审批闸门长在 ELENVA 进程内（`lib/host-guardrails-extension.ts`），
 * 覆盖不到**独立 pi 进程**：`pi` CLI 交互会话、飞书守护进程拉起的 `pi --mode rpc`
 * 会话都没有护栏（`docs/security.md` 也明说 pi「does not ask for approval before
 * every tool call」）。本扩展在那些会话里补上那一层。
 *
 * ## 行为（命中时）
 *
 * 无交互通道，所以**不做挂起**（挂起会把无人值守会话晾死），而是：
 *   ① 把这次调用登记进 ELENVA 审批队列（工作台「等你处理」，与 web 同一文件、同一格式）；
 *   ② 在会话内**拒绝执行**，并把「已登记、别原样重试」一句话回给模型。
 *
 * ## 宿主判别（关键）
 *
 * 只在非 ELENVA 宿主生效；在 ELENVA Web 进程里**整体静默**（不注册 handler），
 * 否则同一条命令会先被本扩展拦、再被 web 闸门拦 —— 双闸。判据与理由见 `host.ts`。
 *
 * ## 环境变量
 *
 * | 变量 | 含义 |
 * |---|---|
 * | `ELENVA_WEB_HOST=1` | 由 elenva-web 启动路径写入；本扩展检测到即静默 |
 * | `ELENVA_HOST_GUARD_DISABLE=1` | 人工全局关（本扩展不注册任何行为） |
 *
 * 安装：`node extensions/elenva-host-guard/install.mjs`
 * （同时把身份段种子同步进 `<agentDir>/APPEND_SYSTEM.md` 的受管段）
 *
 * ## 身份段（模块 7 修复轮）
 *
 * 除护栏外，本扩展还负责 CLI / 飞书侧的**身份段同源注入**：`before_agent_start` 时读
 * `<agentDir>/elenva-identity.json`（与 Web 侧 `lib/host-prompt.ts` 同一份文件），
 * 就地替换 `APPEND_SYSTEM.md` 受管段的内容；文件缺失 / 损坏时不动提示词，
 * 保留安装期种子兜底。详见 `identity.ts`。
 */
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { classifyHostToolCall, toolTargetPath } from "./classify.js";
import { injectIdentitySection, readIdentityText } from "./identity.js";
import { enqueueHostApproval } from "./queue.js";
import { decideHostGuard } from "./host.js";

export const HOST_GUARD_EXTENSION_NAME = "elenva-host-guard";

/** 入队 reason 的前缀：队列里一眼分辨这条是 CLI / 飞书侧登记的（web 侧不带这个前缀） */
export const QUEUE_REASON_PREFIX = "宿主护栏（CLI / 飞书）拦截：";

function short(value: string, limit = 400): string {
  const trimmed = value.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

/** 队列条目里的展示细节：shell 给命令，写入类给路径，其余给参数摘要 */
function approvalDetail(toolName: string, input: Record<string, unknown> | undefined): string {
  if (typeof input?.command === "string") return short(input.command);
  const target = toolTargetPath(input);
  if (target) return `${toolName} ${target}`;
  try {
    return short(`${toolName} ${JSON.stringify(input ?? {})}`);
  } catch {
    return toolName;
  }
}

/**
 * 拒绝文案。三个要素不能少：发生了什么、登记到哪、下一步怎么做。
 * 「已登记到 ELENVA 工作台『等你处理』」是任务书要求的固定措辞，别改写。
 */
export function refusalText(reason: string): string {
  return [
    `[宿主护栏] 已拦下这次调用，未执行：${reason}。`,
    "已登记到 ELENVA 工作台「等你处理」。",
    "不要原样重试 —— 换一条不影响本机或远端的路，或说明为什么必须这样做、等用户确认。",
  ].join(" ");
}

/** 判定 + 入队 + 组装拒绝结果（从 `pi.on` 回调里抽出来，便于单测与阅读） */
export function handleToolCall(
  toolName: string,
  input: Record<string, unknown> | undefined,
  ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
  agentDir: string,
): { block: true; reason: string } | undefined {
  const risk = classifyHostToolCall(toolName, input, { cwd: ctx.cwd });
  if (risk.level !== "block") return undefined;

  const sessionId = ctx.sessionManager?.getSessionId?.() ?? null;
  // 入队是旁路：失败只 stderr 一行，拒绝照做（绝不因为队列写不进去就放行）
  enqueueHostApproval(
    {
      toolName,
      detail: approvalDetail(toolName, input),
      reason: `${QUEUE_REASON_PREFIX}${risk.reason}`,
      ruleKey: risk.ruleKey,
      cwd: ctx.cwd,
      sessionId,
    },
    agentDir,
  );
  return { block: true, reason: refusalText(risk.reason) };
}

export default function elenvaHostGuard(pi: ExtensionAPI): void {
  // 宿主判别先于一切：web 进程里本扩展等于不存在（零 handler、零开销、零双闸）。
  if (decideHostGuard() !== "guard") return;
  const agentDir = getAgentDir();

  // 身份段同源注入（模块 7 修复轮）：与 Web 侧读同一份 elenva-identity.json。
  // 每次 agent 启动前现场读——身份页改完，CLI / 飞书侧下次新建会话即生效（无需重跑 install）。
  pi.on("before_agent_start", (event) => {
    try {
      const identityText = readIdentityText(agentDir);
      if (!identityText) return; // 文件缺失 / 损坏：不动提示词，保留安装期种子兜底
      const next = injectIdentitySection(event.systemPrompt, identityText);
      if (next !== event.systemPrompt) return { systemPrompt: next };
    } catch (error) {
      // 身份注入是旁路：失败不阻断会话（只记录，便于排查）
      console.error("[elenva-host-guard] 身份段注入失败：", error instanceof Error ? error.message : String(error));
    }
    return undefined;
  });

  pi.on("tool_call", async (event, ctx) => {
    const input = event.input as Record<string, unknown> | undefined;
    return handleToolCall(event.toolName, input, ctx, agentDir);
  });
}
