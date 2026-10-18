import { Type } from "@earendil-works/pi-ai";
import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  closeCheckpoint,
  openCheckpoint,
  pruneCheckpoints,
  recordFilePostHash,
  recordFilePreImage,
  recordShellCommand,
  recordShellResult,
} from "./checkpoints";
import {
  addAllowedRule,
  readGuardrailSettings,
  readPlanMode,
  readVerifyCommands,
  removeAllowedRule,
  removeVerifyCommand,
  addVerifyCommand,
  writeApprovalMode,
  writePlanMode,
  writePlanModeDefault,
  writeVerificationGuard,
} from "./guardrail-settings";
import {
  classifyVerificationCommand,
  isNonCodePath,
  looksLikeCheck,
} from "./verification-kind";
import { resolvePolicy } from "./guardrail-policy";
import {
  appendVerificationRecord,
  getVerificationLedgerPath,
  pruneVerificationLedger,
  recentVerificationRecords,
  summarizeEvidence,
} from "./verification-ledger";
import {
  classifyToolCall,
  isPlanModeBlocked,
  isReadOnlyShellCommand,
  needsApproval,
  toolTargetPath,
  type McpToolAnnotations,
} from "./tool-risk";
import { isEditToolName, isWriteToolName } from "./tool-names";
import { cwdKey } from "./paths";
import { registerPendingApproval, resolvePendingApproval } from "./pending-approvals";
import { appendApprovalLog, readApprovalLog, MAX_HISTORY_LIMIT, type ApprovalDecision } from "./approval-log";
import { appendLastDecisionNote, safeLastDecisionNote } from "./deny-memory";
import { getScheduledSessionTier, isScheduledSession } from "./scheduled-sessions";
import { normalizePlanSteps, stepsToMarkdown } from "./plan-steps";

/**
 * 宿主护栏扩展：审批闸门 + 每轮快照 + 计划模式。
 *
 * 这是本项目里唯一一个「会拦住 agent」的组件，所以它刻意做得保守：
 * 判不准就放行（只读工具一律不打扰），只有明确危险或明确越界才拦。
 * 没有可用的确认界面时（hasUI=false）宁可拦住 —— 宁可不做，也不静默执行。
 *
 * 注意：扩展在会话创建之前就被实例化（services 先于 session），所以运行时
 * 状态通过 GuardrailsRuntime 的 getter 延迟读取，而不是构造时快照。
 */

export const HOST_GUARDRAILS_EXTENSION_NAME = "elenva-guardrails";

export interface GuardrailsRuntime {
  /** 内核创建会话后才可读；turn_start 之后才会真正用到 */
  getSessionId: () => string | null;
  getCwd: () => string;
  getAllowedRoots: () => readonly string[];
}

export const PLAN_MODE_PROMPT = `## 计划模式（当前开启）

用户要求先看方案、后动手。在你调用 present_plan 并得到批准之前：

- 只能做**只读**勘察：read / grep / find / ls，以及只读的 shell 命令
  （如 git status、git diff、ls、rg、npm test）。
- 任何写入、删除、安装、提交类操作都会被宿主拦截，拦下来再试只是浪费一轮。
- 勘察完就调用 present_plan 提交计划。把计划拆成 2~8 条可核对的步骤放进 steps
  （每条一句话；实现细节放 detail）；plan 写背景与总述，别复述需求。
- 计划正文用 markdown 写：只写会影响决策的东西（要改哪些文件、风险在哪、怎么验证），
  文件路径放在反引号里，总长控制在 15 行以内 —— 用户要在弹窗里**扫一眼**就看懂，
  写成一大段散文等于没写。
- 被要求修改时，改完再次调用 present_plan（保持步骤结构）；打回时用户会附上逐条批注。`;

/** 「本会话总是允许」的规则缓存，进程内有效 */
const PENDING_APPROVALS_FILE = "elenva-pending-approvals.jsonl";

