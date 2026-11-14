/**
 * Agent 工作台声明层（纯函数，无 node:* 依赖）。
 *
 * 从「面板」升级到「工作台」：`panels` 只能把几块卡片竖着堆在一页上，
 * 而每个 Agent 真正需要的是**自己的导航 + 自己的分栏**（选题库 / 草稿台 / 发布排期）。
 * 于是多一层 `views`：view = 导航项，block = 页面里的元件，`source` 指数据文件。
 *
 * 三条边界：
 * - 元件由平台实现（`components/agent-blocks.tsx`），Agent 只声明 —— 私有应用包不带前端代码；
 * - 块类型收敛（先五种展示 + 正文 + 动作），新增要先问「现有类型真的表达不了吗」；
 * - 容错优先：单块写错只丢这一块，不让整个工作台变成错误页。
 */

import { PANEL_TYPES, parsePanels, type AgentPanel, type PanelType } from "./panels";

/** 可渲染的块类型：面板五种 + 正文（doc）+ 片子（film）。 */
export const BLOCK_TYPES = [...PANEL_TYPES, "doc", "film"] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

/** 块上的动作：把「选中的那条」渲染成一句 prompt，交给该 Agent 的会话去干。 */
export interface BlockAction {
  id: string;
  label: string;
  /** prompt 模板，占位符 `{title}` / `{meta}` / `{row.1}` 之类由调用方给值 */
  prompt: string;
}

export interface AgentBlock {
  id: string;
  title: string;
  type: BlockType;
  /** 数据来源：doc 指向目录（`.md` 列表），其余指向 JSON 文件；相对应用包根目录 */
  source?: string;
  /** 数据契约（schema.json，相对应用包根目录）；声明了才允许从界面写入 */
  schema?: string;
  /** 允许在界面上直接编辑的字段名（table 的列名 / items 的字段名） */
  editable?: string[];
  /**
   * 空状态的一句话（≤160 字）。
   *
   * 空面板最容易被做成「暂无数据」四个字——那是平台的语气，不是这个 Agent 的语气。
   * 让应用包自己写这句：没有训练记录时该说「练完报一句，我按日期补一行」，
   * 没有待办时该说「想到什么直接说」。平台只负责留位置。
   */
  emptyHint?: string;
  actions?: BlockAction[];
}

export interface AgentView {
  id: string;
  title: string;
  blocks: AgentBlock[];
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_VIEWS = 8;
const MAX_BLOCKS = 12;
const MAX_ACTIONS = 4;
const MAX_EDITABLE = 8;

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text : null;
}

/** 相对路径：不带盘符、不越界、不含控制字符。绝对路径交由服务端再判一次。 */
function asRelPath(value: unknown): string | null {
  const text = asText(value);
  if (!text || text.length > 200) return null;
  if (/[\u0000-\u001f]/.test(text)) return null;
  if (text.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(text)) return null;
  if (text.split(/[\\/]/).some((part) => part === "..")) return null;
  return text;
}

function parseActions(raw: unknown): BlockAction[] {
  if (!Array.isArray(raw)) return [];
  const actions: BlockAction[] = [];
  const seen = new Set<string>();
  for (const entry of raw.slice(0, MAX_ACTIONS)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const obj = entry as Record<string, unknown>;
    const id = asText(obj.id);
    const label = asText(obj.label);
    const prompt = asText(obj.prompt);
    if (!id || !ID_RE.test(id) || !label || !prompt || seen.has(id)) continue;
    seen.add(id);
    actions.push({ id, label, prompt });
  }
  return actions;
}

function parseBlock(raw: unknown, viewId: string, index: number): AgentBlock | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const id = asText(obj.id) ?? `block-${index + 1}`;
  if (!ID_RE.test(id)) return null;
  const type = (asText(obj.type) ?? "cards") as BlockType;
  if (!(BLOCK_TYPES as readonly string[]).includes(type)) return null;

  const editable = Array.isArray(obj.editable)
    ? obj.editable.filter((name): name is string => typeof name === "string" && name.trim().length > 0)
        .slice(0, MAX_EDITABLE)
    : [];

  return {
    id: `${viewId}-${id}`,
    title: asText(obj.title) ?? id,
    type,
    source: asRelPath(obj.source) ?? undefined,
    schema: asRelPath(obj.schema) ?? undefined,
    editable: editable.length > 0 ? editable : undefined,
    emptyHint: asText(obj.emptyHint)?.slice(0, 160) || undefined,
    actions: parseActions(obj.actions),
  };
}

