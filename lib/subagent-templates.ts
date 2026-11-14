// 子代理模板：常用角色的一键起点（调研 / 审计 / 复核）。
//
// 设计约束：
// - 纯数据 + 纯函数；**顶层不 import 任何 `node:*`**，可被客户端组件与 jiti 自测直接加载。
// - 工具名全部来自 `lib/tool-presets.ts` 的既有清单（PRESET_READ_ONLY / PRESET_FULL），不臆造。
// - 模型字段一律**不设置**（继承父会话/默认），thinking 同样留空（继承），避免把模型选择硬编码进模板。
//
// 依据（《深入理解 AI Agent》ch10 多 Agent 协作）：
// - 「多 Agent 何时真正优于单 Agent」（book/chapter10.md L46 起）：审核者若只是复述提议者、
//   没有引入新信息（执行反馈 / 工具反馈），通常无效甚至有害——故复核员**必须能跑检查拿到真实输出**。
// - 「对等协作模式」（同章 L194 起）：多个实例 ≠ 多种思路，需主动区分职责与可见证据，先独立判断再汇总
//   ——故三个模板的职责/边界/输出格式刻意不同，且默认不继承父会话上下文（独立视角）。
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { PRESET_READ_ONLY } from "./tool-presets";

export type SubagentTemplateIcon = "search" | "shield-alert" | "shield-check";

/** 模板落到 profile 的默认字段（与 `Omit<SubagentProfile, "scope" | "filePath">` 同形）。 */
export interface SubagentTemplateProfile {
  name: string;
  displayName: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  loadSkills: boolean;
  loadExtensions: boolean;
  model?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  inheritContext: boolean;
  runInBackground: boolean;
  enabled: boolean;
}

export interface SubagentTemplate extends Omit<SubagentTemplateProfile, "name"> {
  /** 稳定标识；同时作为创建时的默认 `name`（文件名）。 */
  id: string;
  /** 卡片图标的语义名，由界面映射到具体图标组件。 */
  icon: SubagentTemplateIcon;
}

/** 只读工具 + bash：允许跑验证命令，但不给 edit / write（复核员不得改动被验证对象）。 */
const READ_AND_RUN_TOOLS = [...PRESET_READ_ONLY, "bash"];

export const SUBAGENT_TEMPLATES: readonly SubagentTemplate[] = [
  {
    id: "researcher",
    icon: "search",
    displayName: "调研员",
    description: "收集事实并给出处，只读，为委派者提供可核查的一手信息",
    systemPrompt: `你是一名调研员（Researcher）。你的唯一职责是**收集事实并给出处**，为委派者提供可核查的一手信息。

## 边界
- 只读：可以读取文件、搜索代码、列出目录；禁止修改任何文件。
- 不代替委派者做实现决策，不写代码补丁；被要求实现时，指出这超出调研范围。
- 每条关键事实都要能追溯来源：文件路径（尽可能带行号）或外部链接。找不到来源的内容标注「未核实」。

## 方法
- 先明确问题边界，再检索；优先看一手代码与配置，而不是二手描述。
- 覆盖多种可能：同名符号、相似实现、历史遗留路径。
- 严格区分「我看到的事实」与「我的推断」。

## 输出格式
1. 结论要点（3–7 条，每条一句话）
2. 证据清单：\`路径:行号\` 或 \`URL\` — 一句话说明它支持了哪条结论
3. 未解问题 / 不确定项
4. 建议的下一步调查（可选，最多 3 条）`,
    tools: [...PRESET_READ_ONLY],
    loadSkills: false,
    loadExtensions: false,
    maxTurns: 24,
    inheritContext: false,
    runInBackground: false,
    enabled: true,
  },
  {
    id: "auditor",
    icon: "shield-alert",
    displayName: "审计员",
    description: "找出问题、风险与不一致，只读，按严重度给出可定位的发现",
    systemPrompt: `你是一名审计员（Auditor）。你的职责是**找出问题、风险与不一致**，而不是确认一切正常。

## 边界
- 只读：可以读取文件、搜索代码、列出目录；禁止修改任何文件。
- 不带立场：不替被审对象辩护，也不为凑数量编造问题。
- 每条发现都要能定位到具体位置；无法证实的只列为「疑似」，并说明还需要什么证据。

## 方法
- 对照三类判据：正确性（与声明 / 契约是否一致）、安全性（边界、权限、注入、越界写）、一致性（同类实现是否互相矛盾）。
- 重点排查：错误是否被静默吞掉、默认值是否有害、并发 / 竞态、资源泄漏、未经验证的输入。
- 结论必须带证据；引用实际代码片段，而不是转述。

## 输出格式
按严重度分组：
- 阻断 / 高：会导致错误结果或安全问题的具体位置
- 中：健壮性、可维护性风险
- 低 / 建议
每条：\`路径:行号\` — 问题 — 证据（引用代码） — 影响。若确实没有问题，明确说明检查了哪些范围。`,
    tools: [...PRESET_READ_ONLY],
    loadSkills: false,
    loadExtensions: false,
    maxTurns: 20,
    inheritContext: false,
    runInBackground: false,
    enabled: true,
  },
  {
    id: "verifier",
    icon: "shield-check",
    displayName: "复核员",
    description: "独立核验：自己跑检查、拿真实输出对结论，不改被验证对象",
    systemPrompt: `你是一名复核员（Verifier）。你的职责是**独立核验一个已完成的工作**：用可执行的证据判断它是否真的成立，而不是复述作者的说明。

## 边界
- 允许执行验证类命令（bash），但**禁止修改代码、测试、配置或证据采集方式**——一旦改动被验证对象，核验即失效。
- 不采信口头的「已完成」：结论只能建立在你亲自跑出来的结果上。
- 无法验证的部分如实标注为「无法判定」，不猜测。

## 方法
- 先逐条复述要核验的具体主张（例如「测试 X 通过」「功能 Y 可用」）。
- 为每条主张选择能**证伪**它的最小检查：跑相关测试、类型检查、构建、命令实测、复现步骤。
- 记录实际执行的命令与原始输出（含退出码），再对照主张给出判定。
- 不放宽判定标准；证据不足时，说明还需要哪些证据。

## 输出格式
1. 待核验的主张（逐条）
2. 每条：命令 → 实际输出摘要（含退出码） → 判定（通过 / 不通过 / 无法判定）
3. 覆盖范围与未覆盖范围（哪些没验）
4. 若存在不通过项：给出最小复现步骤`,
    tools: [...READ_AND_RUN_TOOLS],
    loadSkills: false,
    loadExtensions: false,
    maxTurns: 30,
    inheritContext: false,
    runInBackground: false,
    enabled: true,
  },
];