/**
 * 待审批队列（append-only JSONL）。
 *
 * 无人值守时用它替代「拒绝」：操作不执行，但 agent 被告知的是「先做别的」
 * 而不是「此路不通」—— 否则它会在危险操作前面停下，整条长任务断在那里。
 * 用追加写而不是数据库：队列本身也是证据（何时、谁、想干什么、为什么被拦）。
 */
export function enqueuePendingApproval(entry: {
  toolName: string;
  detail: string;
  reason: string;
  ruleKey?: string;
  cwd: string;
  sessionId?: string | null;
}): number {
  const file = join(getAgentDir(), PENDING_APPROVALS_FILE);
  try {
    appendFileSync(file, `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`, "utf8");
    return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).length;
  } catch (error) {
    console.error("[elenva] failed to enqueue pending approval:", error);
    return 0;
  }
}

const sessionAllow = new Map<string, Set<string>>();

/** 收尾追问的冷却：同一会话 5 分钟内不重复追问，避免“追问→又改→再追问”的死循环 */
const NUDGE_COOLDOWN_MS = 5 * 60 * 1000;

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function relativeToCwd(absolute: string, cwd: string): string {
  const a = absolute.replace(/\\/g, "/");
  const b = cwd.replace(/\\/g, "/").replace(/\/$/, "");
  if (b && a.toLowerCase().startsWith(`${b.toLowerCase()}/`)) return a.slice(b.length + 1);
  return a;
}

/** 工具结果里的文本（截断后进账本，供回看） */
function resultText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((block) => (block && typeof block === "object" && (block as { type?: string }).type === "text"
      ? String((block as { text?: unknown }).text ?? "")
      : ""))
    .join("\n")
    .trim();
  return text || undefined;
}

/** 改动文件是否被某个证据覆盖（全量证据一律算覆盖） */
function evidenceCovers(
  records: readonly { ok: boolean; scope: string; targets: string[] }[],
  changedPaths: readonly string[],
): boolean {
  const changed = changedPaths.map(normalizePath);
  return records.some((record) => {
    if (!record.ok) return false;
    if (record.scope === "suite") return true;
    return record.targets.some((target) => {
      const t = normalizePath(target);
      return changed.some((path) => path === t || path.endsWith(`/${t}`) || t.endsWith(`/${path}`));
    });
  });
}

/**
 * 收尾追问的措辞。
 *
 * 两个细节是刻意的：
 *  · 「单点检查通过不等于整体通过」—— 不升级声称，这是 Hermes 的教训里最值钱的一条；
 *  · 「确实无法验证就说明原因」—— 留个出口，否则模型会为了满足要求跑些无意义的命令。
 */
function verificationNudgeText(paths: readonly string[], failures: readonly string[]): string {
  const shown = paths.slice(0, 8);
  const more = paths.length - shown.length;
  if (failures.length > 0) {
    return [
      "[宿主提醒] 本轮的验证有失败项，但你已经停下来了：",
      ...failures.slice(0, 4).map((command) => `  · ${command}`),
      "",
      failures.length > 4 ? `（另有 ${failures.length - 4} 条失败）` : "",
      "请先修复并用同样的命令复验；如果本次不打算修，就在结论里明确写出「哪些检查仍是红的」——不要静默收尾。",
    ].filter(Boolean).join("\n");
  }
  return [
    "[宿主提醒] 本轮改了代码，但没有留下验证证据：",
    ...shown.map((path) => `  · ${path}`),
    ...(more > 0 ? [`  · （另有 ${more} 个）`] : []),
    "",
    "在宣称完成之前，请先跑一次能覆盖这些改动的检查（测试 / 类型检查 / 构建 / lint），把结果作为依据。",
    "注意：单点检查通过不等于整体通过 —— 如果只跑了局部检查，请在结论里说清楚范围。",
    "如果这个项目确实没有可跑的检查，就直接说明原因，不要造一条命令来满足要求。",
  ].join("\n");
}

