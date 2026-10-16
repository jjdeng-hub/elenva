/**
 * 「按会话细粒度工具选择」的纯函数层（client 安全：**不得**引入 node:* / fs）。
 *
 * 边界与分工（2026-10-16 侦察结论）：
 *  - 内核按名激活工具（`set_tools` → `setAgentSessionTools` → `setActiveToolSelection`）。
 *  - ELENVA 侧持久化只允许「内置编码工具」组合（`lib/session-tool-selection.ts` 的
 *    builtin-only 校验），所以可勾选落库的只有内置工具。
 *  - 扩展工具在内核侧随**任一**工具启用而启用（`lib/agent-runtime.ts` 的
 *    `withExtensionTools` 兼容行为：装了扩展就不会被静默关掉）；MCP 工具由内核按需暴露。
 *    因此这两组只做**展示 + 状态回显**，用 lock 标明为何不可单独开关。
 *
 * 本模块不改内核语义，只负责：可用工具分组、当前集合与三档预设的判定、勾选集合规范化。
 */
import {
  PRESET_DEFAULT,
  PRESET_FULL,
  PRESET_NONE,
  PRESET_READ_ONLY,
  type ToolPreset,
} from "./tool-presets";

/** 内置编码工具（与 lib/agent-runtime.ts 的 CODING_TOOL_NAMES 对齐），展示顺序固定。 */
export const BUILTIN_TOOL_ORDER = [
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

const BUILTIN_TOOL_NAMES = new Set<string>(BUILTIN_TOOL_ORDER);
/** Windows 上实际工具名是 powershell，判定预设时归一到 bash（与 getPresetFromToolNames 同口径）。 */
const SHELL_ALIAS: Record<string, string> = { powershell: "bash" };
/** 由内核扩展/按需暴露管理、不应出现在自定义清单里的非编码工具。 */
const KERNEL_EXPOSURE_TOOLS = new Set(["codemode", "tool_search"]);

export type ToolGroup = "builtin" | "extension" | "mcp";
/** 不可单独开关的原因：无 lock 表示可勾选落库。 */
export type ToolLock = "follows-toolset" | "kernel-exposure";

export interface ToolDescriptor {
  name: string;
  description?: string;
  active?: boolean;
  sourceInfo?: { source?: unknown; path?: unknown } | null;
  exposure?: unknown;
}

export interface GroupedTool extends ToolDescriptor {
  name: string;
  group: ToolGroup;
  lock: ToolLock | null;
}

export interface GroupedToolList {
  builtin: GroupedTool[];
  extension: GroupedTool[];
  mcp: GroupedTool[];
}

export type ToolSelectionMode =
  | { kind: "preset"; preset: ToolPreset }
  | { kind: "custom" };

function sourceOf(tool: ToolDescriptor): string {
  const source = tool.sourceInfo?.source;
  return typeof source === "string" ? source : "";
}

/** 内置 / 扩展 / MCP 三组判定：名字优先（稳），sourceInfo 兜底。 */
export function classifyToolGroup(tool: ToolDescriptor): ToolGroup {
  const source = sourceOf(tool);
  const nameIsMcp = tool.name.startsWith("mcp__") || tool.name.includes("mcp_resource");
  if (nameIsMcp || /mcp/i.test(source)) return "mcp";
  if (BUILTIN_TOOL_NAMES.has(tool.name) || source === "builtin") return "builtin";
  return "extension";
}

/** 该工具能否单独勾选：内置可，扩展（随工具集）与 MCP / 内核类不可。 */
export function toolLockReason(
  tool: ToolDescriptor,
  group: ToolGroup = classifyToolGroup(tool),
): ToolLock | null {
  if (KERNEL_EXPOSURE_TOOLS.has(tool.name)) return "kernel-exposure";
  if (group === "builtin") return null;
  if (group === "mcp") return "kernel-exposure";
  return "follows-toolset";
}

function builtinSortIndex(name: string): number {
  const index = BUILTIN_TOOL_ORDER.indexOf(name as (typeof BUILTIN_TOOL_ORDER)[number]);
  return index === -1 ? BUILTIN_TOOL_ORDER.length : index;
}

function sortTools(a: GroupedTool, b: GroupedTool): number {
  if (a.group === "builtin" && b.group === "builtin") {
    const byIndex = builtinSortIndex(a.name) - builtinSortIndex(b.name);
    if (byIndex !== 0) return byIndex;
  }
  return a.name.localeCompare(b.name);
}

/**
 * 把 `get_tools` 的返回按内置 / 扩展 / MCP 分组、去重、稳定排序。
 * 不改动入参；每条附 group 与 lock（lock 为 null 表示可勾选）。
 */
export function groupAvailableTools(tools: readonly ToolDescriptor[]): GroupedToolList {
  const grouped: GroupedToolList = { builtin: [], extension: [], mcp: [] };
  const seen = new Set<string>();
  for (const tool of tools) {
    if (!tool || typeof tool.name !== "string" || tool.name.length === 0) continue;
    if (seen.has(tool.name)) continue;
    seen.add(tool.name);
    const group = classifyToolGroup(tool);
    grouped[group].push({ ...tool, group, lock: toolLockReason(tool, group) });
  }
  grouped.builtin.sort(sortTools);
  grouped.extension.sort(sortTools);
  grouped.mcp.sort(sortTools);
  return grouped;
}

/** 规范化内置工具名集合：别名归一、过滤非内置、去重、按固定顺序排序。 */
export function canonicalBuiltinNames(names: readonly string[]): string[] {
  const canonical = new Set<string>();
  for (const name of names) {
    if (typeof name !== "string") continue;
    const normalized = SHELL_ALIAS[name] ?? name;
    if (BUILTIN_TOOL_NAMES.has(name) || BUILTIN_TOOL_NAMES.has(normalized)) {
      canonical.add(normalized);
    }
  }
  return [...canonical].sort((a, b) => builtinSortIndex(a) - builtinSortIndex(b));
}

/** 勾选集合规范化：保留实际工具名（如 powershell），去重并按内置顺序排序。 */
export function normalizeBuiltinSelection(names: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const name of names) {
    if (typeof name === "string" && BUILTIN_TOOL_NAMES.has(name)) seen.add(name);
  }
  return [...seen].sort((a, b) => builtinSortIndex(a) - builtinSortIndex(b));
}

