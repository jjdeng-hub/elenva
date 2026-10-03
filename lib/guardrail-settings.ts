import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { cwdKey } from "./paths";
import type { ApprovalMode } from "./tool-risk";

/**
 * 审批与计划模式的持久化设置。
 *
 * 与 `~/.pi/agent/settings.json`（pi CLI 自己的设置）分开存，避免把 ELENVA
 * 专有的字段写进内核不认识的文件。
 */

export interface GuardrailSettings {
  approvalMode: ApprovalMode;
  /**
   * 拦下之后、又没人在场时怎么办。
   * - "reject"（默认）：拒绝执行。安全，但无人值守时 agent 干不下去。
   * - "queue"：写进待审批队列后放行继续 —— agent 被告知「别停，先做别的」，
   *   用户回来批量处理。无人值守跑长任务必须用它，否则跑到危险操作就断。
   * 与 approvalMode 是两个维度：前者决定「拦不拦」，它决定「拦下之后」。
   */
  approvalFallback: "reject" | "queue";
  /**
   * MCP 写操作确认：删除/清空/写入类 MCP 工具执行前弹确认卡（读取类不打扰）。
   * 独立于 approvalMode —— 关闭时 MCP 写操作回到默认（不弹卡）；
   * approvalMode 设为「关闭」时本项同样不生效（总闸优先）。
   */
  mcpWriteApproval: boolean;
  /** 免确认规则：按项目 cwd 分组，值是 tool-risk 给出的 ruleKey */
  allowByProject: Record<string, string[]>;
  /** 打开会话时默认进入计划模式 */
  planModeDefault: boolean;
  /** 会话级计划模式：true/false 均为显式值，未出现过的会话回落到 planModeDefault */
  planModeSessions: Record<string, boolean>;
  /**
   * 收尾守卫：改了代码却没留下验证证据时追一次。
   * 只提醒不代跑，所以默认开着 —— 它不花钱、不阻塞，只是不让「改完了」没有依据。
   */
  verificationGuard: boolean;
  /**
   * 项目声明的验证命令（按 cwd 分组，子串匹配）。
   * 项目自带的检查脚本（`python tools/style-converge.py`）内建名单认不出，
   * 声明后就能被精确记账，显示为「项目检查」而不是被当成没验过。
   */
  verifyCommandsByProject: Record<string, string[]>;
}

export const DEFAULT_GUARDRAIL_SETTINGS: GuardrailSettings = {
  approvalMode: "risky",
  approvalFallback: "reject",
  mcpWriteApproval: true,
  allowByProject: {},
  planModeDefault: false,
  planModeSessions: {},
  verificationGuard: true,
  verifyCommandsByProject: {},
};

const APPROVAL_MODES: ApprovalMode[] = ["off", "risky", "writes"];
const APPROVAL_FALLBACKS = ["reject", "queue"] as const;
type ApprovalFallback = GuardrailSettings["approvalFallback"];
function isApprovalFallback(value: unknown): value is ApprovalFallback {
  return typeof value === "string" && (APPROVAL_FALLBACKS as readonly string[]).includes(value);
}

function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === "string" && (APPROVAL_MODES as string[]).includes(value);
}

function readStringArrayMap(value: unknown): Record<string, string[]> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(raw)) continue;
    const list = raw.filter((item): item is string => typeof item === "string" && item.length > 0);
    // 统一按 cwdKey 重新索引：历史文件里可能存着 `C:/x`，而运行时拿到的是 `C:\x`
    const normalizedKey = cwdKey(key) || key;
    if (list.length > 0) out[normalizedKey] = [...new Set([...(out[normalizedKey] ?? []), ...list])];
  }
  return out;
}

export function getGuardrailSettingsPath(agentDir = getAgentDir()): string {
  return join(agentDir, "elenva-guardrails.json");
}

export function readGuardrailSettings(settingsPath = getGuardrailSettingsPath()): GuardrailSettings {
  if (!existsSync(settingsPath)) return { ...DEFAULT_GUARDRAIL_SETTINGS };
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...DEFAULT_GUARDRAIL_SETTINGS };
    }
    const stored = parsed as Record<string, unknown>;
    return {
      approvalMode: isApprovalMode(stored.approvalMode)
        ? stored.approvalMode
        : DEFAULT_GUARDRAIL_SETTINGS.approvalMode,
      approvalFallback: isApprovalFallback(stored.approvalFallback)
        ? stored.approvalFallback
        : DEFAULT_GUARDRAIL_SETTINGS.approvalFallback,
      mcpWriteApproval: stored.mcpWriteApproval === undefined
        ? DEFAULT_GUARDRAIL_SETTINGS.mcpWriteApproval
        : stored.mcpWriteApproval === true,
      allowByProject: readStringArrayMap(stored.allowByProject),
      planModeDefault: stored.planModeDefault === true,
      planModeSessions: stored.planModeSessions !== null
        && typeof stored.planModeSessions === "object"
        && !Array.isArray(stored.planModeSessions)
        ? Object.fromEntries(
            Object.entries(stored.planModeSessions as Record<string, unknown>)
              .filter(([, value]) => typeof value === "boolean") as Array<[string, boolean]>,
          )
        : {},
      verificationGuard: stored.verificationGuard === undefined
        ? DEFAULT_GUARDRAIL_SETTINGS.verificationGuard
        : stored.verificationGuard === true,
      verifyCommandsByProject: readStringArrayMap(stored.verifyCommandsByProject),
    };
  } catch {
    // 设置文件损坏时不阻塞会话：回落到默认档位（risky）。
    return { ...DEFAULT_GUARDRAIL_SETTINGS };
  }
}