/**
 * 解析 manifest.views。
 *
 * 兼容三种写法：
 * - 省略 `views` → 由 `panels` 推一个「概览」视图（老应用包零改动）；
 * - 单个视图对象 → 包成数组（懒人写法）；
 * - 数组 → 逐视图解析，坏视图/坏块跳过并计数。
 */
export function parseViews(raw: unknown, panels: AgentPanel[] = []): AgentView[] {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const views: AgentView[] = [];
  const seen = new Set<string>();

  for (const entry of list.slice(0, MAX_VIEWS)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const obj = entry as Record<string, unknown>;
    const id = asText(obj.id);
    if (!id || !ID_RE.test(id) || seen.has(id)) continue;
    const blocks = Array.isArray(obj.blocks)
      ? obj.blocks
          .slice(0, MAX_BLOCKS)
          .map((block, index) => parseBlock(block, id, index))
          .filter((block): block is AgentBlock => block !== null)
      : [];
    seen.add(id);
    views.push({ id, title: asText(obj.title) ?? id, blocks });
  }

  if (views.length > 0) return views;
  return viewsFromPanels(panels);
}

/** 老应用包（只有 panels）退化成单视图 —— 界面不因缺 views 而空着。 */
export function viewsFromPanels(panels: AgentPanel[]): AgentView[] {
  if (panels.length === 0) return [];
  return [
    {
      id: "overview",
      title: "概览",
      blocks: panels.slice(0, MAX_BLOCKS).map((panel) => ({
        id: `${panel.id}`,
        title: panel.title,
        type: panel.type as BlockType,
        source: panel.source,
      })),
    },
  ];
}

/** doc 块按目录读；其余按文件读。 */
export function isDocBlock(block: AgentBlock): boolean {
  return block.type === "doc";
}

/** 面板类型断言（AgentBlock.type 比 PanelType 多一个 doc）。 */
export function asPanelType(type: BlockType): PanelType | null {
  return (PANEL_TYPES as readonly string[]).includes(type) ? (type as PanelType) : null;
}

/** 供自测/路由复用：从 manifest 原始对象取 panels（保持与 manifest 解析同源）。 */
export function panelsOf(raw: unknown): AgentPanel[] {
  return parsePanels(raw);
}

/**
 * 找出能写这个数据路径的块：JSON 精确匹配 `source`，Markdown 落在 doc 块目录内。
 *
 * 放在 lib 而不是 route 里：Next 的 route 文件只允许导出 GET/POST/… 那一组，
 * 多导出一个普通函数会让构建期的 route 类型检查挂掉（`tsc --noEmit` 看不见，因为
 * `.next/types` 是构建时才生成的）。
 */
export function findBlockByDataPath(views: AgentView[], path: string): AgentBlock | null {
  const normalized = path.split("\\").join("/").replace(/^\.\//, "");
  for (const view of views) {
    for (const block of view.blocks) {
      if (!block.source) continue;
      const source = block.source.split("\\").join("/").replace(/^\.\//, "").replace(/\/$/, "");
      if (block.type === "doc") {
        if (normalized.startsWith(`${source}/`) && normalized.toLowerCase().endsWith(".md")) return block;
      } else if (normalized === source) {
        return block;
      }
    }
  }
  return null;
}

/* ---------------- 界面载荷（服务端 GET /api/agents/workspace 与前端共用） ---------------- */

import type { PanelData } from "./panels";

export interface BlockFileRef {
  path: string;
  name: string;
  size: number;
  revision: string;
}

/**
 * 一个块渲染所需的全部东西：声明 + 数据 + 版本号。
 * 放在 lib 而不是组件里：AgentWorkspace / agent-blocks / agent-doc-editor 三处都要用，
 * 组件之间互相 import 类型会绕成环。
 */
export interface BlockPayload {
  id: string;
  title: string;
  type: BlockType;
  source?: string;
  schema?: string;
  editable?: string[];
  emptyHint?: string;
  actions?: BlockAction[];
  data?: PanelData;
  revision?: string;
  files?: BlockFileRef[];
  /** film 块：扫出来的片子工程 */
  films?: FilmProjectPayload[];
  error?: string;
}

export interface FilmProjectPayload {
  slug: string;
  title: string;
  logline?: string;
  video?: { path: string; bytes: number };
  stills: { path: string; name: string }[];
  files: { name: string; bytes: number }[];
  updatedAt: string;
  missingVideo: boolean;
  progress?: {
    stage: "render" | "encode" | "done";
    frame?: number;
    total?: number;
    percent: number;
    etaSec?: number;
    updatedAt: string;
    stale: boolean;
  };
}