export function getSubagentTemplate(id: string): SubagentTemplate | undefined {
  return SUBAGENT_TEMPLATES.find((template) => template.id === id);
}

function templateDefaults(template: SubagentTemplate): SubagentTemplateProfile {
  return {
    name: template.id,
    displayName: template.displayName,
    description: template.description,
    systemPrompt: template.systemPrompt,
    tools: [...template.tools],
    loadSkills: template.loadSkills,
    loadExtensions: template.loadExtensions,
    inheritContext: template.inheritContext,
    runInBackground: template.runInBackground,
    enabled: template.enabled,
    ...(template.model !== undefined ? { model: template.model } : {}),
    ...(template.thinking !== undefined ? { thinking: template.thinking } : {}),
    ...(template.maxTurns !== undefined ? { maxTurns: template.maxTurns } : {}),
  };
}

/**
 * 模板 → profile：覆盖合并（overrides 里的字段优先）。
 *
 * **未覆盖语义（`undefined` 与 `null` 等价）**：本函数用 `??` 判覆盖，因此 `undefined`
 * **和 `null` 都表示「未覆盖、继承模板」**（而不是「清空」）。`tools` 用 `[...(overrides.tools ?? base.tools)]`
 * 同理：传 `null` 等于不传。要表达「显式清空」需要另开一个专门的字段（例如 tools 的 `[]`
 * 是空数组本身、不是 null），**不要用 `null` 去表达清空**——它会被当成继承。
 * 返回的 `tools` 总是新数组，调用方修改不会污染模板常量。
 */
export function toProfile(
  template: SubagentTemplate,
  overrides: Partial<SubagentTemplateProfile> = {},
): SubagentTemplateProfile {
  const base = templateDefaults(template);
  const model = overrides.model ?? base.model;
  const thinking = overrides.thinking ?? base.thinking;
  const maxTurns = overrides.maxTurns ?? base.maxTurns;
  return {
    name: (overrides.name ?? base.name).trim() || base.name,
    displayName: overrides.displayName ?? base.displayName,
    description: overrides.description ?? base.description,
    systemPrompt: overrides.systemPrompt ?? base.systemPrompt,
    tools: [...(overrides.tools ?? base.tools)],
    loadSkills: overrides.loadSkills ?? base.loadSkills,
    loadExtensions: overrides.loadExtensions ?? base.loadExtensions,
    inheritContext: overrides.inheritContext ?? base.inheritContext,
    runInBackground: overrides.runInBackground ?? base.runInBackground,
    enabled: overrides.enabled ?? base.enabled,
    ...(model !== undefined ? { model } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  };
}
