/**
 * Agent 注册表 —— 纯数据层。
 *
 * 设计约束：
 * - 顶层**不 import 任何 `node:*`**，客户端组件与 jiti 自测都能直接加载（同 lib/tool-presets.ts 的做法）。
 * - 平台开源、具体 Agent 私有：内置只保留平台自带的编码 Agent（Elen，Pi 内核）。
 *   其余 Agent 以「应用包」形式放在用户目录（默认 `~/.elenva/agents/<id>/manifest.json`），
 *   各自独立版本化、可私有、可分发，**不随本仓库开源**。
 */

import { parsePanels, type AgentPanel } from "./panels";
import { parseViews, type AgentView } from "./workspace";

export type AgentRuntime = "pi" | "hermes";

/** 应用包清单（manifest.json）。字段只增不改；未知字段忽略。 */
export interface AgentManifest {
  /** 稳定标识：小写字母 / 数字 / 连字符，必须与目录名一致 */
  id: string;
  /** 显示名 */
  name: string;
  description?: string;
  /** 单字符图标（emoji / 符号）；缺省取 name 首字 */
  icon?: string;
  /** 运行时：pi = 进程内 SDK；hermes = ACP 子进程（P1 接入） */
  runtime: AgentRuntime;
  /** Hermes profile 名（runtime=hermes 时用）；缺省等于 agent id */
  profile?: string;
  version?: string;
  /** 声明式面板：字符串或对象都接受，解析规则见 lib/agents/panels.ts */
  panels?: AgentPanel[];
  /**
   * 声明式工作台：导航项（view）→ 元件（block）。缺省时由 panels 推一个「概览」视图。
   * 解析规则见 lib/agents/workspace.ts。
   */
  views?: AgentView[];
  /** 平台面板开关（growth / subagents / observatory …，P0 只透传） */
  capabilities?: Record<string, boolean>;
  /** 数据目录（相对应用包目录；P1 起用于面板读取） */
  dataDir?: string;
}

export interface AgentRecord extends AgentManifest {
  source: "builtin" | "package";
  /** 应用包绝对路径；内置 Agent 为 null */
  dir: string | null;
  /**
   * 运行时可用性（P0 预检）：仅 runtime=hermes 的 Agent 会有这个字段 ——
   * PATH 上找不到 hermes 时为 false，界面据此在名册层置灰并给安装提示。
   * 没装运行时的 Agent 不是坏包，只是不可用；不会进注册表的 errors。
   */
  runtimeAvailable?: boolean;
}

export const BUILTIN_AGENT_ID = "elen";

/** id 规则：小写字母 / 数字开头，可含连字符，≤64 */
export const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const RUNTIMES: readonly AgentRuntime[] = ["pi", "hermes"];

/** 平台自带、不在用户目录里的 Agent。 */
export function builtinAgents(): AgentRecord[] {
  return [
    {
      id: BUILTIN_AGENT_ID,
      name: "Elen",
      description: "编码 Agent —— 平台自带工作台（Pi 内核，进程内）",
      icon: "⌘",
      runtime: "pi",
      source: "builtin",
      dir: null,
    },
  ];
}

export type ManifestParseResult =
  | { ok: true; manifest: AgentManifest }
  | { ok: false; reason: string };

function trimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text : null;
}

/**
 * 校验并归一化一份 manifest。
 *
 * 故意「宽进严出」：只拒绝会让注册表本身变得不可用的错误（id 非法、id 与目录不一致、
 * 缺 name、runtime 不认识），其余字段缺省即忽略 —— 这样应用包可以逐步长大，
 * 不会因为多写了一个字段就被整个下架。
 */
export function parseAgentManifest(raw: unknown, dirName: string): ManifestParseResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "manifest 不是对象" };
  }
  const obj = raw as Record<string, unknown>;

  const id = trimmedString(obj.id);
  if (!id) return { ok: false, reason: "缺少 id" };
  if (!AGENT_ID_RE.test(id)) return { ok: false, reason: `id 不合法（小写字母/数字/连字符，≤64）：${id}` };
  if (id !== dirName) return { ok: false, reason: `id 与目录名不一致：${id} ≠ ${dirName}` };

  const name = trimmedString(obj.name);
  if (!name) return { ok: false, reason: "缺少 name" };
  if (name.length > 40) return { ok: false, reason: "name 超过 40 字" };

  const runtimeText = trimmedString(obj.runtime) ?? "pi";
  if (!RUNTIMES.includes(runtimeText as AgentRuntime)) {
    return { ok: false, reason: `runtime 只支持 pi / hermes：${runtimeText}` };
  }

  const panels = parsePanels(obj.panels);
  const views = parseViews(obj.views, panels);

  let capabilities: Record<string, boolean> | undefined;
  if (typeof obj.capabilities === "object" && obj.capabilities !== null && !Array.isArray(obj.capabilities)) {
    const entries = Object.entries(obj.capabilities as Record<string, unknown>)
      .filter(([, value]) => typeof value === "boolean");
    if (entries.length > 0) capabilities = Object.fromEntries(entries) as Record<string, boolean>;
  }

  return {
    ok: true,
    manifest: {
      id,
      name,
      description: trimmedString(obj.description) ?? undefined,
      icon: trimmedString(obj.icon) ?? undefined,
      runtime: runtimeText as AgentRuntime,
      profile: trimmedString(obj.profile) ?? undefined,
      version: trimmedString(obj.version) ?? undefined,
      panels,
      views,
      capabilities,
      dataDir: trimmedString(obj.dataDir) ?? undefined,
    },
  };
}

/**
 * 内置 Agent 永远在前（顺序稳定），应用包按名称排序。
 * id 冲突时保留先出现的（内置优先），并返回一条可展示的冲突说明 —— 静默覆盖更难排查。
 */
export function mergeAgentRecords(packages: AgentRecord[]): { agents: AgentRecord[]; conflicts: string[] } {
  const agents = builtinAgents();
  const seen = new Set(agents.map((agent) => agent.id));
  const conflicts: string[] = [];

  const sorted = [...packages].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  for (const agent of sorted) {
    if (seen.has(agent.id)) {
      conflicts.push(`Agent id 重复，已忽略：${agent.id}${agent.dir ? `（${agent.dir}）` : ""}`);
      continue;
    }
    seen.add(agent.id);
    agents.push(agent);
  }
  return { agents, conflicts };
}

export function findAgent(agents: readonly AgentRecord[], id: string): AgentRecord | null {
  return agents.find((agent) => agent.id === id) ?? null;
}

/** 侧栏图标：优先 manifest.icon，缺省取名字首字（中文取第一个字）。 */
export function agentGlyph(agent: Pick<AgentManifest, "icon" | "name">): string {
  if (agent.icon) return agent.icon.slice(0, 2);
  return agent.name.trim().slice(0, 1) || "?";
}
