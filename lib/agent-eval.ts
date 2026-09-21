import { SessionManager } from "@earendil-works/pi-coding-agent";
import { buildSessionContext, listAllSessions, resolveSessionPath } from "./session-reader";
import { extractTurnWrittenFiles } from "./turn-written-files";
import { classifyVerificationCommand, isNonCodePath } from "./verification-kind";
import { isBashToolName } from "./tool-names";
import type { AgentMessage, AssistantContentBlock, ToolResultMessage } from "./types";

/**
 * agent 能力评估 —— 从**已有数据**算指标，用来建基线、看趋势。
 *
 * ## 只算现成的
 *
 * 第一版刻意只做「数据已经在磁盘上」的指标：验证覆盖率、工具失败率、验证命令分布。
 * 需要新增采集的（比如「被拦后绕行率」——审批拒绝目前没有落盘）先不做：
 * 为评估而评估的采集没人维护，也会污染真实行为。
 *
 * ## 复用与界面同一份实现
 *
 * 轮次判定、文件写入判定、验证命令识别分别复用 `turn-written-files` /
 * `verification-kind` —— 与输入框上方那行结论同源，避免「界面上说验证过、
 * 评估说没验证」这种口径漂移。
 *
 * ## 口径（读数字前先读这里）
 *
 *  · **为什么不用证据账本**：账本由宿主扩展在会话运行中写入，**只覆盖扩展绑定之后的会话**
 *    （实测：9-12 的老会话 212 条验证全不在账本里）。所以评估走会话文件解析 —— 口径全、可回溯。
 *  · **窗口**：按会话文件的修改时间过滤（最近 N 天内动过的会话），统计其全部轮次。
 *    消息级时间戳不保证存在，故不按消息过滤。
 *  · **轮**：一条 user 消息开始，到下一条 user 消息之前。
 *  · **「改了代码」**：该轮有成功的 write/edit 工具调用，且写入的不是文档 / 数据类文件
 *    （`.md` / `.txt` / `.csv` 等走 `isNonCodePath` 排除 —— 写文档不需要跑检查）。
 *    已知偏差：用 shell（python / sed）改文件的轮次不计入分母，故覆盖率是**特定口径下的数字**，
 *    口径外的轮次不在统计内。
 *  · **「验证过」**：该轮的 bash/powershell 调用（或用户直接执行的 `!shell`）中，
 *    至少有一条被 `classifyVerificationCommand` 认作检查。
 *  · 子代理会话排除（它不是主 agent 的产出）；fork 会话保留 —— 已知偏差：
 *    fork 点之前的轮次会重复计入，当前数量级下接受。
 */

export interface EvaluatedCheck {
  command: string;
  scope: "suite" | "targeted";
  failed: boolean;
}

export interface AgentEvalReport {
  generatedAt: string;
  windowDays: number;
  sessions: {
    /** 窗口内扫到的会话数 */
    scanned: number;
    /** 其中至少解析出一轮的 */
    withTurns: number;
  };
  turns: {
    total: number;
    /** 改了文件的轮次（验证覆盖率的分母） */
    writing: number;
    /** 其中跑过检查的（分子） */
    verified: number;
    /** 覆盖率 = verified / writing；分母为 0 时为 null */
    coverage: number | null;
    /** 跑了检查但有失败的轮次 */
    verifiedButFailed: number;
  };
  checks: {
    total: number;
    failed: number;
    suite: number;
    targeted: number;
  };
  tools: {
    total: number;
    failed: number;
    failureRate: number | null;
  };
}

interface TurnAccumulator {
  blocks: AssistantContentBlock[];
  results: Map<string, ToolResultMessage>;
  /** 用户直接执行的 !shell（不是 agent 的 bash 工具调用） */
  directCommands: { command: string; failed: boolean }[];
}

function newTurn(): TurnAccumulator {
  return { blocks: [], results: new Map(), directCommands: [] };
}

interface EvaluatedTurn {
  wroteFiles: number;
  checks: EvaluatedCheck[];
}

