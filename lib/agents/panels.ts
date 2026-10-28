/**
 * Agent 面板声明层（纯函数，无 node:* 依赖）。
 *
 * 设计：过程层统一、结果层各异。
 * - 过程（工具卡片 / 审批 / 时间线）由外壳提供；
 * - 结果（预算表、决策卡、发布排期、封面墙）由 Agent 在 manifest 里**声明**，
 *   外壳按类型渲染 —— 不为每个 Agent 写一套前端。
 *
 * 面板类型收敛成五种；新增类型要先问一句「现有五种真的表达不了吗」。
 */

export const PANEL_TYPES = ["cards", "table", "timeline", "gallery", "queue"] as const;
export type PanelType = (typeof PANEL_TYPES)[number];

export interface AgentPanel {
  id: string;
  title: string;
  type: PanelType;
  /** 数据文件（相对应用包根目录）；缺省 = 空面板，只显示标题与空状态 */
  source?: string;
}

export interface PanelData {
  /** table 用 */
  columns?: string[];
  /** table 用 */
  rows?: string[][];
  /** cards / queue / timeline / gallery 用 */
  items?: PanelItem[];
}

export interface PanelItem {
  title: string;
  meta?: string;
  status?: string;
  detail?: string;
  /** timeline 用 */
  date?: string;
  /** gallery 用（http(s) 直链；本地文件在 P1 接上文件访问后再支持） */
  src?: string;
}

const PANEL_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * 解析 manifest.panels。
 *
 * 兼容两种写法：字符串（`"budget"` → 一个 cards 面板，id 与标题同名）与对象。
 * 非法项**跳过而不是整包作废** —— 面板是展示层，不该挡住 Agent 注册。
 */
export function parsePanels(raw: unknown): AgentPanel[] {
  if (!Array.isArray(raw)) return [];
  const panels: AgentPanel[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    let panel: AgentPanel | null = null;
    if (typeof entry === "string") {
      const id = entry.trim();
      if (PANEL_ID_RE.test(id)) panel = { id, title: id, type: "cards" };
    } else if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      const obj = entry as Record<string, unknown>;
      const id = asText(obj.id);
      const type = asText(obj.type) ?? "cards";
      if (id && PANEL_ID_RE.test(id) && (PANEL_TYPES as readonly string[]).includes(type)) {
        panel = {
          id,
          title: asText(obj.title) ?? id,
          type: type as PanelType,
          source: asText(obj.source) ?? undefined,
        };
      }
    }
    if (!panel || seen.has(panel.id)) continue;
    seen.add(panel.id);
    panels.push(panel);
  }
  return panels;
}

/**
 * 把数据文件归一化成五种面板之一。
 *
 * 容错优先：结构不对就退化成空数据，而不是让面板报错 —— 面板空着能看出「没数据」，
 * 报错只会让人以为 Agent 坏了。
 */
export function normalizePanelData(type: PanelType, raw: unknown): PanelData {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return emptyPanelData(type);
  const obj = raw as Record<string, unknown>;

  if (type === "table") {
    const columns = Array.isArray(obj.columns)
      ? obj.columns.filter((c): c is string => typeof c === "string").map((c) => c.trim()).filter(Boolean)
      : [];
    const rows = Array.isArray(obj.rows)
      ? obj.rows
          .filter((row): row is unknown[] => Array.isArray(row))
          .map((row) => row.map((cell) => (cell === null || cell === undefined ? "" : String(cell))))
          .filter((row) => row.length > 0)
      : [];
    return { columns, rows };
  }

  const items = Array.isArray(obj.items)
    ? obj.items.flatMap((entry): PanelItem[] => {
        if (typeof entry === "string" && entry.trim()) return [{ title: entry.trim() }];
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
        const item = entry as Record<string, unknown>;
        const title = asText(item.title);
        if (!title) return [];
        return [
          {
            title,
            meta: asText(item.meta) ?? undefined,
            status: asText(item.status) ?? undefined,
            detail: asText(item.detail) ?? undefined,
            date: asText(item.date) ?? undefined,
            src: asText(item.src) ?? undefined,
          },
        ];
      })
    : [];
  return { items };
}

export function emptyPanelData(type: PanelType): PanelData {
  return type === "table" ? { columns: [], rows: [] } : { items: [] };
}

export function panelHasData(type: PanelType, data: PanelData): boolean {
  return type === "table" ? (data.rows?.length ?? 0) > 0 : (data.items?.length ?? 0) > 0;
}