function shortCommand(command: string, limit = 400): string {
  const trimmed = command.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

/** MCP 工具的参数摘要（确认卡里给一眼上下文；截断防长内容） */
function shortInputJson(input: Record<string, unknown> | undefined, limit = 300): string {
  try {
    const text = JSON.stringify(input ?? {});
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  } catch {
    return "";
  }
}

/**
 * 「上次同类操作」附注（模块 5 · 第 3 轮）：读审批历史，找同 `ruleKey` 的最近一次
 * 决定（排除当前会话，避免自指），生成一行人话。只看 `ruleKey` 与 `sessionId`，
 * **不参与任何放行 / 拦截判定**；读日志异常时 `safeLastDecisionNote` 静默返回 null。
 */
function lastDecisionNote(ruleKey: string | undefined, sessionId: string | null): string | null {
  return safeLastDecisionNote(
    ruleKey,
    () => readApprovalLog({ limit: MAX_HISTORY_LIMIT }).entries,
    { excludeSessionId: sessionId },
  );
}

function planModeActive(runtime: GuardrailsRuntime): boolean {
  const sessionId = runtime.getSessionId();
  if (!sessionId) return false;
  try {
    return readPlanMode(sessionId);
  } catch {
    return false;
  }
}

export function createGuardrailsExtension(runtime: GuardrailsRuntime): InlineExtension {
  return {
    name: HOST_GUARDRAILS_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      let currentTurnId: string | null = null;

      /**
       * MCP 工具定义上的 annotations（readOnlyHint / destructiveHint）。
       * 内核 `getAllTools()` 带回 M4R6 调研 §1.1④ 的 annotations；只对 `mcp__`
       * 工具查询，查不到就返回 undefined（判定回落词段启发式）。
       */
      const mcpAnnotationsFor = (toolName: string): McpToolAnnotations | undefined => {
        if (!toolName.startsWith("mcp__")) return undefined;
        try {
          return pi.getAllTools().find((tool) => tool.name === toolName)?.annotations;
        } catch {
          return undefined;
        }
      };

      /** 本轮（一次 agent run）的状态：什么时候开始、改过哪些文件、跑过哪些命令 */
      let runStartedAt = Date.now();
      const runEdits = new Set<string>();
      /** 本轮跑过的命令及其成败：收尾追问的粗判兜底用（见 looksLikeCheck） */
      const runChecks: Array<{ command: string; failed: boolean; at: number }> = [];
      /** 最后一次成功写入的时间：证据必须比它新，否则「改之前跑的检查」会被当成覆盖 */
      let lastEditAt = 0;
      let nudgedThisRun = false;
      /** 追问冷却：防止“追问 → 它又改又不说 → 再追问”的死循环 */
      let lastNudgeAt = 0;

      /** 工具参数里的路径是相对会话 cwd 的，不是相对服务进程 cwd 的 */
      const absoluteTarget = (target: string): string => resolve(runtime.getCwd(), target);

      pi.on("before_agent_start", (event) => {
        if (!planModeActive(runtime)) return;
        return { systemPrompt: `${event.systemPrompt}\n\n${PLAN_MODE_PROMPT}` };
      });

      pi.on("agent_start", () => {
        runStartedAt = Date.now();
        runEdits.clear();
        runChecks.length = 0;
        lastEditAt = 0;
        nudgedThisRun = false;
      });

      pi.on("turn_start", (event) => {
        const sessionId = runtime.getSessionId();
        if (!sessionId) return;
        const checkpoint = openCheckpoint({
          sessionId,
          cwd: runtime.getCwd(),
          turnIndex: event.turnIndex,
        });
        currentTurnId = checkpoint.id;
      });

      pi.on("tool_call", async (event, ctx) => {
        const sessionId = runtime.getSessionId();
        const toolName = event.toolName;
        const input = event.input as Record<string, unknown> | undefined;

        // 1) 计划模式：拦下会改动世界的调用，并明确告诉模型原因
        if (planModeActive(runtime)) {
          const bashCommand = typeof input?.command === "string" ? input.command : "";
          const readOnlyBash = toolName === "bash" || toolName === "powershell"
            ? isReadOnlyShellCommand(bashCommand)
            : false;
          if (isPlanModeBlocked(toolName, input) && !readOnlyBash) {
            return {
              block: true,
              reason: `[计划模式] ${toolName} 会在获得批准前改动环境。请先只读勘察，然后调用 present_plan 提交计划。`,
            };
          }
        }

        // 2) 快照 + 记录本轮改动（收尾追问用）
        if (currentTurnId && sessionId) {
          if (isWriteToolName(toolName) || isEditToolName(toolName)) {
            const target = toolTargetPath(input);
            if (target) {
              recordFilePreImage({
                sessionId,
                turnId: currentTurnId,
                filePath: absoluteTarget(target),
                tool: toolName,
              });
            }
          } else if (toolName === "bash" || toolName === "powershell") {
            const command = typeof input?.command === "string" ? input.command : "";
            if (command.trim()) {
              recordShellCommand({ sessionId, turnId: currentTurnId, command });
            }
          }
        }

        // 3) 审批闸门
        const settings = readGuardrailSettings();
        // 项目级档位（模块 5 · 第 2 轮）：三个键各自「项目 > 全局」。
        // 没有项目配置时 resolvePolicy 原样返回全局值（逐字节等价），
        // 所以下面仍然只有一条判定路径，没有分叉。
        // caseInsensitiveKeys 由这里按平台显式给：Windows 的 cwdKey 落盘是小写形式，
        // 而 Linux 上 `/Home` 与 `/home` 是两个不同目录，不能一并忽略大小写。
        const policy = resolvePolicy(settings, runtime.getCwd(), {
          caseInsensitiveKeys: process.platform === "win32",
        });
        const risk = classifyToolCall(toolName, input, {
          cwd: runtime.getCwd(),
          allowedRoots: runtime.getAllowedRoots(),
          mcpAnnotations: mcpAnnotationsFor(toolName),
        });

        // 3.0) 节律安全档（模块 3 · 第 6 轮）：仅对 scheduled 会话生效——普通会话
        // 与 standard 档行为零变化。位置刻意在「风险分类之后、其它审批判定之前」：
        //   · readonly：写 / 删 / 安装类调用**直接拦下**（不入队、不弹窗、不落盘），
        //     让模型拿到理由自己调整策略；只读命令照常放行。判据与计划模式同源
        //     （isPlanModeBlocked + isReadOnlyShellCommand），所以 todo_write 等
        //     会话簿记类照旧放行。
        //   · full：明确信任的任务，审批闸门**整体跳过**（破坏性操作直接执行），
        //     不登记 pending、不入队；其余逻辑（快照 / 证据账本）照旧。
        //   · standard：不在此处理，落到下面的强制入队分支（现状）。
        if (sessionId && isScheduledSession(sessionId)) {
          const tier = getScheduledSessionTier(sessionId);
          if (tier === "readonly") {
            const bashCommand = typeof input?.command === "string" ? input.command : "";
            const readOnlyBash = toolName === "bash" || toolName === "powershell"
              ? isReadOnlyShellCommand(bashCommand)
              : false;
            if (isPlanModeBlocked(toolName, input) && !readOnlyBash) {
              return {
                block: true,
                reason:
                  "[只读] 该节律任务配置为只读模式：只做勘察与汇报，本轮不要尝试写入 / 删除 / 执行改动。请改用只读手段继续，收尾时说明需要改动但被只读档拦截。",
              };
            }
          } else if (tier === "full") {
            return;
          }
        }
        // MCP 写操作由独立开关控制：关掉时回到默认（不打扰）；总闸「关闭」时同样不生效
        if (risk.mcpWrite === true && !policy.mcpWriteApproval) return;
        if (!needsApproval(risk, policy.approvalMode)) return;
        const allowRules = [
          ...(settings.allowByProject[cwdKey(runtime.getCwd())] ?? []),
          ...(sessionId ? [...(sessionAllow.get(sessionId) ?? [])] : []),
        ];
        if (risk.ruleKey && allowRules.includes(risk.ruleKey)) return;

        // 「上次同类操作」附注：只在确实要走到闸门（需确认 / 入队 / 自动拒绝）时才读历史。
        // 它只影响弹窗 / 队列 / 拒绝的显示文案，**不参与下面的任何判定**；
        // 读日志出错时 lastDecisionNote 返回 null，appendLastDecisionNote 就原样不加。
        const historyNote = lastDecisionNote(risk.ruleKey, sessionId);

        // 审批落入「待审批队列」并拦下本次调用。节律 / 无人值守共用同一落点，
        // 保证两种场景的文案与行为逐字一致。
        const enqueueApproval = () => {
          const queueDetail = toolName.startsWith("mcp__")
            ? shortInputJson(input)
            : shortCommand(typeof input?.command === "string" ? input.command : "");
          const n = enqueuePendingApproval({
            toolName,
            detail: queueDetail,
            // 队列卡片（工作台「等你」）也带上历史：同一落点的展示文案附注
            reason: appendLastDecisionNote(risk.reason, historyNote),
            ruleKey: risk.ruleKey,
            cwd: runtime.getCwd(),
            sessionId,
          });
          // 只加日志：入队同样是一次决策（本次调用被拦下、不执行）。
          // 注意：日志里的原因保持原样（risk.reason），绝不把附注存回历史，
          // 否则下次会拼出「上次同类操作：上次同类操作：…」的嵌套。
          appendApprovalLog({
            sessionId,
            kind: "tool",
            tool: toolName,
            summary: queueDetail,
            decision: "queued",
            source: "queue",
            reason: risk.reason,
            ruleKey: risk.ruleKey,
          });
          return {
            block: true as const,
            reason: appendLastDecisionNote(
              `[审批] ${risk.reason} 已加入待审批队列（第 ${n} 项，未执行）。\n不要停下来等：继续做不依赖这一步的部分，收尾时说明这一项卡在哪、需要谁批准。`,
              historyNote,
            ),
          };
        };

        // 节律触发的会话**无人值守**：它虽然带着 UI 能力（ctx.hasUI=true，属普通
        // 交互式会话类型），但没有任何人坐在旁边点确认 —— 弹窗等于挂死到 10 分钟
        // 超时拒绝（真机验收跰到过）。所以在 hasUI 判断**之前**就强制入队：
        // 不弹窗、不拒绝、不看 approvalFallback，风险仍被挂进「等你处理」。
        if (sessionId && isScheduledSession(sessionId)) return enqueueApproval();

        if (!ctx.hasUI) {
          // 无人值守 / 后台会话：按配置决定「拒绝」还是「入队后继续」
          if (policy.approvalFallback === "queue") return enqueueApproval();
          // 只加日志：没有可用界面时的自动拒绝也是一次决策（没有人点，来源记为 auto）
          appendApprovalLog({
            sessionId,
            kind: "tool",
            tool: toolName,
            summary: toolName.startsWith("mcp__")
              ? shortInputJson(input)
              : shortCommand(typeof input?.command === "string" ? input.command : ""),
            decision: "denied",
            source: "auto",
            reason: risk.reason,
            ruleKey: risk.ruleKey,
          });
          return {
            block: true,
            reason: appendLastDecisionNote(
              `[审批] ${risk.reason}，但当前会话没有可用的确认界面，已拒绝执行。`,
              historyNote,
            ),
          };
        }

        const target = toolTargetPath(input);
        const detail = toolName === "bash" || toolName === "powershell"
          ? shortCommand(typeof input?.command === "string" ? input.command : "")
          : target ?? (toolName.startsWith("mcp__") ? shortInputJson(input) : "");
        const options = [
          "允许一次",
          ...(sessionId && risk.ruleKey ? ["本会话总是允许"] : []),
          ...(risk.ruleKey ? ["总是允许（保存到项目设置）"] : []),
          "拒绝",
        ];
        // 审批卡还开着的时候，这条会话在「工作台 → 等你」里必须可见。
        // 登记 / 清理都是旁路：它们自身失败也绝不影响下面的审批判定。
        registerPendingApproval({ sessionId, kind: "tool", reason: risk.reason, detail });
        let choice: string | undefined;
        try {
          choice = await ctx.ui.select(
            appendLastDecisionNote(
              `危险操作需要确认\n${risk.reason}\n\n${detail}\n\n工具：${toolName}`,
              historyNote,
            ),
            options,
            // 后台会话（子代理 / 并行试验）弹的卡可能没人在看；没有超时就会永久挂住
            // 那一轮工具调用。超时按「拒绝」处理 —— 宁可不做，也不静默执行。
            { timeout: 10 * 60 * 1000 },
          );
        } finally {
          // 正常返回 / 超时 / 抛错都要清，否则「等你」里会留一条幽灵条目
          resolvePendingApproval(sessionId, "tool");
        }

        // 只加日志：把这次审批的结果写进历史（下面的放行 / 拒绝语义一字未动）。
        // choice === undefined 表示没人点（10 分钟超时或弹窗被中断）。
        const toolDecision: ApprovalDecision =
          choice === undefined ? "timeout" : choice === "拒绝" ? "denied" : "approved";
        appendApprovalLog({
          sessionId,
          kind: "tool",
          tool: toolName,
          summary: detail,
          decision: toolDecision,
          source: "dialog",
          reason: toolDecision === "approved" ? undefined : risk.reason,
          ruleKey: risk.ruleKey,
        });

        if (choice === "本会话总是允许" && sessionId && risk.ruleKey) {
          const set = sessionAllow.get(sessionId) ?? new Set<string>();
          set.add(risk.ruleKey);
          sessionAllow.set(sessionId, set);
          return;
        }
        if (choice === "总是允许（保存到项目设置）" && risk.ruleKey) {
          try {
            addAllowedRule(runtime.getCwd(), risk.ruleKey);
          } catch (error) {
            console.error("[elenva] failed to persist allow rule:", error);
          }
          return;
        }
        if (choice === "允许一次") return;

        ctx.ui.notify(`已拒绝：${risk.reason}`, "warning");
        return {
          block: true,
          reason: `[审批] 用户拒绝执行 ${toolName}：${risk.reason}。不要重复尝试同一操作，改用其他方式或向用户确认。`,
        };
      });

      pi.on("tool_result", (event) => {
        const sessionId = runtime.getSessionId();
        const cwd = runtime.getCwd();

        // 命令的成败要在结果回来后回填，否则「验证通过了吗」只能靠肉眼比对输出
        if (event.toolName === "bash" || event.toolName === "powershell") {
          const command = typeof event.input?.command === "string" ? event.input.command : "";
          if (!command.trim()) return;
          if (sessionId && currentTurnId) {
            recordShellResult({
              sessionId,
              turnId: currentTurnId,
              command,
              failed: event.isError === true,
            });
          }
          if (command.trim()) {
            runChecks.push({ command, failed: event.isError === true, at: Date.now() });
            if (runChecks.length > 40) runChecks.shift();
          }
          // 验证证据账本：只有认得出来是验证类命令才记（含项目声明的检查脚本）
          const classification = classifyVerificationCommand(command, readVerifyCommands(cwd));
          if (classification && sessionId) {
            appendVerificationRecord({
              sessionId,
              cwd,
              command: command.length > 500 ? `${command.slice(0, 500)}…` : command,
              kind: classification.kind,
              scope: classification.scope,
              targets: classification.targets,
              ok: event.isError !== true,
              changedPaths: [...runEdits],
              output: resultText(event.content),
            });
          }
          return;
        }

        if (!isWriteToolName(event.toolName) && !isEditToolName(event.toolName)) return;
        const target = toolTargetPath(event.input);
        if (target) {
          const absolute = absoluteTarget(target);
          if (!event.isError) {
            runEdits.add(relativeToCwd(absolute, cwd));
            lastEditAt = Date.now();
          }
          if (sessionId && currentTurnId) {
            recordFilePostHash({ sessionId, turnId: currentTurnId, filePath: absolute });
          }
        }
      });

      pi.on("turn_end", () => {
        const sessionId = runtime.getSessionId();
        if (!sessionId || !currentTurnId) return;
        closeCheckpoint({ sessionId, turnId: currentTurnId });
        currentTurnId = null;
      });

      pi.on("agent_settled", () => {
        const sessionId = runtime.getSessionId();
        if (!sessionId) return;
        pruneCheckpoints(sessionId, 30);
        maybeNudgeVerification();
      });

      /**
       * 收尾守卫：改了代码、却没留下能覆盖这些改动的证据时，追一次。
       *
       * 只提醒、不代跑（宿主跑检查要多花钱、会把输出灌进上下文，还可能跑错）。
       * 四个条件同时成立才追问：有代码改动 / 开关开着 / 已有证据不覆盖改动 / 过了冷却。
       */
      const maybeNudgeVerification = () => {
        const sessionId = runtime.getSessionId();
        if (!sessionId || nudgedThisRun) return;
        const codeEdits = [...runEdits].filter((path) => !isNonCodePath(path));
        if (codeEdits.length === 0) return;
        try {
          if (!readGuardrailSettings().verificationGuard) return;
        } catch {
          /* 读不到设置就不追问 */
          return;
        }
        if (Date.now() - lastNudgeAt < NUDGE_COOLDOWN_MS) return;
        const sinceLastEdit = Math.max(runStartedAt, lastEditAt);
        const records = recentVerificationRecords().filter(
          (record) => record.sessionId === sessionId && Date.parse(record.createdAt) >= sinceLastEdit,
        );
        if (evidenceCovers(records, codeEdits)) return;
        // 兜底：精确分类器认不出、但看起来确实是检查的命令（项目自定义脚本）。
        // 误追比漏追代价大得多 —— 详见 looksLikeCheck 的注释。
        if (runChecks.some((item) => !item.failed && item.at >= sinceLastEdit && looksLikeCheck(item.command))) return;
        nudgedThisRun = true;
        lastNudgeAt = Date.now();
        const failures = records.filter((record) => !record.ok).map((record) => record.command);
        try {
          pi.sendMessage(
            {
              customType: "elenva-verification-guard",
              content: verificationNudgeText(codeEdits, failures),
              display: true,
              details: {
                kind: "elenva-verification-guard",
                changedPaths: codeEdits.slice(0, 20),
                failures: failures.slice(0, 10),
              },
            },
            { triggerTurn: true, deliverAs: "followUp" },
          );
        } catch (error) {
          console.error("[elenva] verification nudge failed:", error);
        }
      };

      pi.registerTool(defineTool({
        name: "present_plan",
        label: "提交计划",
        description: "提交一份执行计划等待用户批准。把计划拆成 2~8 条可核对的步骤放进 steps（每条一句话；实现细节放 detail）；plan 写背景与总述，别复述需求。仅在计划模式下使用；批准后即可开始改动。",
        promptSnippet: "Submit an execution plan for user approval (plan mode)",
        parameters: Type.Object({
          plan: Type.String({
            description: "计划正文（markdown）：背景与总述 —— 要改哪些文件、风险、验证方式。不要复述需求；步骤写进 steps。",
          }),
          steps: Type.Optional(
            Type.Array(
              Type.Object({
                title: Type.String({ description: "一条可核对的步骤，一句话" }),
                detail: Type.Optional(Type.String({ description: "该步的实现细节（可选）" })),
              }),
              { maxItems: 12, description: "计划步骤（2~8 条为宜）" },
            ),
          ),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          const sessionId = runtime.getSessionId();
          const text = params.plan.trim();
          const steps = normalizePlanSteps(params.steps);
          if (!ctx.hasUI) {
            return {
              content: [{ type: "text", text: "当前会话没有可用的确认界面，无法批准计划。" }],
              details: undefined,
              isError: true,
            };
          }
          // 同工具审批：计划卡开着时也要登记为「等你」，返回后清理
          registerPendingApproval({ sessionId, kind: "plan", reason: "计划待批准", detail: text });
          let choice: string | undefined;
          try {
            // 有步骤时把步骤排在正文前 —— 弹窗里先看到「要做什么」再看到「背景」
            const message = steps.length > 0
              ? `计划待批准\n步骤：\n${stepsToMarkdown(steps)}\n\n${text}`
              : `计划待批准\n${text}`;
            choice = await ctx.ui.select(
              message,
              ["批准，开始执行", "打回并批注", "先不做"],
              // 同上：没人看的时候不能永久挂住
              { timeout: 30 * 60 * 1000 },
            );
          } finally {
            resolvePendingApproval(sessionId, "plan");
          }
          // 只加日志：计划审批的结果写进历史（批准 / 打回的判定与写回逻辑一字未动）。
          // plan 侧没有 tool-risk 那种 ruleKey，按 kind 级固定键（"plan"）记，
          // 供以后把「上次计划决定」也带到现场。
          const logPlan = (decision: ApprovalDecision, reason?: string) =>
            appendApprovalLog({
              sessionId,
              kind: "plan",
              tool: "present_plan",
              summary: text,
              decision,
              source: "dialog",
              reason,
              ruleKey: "plan",
            });
          if (choice === "批准，开始执行") {
            logPlan("approved");
            if (sessionId) writePlanMode(sessionId, false);
            return {
              content: [{ type: "text", text: `用户已批准计划，可以开始执行。\n\n${text}` }],
              details: { kind: "elenva-plan", status: "approved", steps },
            };
          }
          if (choice === "打回并批注") {
            // 打回时收一条批注：用户今天只能批准后回聊天里补意见，等于丢掉了「为什么打回」
            let note: string | undefined;
            try {
              note = await ctx.ui.editor("计划批注 —— 修改意见（可按步骤逐条写，例：第 2 步：不要动 X）");
            } catch (error) {
              // 编辑器不可用 / 取消：按「无批注打回」处理，审批流程绝不能因此异常中断
              console.error("[elenva] plan note editor failed:", error);
              note = undefined;
            }
            const trimmed = typeof note === "string" ? note.trim() : "";
            if (trimmed === "") {
              logPlan("denied", "打回（无批注）");
              return {
                content: [{ type: "text", text: "用户打回了计划。请修订后再次调用 present_plan（保持步骤结构）。" }],
                details: { kind: "elenva-plan", status: "revise", steps },
              };
            }
            logPlan("denied", `打回批注：${trimmed}`);
            return {
              content: [{
                type: "text",
                text: `用户打回了计划。修改意见：\n${trimmed}\n\n请据此修订后再次调用 present_plan（保持步骤结构）。`,
              }],
              details: { kind: "elenva-plan", status: "revise", steps, note: trimmed },
            };
          }
          logPlan(choice === "先不做" ? "denied" : "timeout", choice === "先不做" ? "先不做" : "超时未选择");
          return {
            content: [{ type: "text", text: "用户暂时不执行该计划：停止改动，等待用户下一步指示。" }],
            details: { kind: "elenva-plan", status: "rejected", steps },
          };
        },
      }));
    },
  };
}
