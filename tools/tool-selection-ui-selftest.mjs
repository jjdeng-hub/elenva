// 「按会话细粒度工具选择」纯函数（lib/tool-selection-ui.ts）的自检：
// 分组判定 / lock 原因 / 去重排序 / 预设与自定义判定 / 勾选规范化与等价。
// 全用**虚构**工具数据，不触碰真实会话。
// 运行：node tools/tool-selection-ui-selftest.mjs
//
// lib/tool-selection-ui.ts 是纯 .ts（无 JSX、无 node:*），jiti 可直载并解析 `@/` 别名。
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const {
  BUILTIN_TOOL_ORDER,
  classifyToolGroup,
  toolLockReason,
  groupAvailableTools,
  canonicalBuiltinNames,
  normalizeBuiltinSelection,
  matchToolPreset,
  resolveToolSelectionMode,
  builtinNamesFromTools,
  toggleBuiltinSelection,
  sameBuiltinSelection,
} = await jiti.import("../lib/tool-selection-ui.ts");

let fail = 0;
let total = 0;
const check = (name, fn) => {
  total += 1;
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
};
const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};
const eq = (actual, expected, message) =>
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`,
  );

// —— 虚构工具集：内置 + 扩展 + MCP + 内核按需 ——
const tool = (name, extra = {}) => ({ name, description: `${name} desc`, active: false, ...extra });
const TOOLS = [
  tool("read", { active: true, sourceInfo: { source: "builtin" } }),
  tool("bash", { active: true, sourceInfo: { source: "builtin" } }),
  tool("edit", { sourceInfo: { source: "builtin" } }),
  tool("write", { sourceInfo: { source: "builtin" } }),
  tool("grep", { sourceInfo: { source: "builtin" } }),
  tool("find", { sourceInfo: { source: "builtin" } }),
  tool("ls", { sourceInfo: { source: "builtin" } }),
  tool("memory_find", { active: true, sourceInfo: { source: "extension:elenva-memory" } }),
  tool("worklog_write", { active: true, sourceInfo: { source: "extension:elenva-worklog" } }),
  tool("web_search", { active: true, sourceInfo: { source: "extension:pi-search" } }),
  tool("mcp__docs__search", { sourceInfo: { source: "extension:mcp" } }),
  tool("read_mcp_resource", { sourceInfo: { source: "extension:mcp" } }),
  tool("tool_search", { sourceInfo: { source: "builtin" } }),
];

check("BUILTIN_TOOL_ORDER 覆盖 agent-runtime 的内置编码工具", () => {
  eq(
    [...BUILTIN_TOOL_ORDER].sort(),
    ["bash", "edit", "find", "grep", "ls", "powershell", "read", "write"],
    "内置工具顺序表",
  );
});

check("classifyToolGroup：内置 / 扩展 / MCP 分组", () => {
  eq(classifyToolGroup(tool("read")), "builtin", "read 是内置");
  eq(classifyToolGroup(tool("powershell", { sourceInfo: { source: "builtin" } })), "builtin", "powershell 是内置");
  eq(classifyToolGroup(tool("memory_find", { sourceInfo: { source: "extension:elenva-memory" } })), "extension", "扩展工具");
  eq(classifyToolGroup(tool("web_search", { sourceInfo: { source: "extension:pi-search" } })), "extension", "pi 包工具归扩展");
  eq(classifyToolGroup(tool("mcp__docs__search", { sourceInfo: { source: "extension:mcp" } })), "mcp", "mcp__ 前缀归 MCP");
  eq(classifyToolGroup(tool("read_mcp_resource", { sourceInfo: { source: "builtin" } })), "mcp", "mcp 资源工具归 MCP");
  eq(classifyToolGroup(tool("custom_x", { sourceInfo: { source: "builtin" } })), "builtin", "source=builtin 兜底内置");
});

check("toolLockReason：内置可勾选，扩展随工具集，MCP/内核按需", () => {
  eq(toolLockReason(tool("read")), null, "内置可勾选");
  eq(toolLockReason(tool("memory_find", { sourceInfo: { source: "extension:elenva-memory" } })), "follows-toolset", "扩展随工具集");
  eq(toolLockReason(tool("mcp__docs__search", { sourceInfo: { source: "extension:mcp" } })), "kernel-exposure", "MCP 由内核按需");
  eq(toolLockReason(tool("tool_search", { sourceInfo: { source: "builtin" } })), "kernel-exposure", "tool_search 由内核管理");
});

check("groupAvailableTools：分组、去重、内置按固定顺序", () => {
  const grouped = groupAvailableTools([...TOOLS, tool("read", { active: true })]); // 重复 read
  eq(
    grouped.builtin.map((t) => t.name),
    ["read", "bash", "edit", "write", "grep", "find", "ls", "tool_search"],
    "内置组名称与顺序（tool_search 也落内置组，但 lock 非 null）",
  );
  eq(grouped.builtin.find((t) => t.name === "read")?.lock, null, "read lock=null");
  eq(grouped.builtin.find((t) => t.name === "tool_search")?.lock, "kernel-exposure", "tool_search lock");
  eq(grouped.extension.map((t) => t.name), ["memory_find", "web_search", "worklog_write"], "扩展组按名排序");
  eq(grouped.mcp.map((t) => t.name), ["mcp__docs__search", "read_mcp_resource"], "MCP 组按名排序");
  assert(grouped.builtin.filter((t) => t.name === "read").length === 1, "重复 read 应去重");
});

check("canonicalBuiltinNames：别名归一 + 过滤非内置 + 排序", () => {
  eq(canonicalBuiltinNames(["powershell", "read", "memory_find", "grep"]), ["read", "bash", "grep"], "powershell→bash 保留、非内置剔除、按内置顺序排序");
  eq(canonicalBuiltinNames(["bash", "powershell"]), ["bash"], "bash 与 powershell 归一到同一项");
  eq(canonicalBuiltinNames([]), [], "空集合");
});

check("matchToolPreset：三档预设 vs 自定义", () => {
  eq(matchToolPreset([]), "none", "空 = 问答");
  eq(matchToolPreset(["read", "grep", "find", "ls"]), "read-only", "只读 = read·grep·find·ls");
  eq(matchToolPreset(["ls", "read", "find", "grep"]), "read-only", "顺序无关");
  eq(matchToolPreset(["read", "bash", "edit", "write"]), "default", "旧 default 档");
  eq(matchToolPreset(["bash", "read", "edit", "write", "grep", "find", "ls"]), "full", "Agent 全开");
  eq(matchToolPreset(["read", "edit", "write"]), null, "去掉 bash = 自定义");
  eq(matchToolPreset(["read", "bash", "edit", "write", "grep"]), null, "缺 find/ls = 自定义");
  eq(matchToolPreset(["read", "powershell", "edit", "write"]), "default", "Windows powershell 归一到 default");
});

check("resolveToolSelectionMode：预设/自定义判定", () => {
  eq(resolveToolSelectionMode(["read", "bash", "edit", "write"]), { kind: "preset", preset: "default" }, "预设");
  eq(resolveToolSelectionMode([]), { kind: "preset", preset: "none" }, "问答预设");
  eq(resolveToolSelectionMode(["read", "edit"]), { kind: "custom" }, "自定义组合");
  eq(resolveToolSelectionMode(["memory_find"]), { kind: "custom" }, "只有扩展工具 = 自定义（落库为空集合语义）");
});

check("builtinNamesFromTools：全部 / 仅激活", () => {
  eq(
    builtinNamesFromTools(TOOLS),
    ["read", "bash", "edit", "write", "grep", "find", "ls"],
    "全部内置（tool_search 虽归内置组，但不是编码内置工具，会被规范化为空）",
  );
  eq(builtinNamesFromTools(TOOLS, { activeOnly: true }), ["read", "bash"], "仅激活内置");
});

check("toggleBuiltinSelection / normalizeBuiltinSelection：勾选规范化", () => {
  eq(toggleBuiltinSelection(["read"], "bash", true), ["read", "bash"], "勾选后按固定顺序");
  eq(toggleBuiltinSelection(["read", "bash"], "bash", false), ["read"], "取消勾选");
  eq(toggleBuiltinSelection(["read"], "read", true), ["read"], "重复勾选幂等");
  eq(toggleBuiltinSelection(["read", "read"], "read", true), ["read"], "重复项去重");
  eq(normalizeBuiltinSelection(["ls", "bash", "not_a_tool", "read"]), ["read", "bash", "ls"], "过滤非内置并排序");
  eq(normalizeBuiltinSelection(["powershell"]), ["powershell"], "保留实际工具名 powershell");
});

check("sameBuiltinSelection：顺序/别名无关等价", () => {
  assert(sameBuiltinSelection(["read", "bash"], ["bash", "read"]), "顺序无关");
  assert(sameBuiltinSelection(["read"], ["read", "read"]), "重复无关");
  assert(!sameBuiltinSelection(["read"], ["read", "bash"]), "不同集合不等价");
});

console.log(fail === 0 ? `\n全部通过（${total} 项）` : `\n${fail}/${total} 项失败`);
process.exit(fail === 0 ? 0 : 1);