function evaluateTurn(turn: TurnAccumulator, cwd: string): EvaluatedTurn {
  // 写文档 / 数据文件不算「改了代码」—— 它们不需要验证，算进分母只会稀释覆盖率
  const written = extractTurnWrittenFiles(turn.blocks, turn.results, cwd).filter(
    (file) => !isNonCodePath(file.filePath),
  );
  const checks: EvaluatedCheck[] = [];

  for (const block of turn.blocks) {
    if (block.type !== "toolCall") continue;
    if (!isBashToolName(block.toolName)) continue;
    const command = typeof block.input?.command === "string" ? block.input.command : "";
    if (!command.trim()) continue;
    const classification = classifyVerificationCommand(command);
    if (!classification) continue;
    const result = turn.results.get(block.toolCallId);
    checks.push({
      command,
      scope: classification.scope,
      failed: result?.isError === true,
    });
  }

  for (const direct of turn.directCommands) {
    const classification = classifyVerificationCommand(direct.command);
    if (!classification) continue;
    checks.push({ command: direct.command, scope: classification.scope, failed: direct.failed });
  }

  return { wroteFiles: written.length, checks };
}

const CACHE_TTL_MS = 60_000;
let cache: { at: number; windowDays: number; value: AgentEvalReport } | null = null;

export function invalidateAgentEvalCache(): void {
  cache = null;
}

/**
 * 扫描窗口内会话，产出评估报告。
 *
 * 只读：SessionManager.open 不落盘、不触发会话生命周期。
 */
export async function evaluateAgentPerformance(
  options: { windowDays?: number; fresh?: boolean } = {},
): Promise<AgentEvalReport> {
  const windowDays = options.windowDays ?? 7;
  if (!options.fresh && cache && cache.windowDays === windowDays && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.value;
  }

  const since = Date.now() - windowDays * 86_400_000;
  const sessions = await listAllSessions();

  const report: AgentEvalReport = {
    generatedAt: new Date().toISOString(),
    windowDays,
    sessions: { scanned: 0, withTurns: 0 },
    turns: { total: 0, writing: 0, verified: 0, coverage: null, verifiedButFailed: 0 },
    checks: { total: 0, failed: 0, suite: 0, targeted: 0 },
    tools: { total: 0, failed: 0, failureRate: null },
  };

  const targets = sessions.filter((session) => {
    if (session.transient) return false;
    if (session.relation?.kind === "subagent") return false;
    const modified = Date.parse(session.modified);
    return !Number.isFinite(modified) || modified >= since;
  });

  for (const session of targets) {
    report.sessions.scanned += 1;

    let messages: AgentMessage[];
    try {
      const filePath = await resolveSessionPath(session.id);
      if (!filePath) continue;
      const sm = SessionManager.open(filePath);
      messages = buildSessionContext(sm.getEntries() as never).messages as AgentMessage[];
    } catch {
      continue;
    }

    let turn: TurnAccumulator | null = null;
    let turnCount = 0;

    const flush = () => {
      if (!turn) return;
      const evaluated = evaluateTurn(turn, session.cwd);
      turnCount += 1;
      if (evaluated.wroteFiles > 0) {
        report.turns.writing += 1;
        if (evaluated.checks.length > 0) {
          report.turns.verified += 1;
          if (evaluated.checks.some((check) => check.failed)) report.turns.verifiedButFailed += 1;
        }
      }
      for (const check of evaluated.checks) {
        report.checks.total += 1;
        if (check.failed) report.checks.failed += 1;
        if (check.scope === "suite") report.checks.suite += 1;
        else report.checks.targeted += 1;
      }
      turn = null;
    };

    for (const message of messages) {
      if (message.role === "user") {
        flush();
        turn = newTurn();
        continue;
      }
      if (!turn) continue; // 会话开头、或轮次边界之前的消息（custom / 系统）
      if (message.role === "assistant") {
        turn.blocks.push(...message.content);
        for (const block of message.content) {
          if (block.type === "toolCall") report.tools.total += 1;
        }
        continue;
      }
      if (message.role === "toolResult") {
        turn.results.set(message.toolCallId, message);
        if (message.isError) report.tools.failed += 1;
        continue;
      }
      if (message.role === "bashExecution") {
        turn.directCommands.push({
          command: message.command,
          failed: typeof message.exitCode === "number" && message.exitCode !== 0,
        });
      }
    }
    flush();

    if (turnCount > 0) report.sessions.withTurns += 1;
    report.turns.total += turnCount;
  }

  report.turns.coverage = report.turns.writing > 0 ? report.turns.verified / report.turns.writing : null;
  report.tools.failureRate = report.tools.total > 0 ? report.tools.failed / report.tools.total : null;

  cache = { at: Date.now(), windowDays, value: report };
  return report;
}