function write(settings: GuardrailSettings, settingsPath: string): GuardrailSettings {
  mkdirSync(dirname(settingsPath), { recursive: true });
  writePrivateFileAtomicSync(settingsPath, JSON.stringify({ version: 1, ...settings }, null, 2));
  return settings;
}

export function writeApprovalMode(
  mode: ApprovalMode,
  settingsPath = getGuardrailSettingsPath(),
): GuardrailSettings {
  const current = readGuardrailSettings(settingsPath);
  return write({ ...current, approvalMode: mode }, settingsPath);
}

export function writePlanModeDefault(
  enabled: boolean,
  settingsPath = getGuardrailSettingsPath(),
): GuardrailSettings {
  const current = readGuardrailSettings(settingsPath);
  return write({ ...current, planModeDefault: enabled }, settingsPath);
}

export function writeVerificationGuard(
  enabled: boolean,
  settingsPath = getGuardrailSettingsPath(),
): GuardrailSettings {
  const current = readGuardrailSettings(settingsPath);
  return write({ ...current, verificationGuard: enabled }, settingsPath);
}

export function writeMcpWriteApproval(
  enabled: boolean,
  settingsPath = getGuardrailSettingsPath(),
): GuardrailSettings {
  const current = readGuardrailSettings(settingsPath);
  return write({ ...current, mcpWriteApproval: enabled }, settingsPath);
}

/**
 * 把一条验证命令片段加进某个项目的声明列表。
 *
 * 刻意只限**长度与条数**，不做正则 —— 用户写的是「命令里的一段文字」，正则会把大部分人
 * 挡在门外，还带来 ReDoS 面。子串匹配也更好解释：“命令里含这段文字就算这个项目的检查”。
 */
export const MAX_VERIFY_PATTERN_CHARS = 120;
export const MAX_VERIFY_PATTERNS_PER_PROJECT = 20;

export function addVerifyCommand(
  cwd: string,
  pattern: string,
  settingsPath = getGuardrailSettingsPath(),
): GuardrailSettings {
  const value = pattern.trim().slice(0, MAX_VERIFY_PATTERN_CHARS);
  const key = cwdKey(cwd);
  if (!value || !key) return readGuardrailSettings(settingsPath);
  const current = readGuardrailSettings(settingsPath);
  const list = current.verifyCommandsByProject[key] ?? [];
  if (list.some((item) => item.toLowerCase() === value.toLowerCase())) return current;
  const next = [...list, value].slice(0, MAX_VERIFY_PATTERNS_PER_PROJECT);
  return write({
    ...current,
    verifyCommandsByProject: { ...current.verifyCommandsByProject, [key]: next },
  }, settingsPath);
}

export function removeVerifyCommand(
  cwd: string,
  pattern: string,
  settingsPath = getGuardrailSettingsPath(),
): GuardrailSettings {
  const key = cwdKey(cwd);
  const current = readGuardrailSettings(settingsPath);
  const list = current.verifyCommandsByProject[key] ?? [];
  const next = list.filter((item) => item !== pattern);
  const verifyCommandsByProject = { ...current.verifyCommandsByProject };
  if (next.length > 0) verifyCommandsByProject[key] = next;
  else delete verifyCommandsByProject[key];
  return write({ ...current, verifyCommandsByProject }, settingsPath);
}

/** 供扩展/分类器用：取某项目的声明列表（cwd 写法不重要，内部统一规范化） */
export function readVerifyCommands(cwd: string, settingsPath = getGuardrailSettingsPath()): string[] {
  try {
    return readGuardrailSettings(settingsPath).verifyCommandsByProject[cwdKey(cwd)] ?? [];
  } catch {
    return [];
  }
}

/** 把一条 ruleKey 加进某项目的免确认列表 */
export function addAllowedRule(
  cwd: string,
  ruleKey: string,
  settingsPath = getGuardrailSettingsPath(),
): GuardrailSettings {
  const key = cwdKey(cwd);
  const current = readGuardrailSettings(settingsPath);
  const rules = current.allowByProject[key] ?? [];
  if (!key || rules.includes(ruleKey)) return current;
  return write({
    ...current,
    allowByProject: { ...current.allowByProject, [key]: [...rules, ruleKey] },
  }, settingsPath);
}

export function removeAllowedRule(
  cwd: string,
  ruleKey: string,
  settingsPath = getGuardrailSettingsPath(),
): GuardrailSettings {
  const key = cwdKey(cwd);
  const current = readGuardrailSettings(settingsPath);
  const rules = current.allowByProject[key] ?? [];
  if (!rules.includes(ruleKey)) return current;
  const next = rules.filter((rule) => rule !== ruleKey);
  const allowByProject = { ...current.allowByProject };
  if (next.length > 0) allowByProject[key] = next;
  else delete allowByProject[key];
  return write({ ...current, allowByProject }, settingsPath);
}

/**
 * 会话是否处于计划模式。未显式设置过的会话回落到默认值 —— 新会话在拿到 id 之前
 * 只能改默认值，靠这个回落生效；显式 false 会保留，避免会话被空闲回收重建后又
 * 退回计划模式。
 */
export function readPlanMode(
  sessionId: string,
  settingsPath = getGuardrailSettingsPath(),
): boolean {
  const settings = readGuardrailSettings(settingsPath);
  const explicit = settings.planModeSessions[sessionId];
  return explicit === undefined ? settings.planModeDefault : explicit;
}

export function writePlanMode(
  sessionId: string,
  enabled: boolean,
  settingsPath = getGuardrailSettingsPath(),
): GuardrailSettings {
  const current = readGuardrailSettings(settingsPath);
  const planModeSessions = { ...current.planModeSessions, [sessionId]: enabled };
  return write({ ...current, planModeSessions }, settingsPath);
}