function setKey(names: readonly string[]): string {
  return canonicalBuiltinNames(names).join(",");
}

function presetSet(names: readonly string[]): string {
  return canonicalBuiltinNames(names).join(",");
}

/**
 * 当前集合恰好等于三档预设之一 → 返回该预设；否则 null（= 自定义）。
 * 与 `getPresetFromToolNames` 的区别：后者把任意非预设内置集合兜底成 "default"，
 * 无法区分「真 default 档」与「自定义组合」——UI 需要这个区分。
 */
export function matchToolPreset(toolNames: readonly string[]): ToolPreset | null {
  if (toolNames.length === 0) return "none";
  const key = setKey(toolNames);
  if (key.length === 0) return null;
  if (key === presetSet(PRESET_NONE)) return "none";
  if (key === presetSet(PRESET_READ_ONLY)) return "read-only";
  if (key === presetSet(PRESET_DEFAULT)) return "default";
  if (key === presetSet(PRESET_FULL)) return "full";
  return null;
}

/** UI 判定：预设 or 自定义。 */
export function resolveToolSelectionMode(toolNames: readonly string[]): ToolSelectionMode {
  const preset = matchToolPreset(toolNames);
  return preset ? { kind: "preset", preset } : { kind: "custom" };
}

/** 从工具列表取内置工具名；activeOnly 时只取当前激活的。 */
export function builtinNamesFromTools(
  tools: readonly ToolDescriptor[],
  options: { activeOnly?: boolean } = {},
): string[] {
  const names = tools
    .filter((tool) => classifyToolGroup(tool) === "builtin")
    .filter((tool) => (options.activeOnly ? tool.active === true : true))
    .map((tool) => tool.name);
  return normalizeBuiltinSelection(names);
}

/** 勾选/取消一个内置工具，返回规范化后的新集合（不修改入参）。 */
export function toggleBuiltinSelection(
  names: readonly string[],
  name: string,
  enabled: boolean,
): string[] {
  const next = new Set(normalizeBuiltinSelection(names));
  if (enabled) next.add(name);
  else next.delete(name);
  return [...next].sort((a, b) => builtinSortIndex(a) - builtinSortIndex(b));
}

/** 两个勾选集合是否等价（顺序无关、别名归一）。 */
export function sameBuiltinSelection(a: readonly string[], b: readonly string[]): boolean {
  return normalizeBuiltinSelection(a).join(",") === normalizeBuiltinSelection(b).join(",");
}
