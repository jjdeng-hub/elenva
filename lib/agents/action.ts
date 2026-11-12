/**
 * 块动作（BlockAction）的 prompt 渲染（纯函数，无 node:* 依赖）。
 *
 * 「点一下就让它干」不该需要一套编排层：动作模板 + 选中的那条数据 = 一句 prompt，
 * 投进该 Agent 自己的会话即可。模板语法只有 `{字段}`，占位符缺值直接报错 ——
 * 静默留空会让 Agent 收到一句残缺的指令，比报错更难查。
 */

const MAX_PROMPT = 4000;
/** 占位符允许中文（表格列名、items 字段名都是中文居多），只排除空白与花括号本身。 */
const PLACEHOLDER = /\{([^{}\s]{1,40})\}/g;

export type RenderResult = { ok: true; text: string } | { ok: false; error: string };

/** context 的键大小写不敏感（表格列名常是中文/大小写混杂，界面上不好统一）。 */
function normalizeContext(context: Record<string, unknown>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(context)) {
    if (value === null || value === undefined) continue;
    const text = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
    if (!text.trim()) continue;
    map.set(key.trim().toLowerCase(), text.trim());
  }
  return map;
}

export function renderActionPrompt(template: string, context: Record<string, unknown>): RenderResult {
  const src = template.trim();
  if (!src) return { ok: false, error: "动作模板为空" };
  const values = normalizeContext(context);
  const missing: string[] = [];

  const text = src.replace(PLACEHOLDER, (match, name: string) => {
    const value = values.get(name.toLowerCase());
    if (value === undefined) {
      missing.push(name);
      return match;
    }
    return value;
  });

  if (missing.length > 0) {
    return { ok: false, error: `动作模板缺少取值：${[...new Set(missing)].join(" / ")}（选中项里没有这个字段）` };
  }
  if (text.length > MAX_PROMPT) return { ok: false, error: `动作内容超过 ${MAX_PROMPT} 字` };
  return { ok: true, text };
}

/** 动作模板里用到的占位符（用于界面提示「这条动作需要哪些字段」）。 */
export function actionPlaceholders(template: string): string[] {
  const names = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) names.add(match[1]);
  return [...names];
}
