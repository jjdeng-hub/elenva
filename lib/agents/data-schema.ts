/**
 * Agent 数据契约（schema.json）的解析与校验（纯函数，无 node:* 依赖）。
 *
 * 为什么需要它：界面上的「可编辑」不能靠信任 —— 人在表格里改一个字段、
 * Agent 在终端里改同一份文件，两边都得落在同一个形状上，否则下一次读取就会退化成空面板。
 * 契约是**只增不改**的小语言：够表达这几类数据文件，不引入完整 JSON Schema 的复杂度。
 *
 * 两种形状（与 `panels.ts` 的归一化口径一致）：
 * - items：`{ "items": [ { title, meta, status, detail, date, src } ] }`
 * - table：`{ "columns": [...], "rows": [[...]] }`
 */

export type FieldType = "string" | "number" | "boolean";

export interface ItemsSchema {
  kind: "items";
  /** 字段名 → 类型；未列出的字段一律拒绝写入（防手滑加字段把读取方弄哑） */
  fields: Record<string, FieldType>;
  required: string[];
  /** 标题字段名，缺省 title；界面用它做一行摘要 */
  titleField?: string;
}

export interface TableSchema {
  kind: "table";
  columns: string[];
}

export type DataSchema = ItemsSchema | TableSchema;

const FIELD_TYPES: readonly FieldType[] = ["string", "number", "boolean"];
const MAX_ITEMS = 500;
const MAX_ROWS = 500;
const MAX_COLUMNS = 20;
const MAX_TEXT = 20000;

export type SchemaParseResult = { ok: true; schema: DataSchema } | { ok: false; error: string };

function asFields(raw: unknown): Record<string, FieldType> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const out: Record<string, FieldType> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key.trim()) return null;
    if (typeof value !== "string" || !FIELD_TYPES.includes(value as FieldType)) return null;
    out[key] = value as FieldType;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function parseSchema(raw: unknown): SchemaParseResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "schema 不是对象" };
  }
  const obj = raw as Record<string, unknown>;
  const kind = obj.kind;

  if (kind === "items") {
    const fields = asFields(obj.fields);
    if (!fields) return { ok: false, error: "items schema 的 fields 必须是非空 {字段: string|number|boolean}" };
    const required = Array.isArray(obj.required)
      ? obj.required.filter((name): name is string => typeof name === "string" && name in fields)
      : [];
    const titleField = typeof obj.titleField === "string" && obj.titleField in fields ? obj.titleField : undefined;
    return { ok: true, schema: { kind: "items", fields, required, titleField } };
  }

  if (kind === "table") {
    const columns = Array.isArray(obj.columns)
      ? obj.columns.filter((name): name is string => typeof name === "string" && name.trim().length > 0)
      : [];
    if (columns.length === 0) return { ok: false, error: "table schema 的 columns 不能为空" };
    if (columns.length > MAX_COLUMNS) return { ok: false, error: `table schema 的列数超过 ${MAX_COLUMNS}` };
    return { ok: true, schema: { kind: "table", columns } };
  }

  return { ok: false, error: `未知的 schema.kind：${String(kind)}` };
}

export type DataValidation = { ok: true } | { ok: false; errors: string[] };

/** 校验一份待写入的数据文件是否满足契约。错误信息要能直接展示给人看。 */
export function validateData(schema: DataSchema, data: unknown): DataValidation {
  const errors: string[] = [];
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, errors: ["数据必须是对象"] };
  }
  const obj = data as Record<string, unknown>;

  if (schema.kind === "table") {
    const columns = obj.columns;
    if (!Array.isArray(columns) || columns.some((name) => typeof name !== "string")) {
      errors.push("columns 必须是字符串数组");
    } else if (columns.join("\u0000") !== schema.columns.join("\u0000")) {
      errors.push(`columns 必须与契约一致：${schema.columns.join(" / ")}`);
    }
    const rows = obj.rows;
    if (!Array.isArray(rows)) {
      errors.push("rows 必须是数组");
    } else if (rows.length > MAX_ROWS) {
      errors.push(`rows 超过 ${MAX_ROWS} 行`);
    } else {
      rows.forEach((row, index) => {
        if (!Array.isArray(row)) {
          errors.push(`第 ${index + 1} 行不是数组`);
          return;
        }
        if (schema.columns.length > 0 && row.length !== schema.columns.length) {
          errors.push(`第 ${index + 1} 行有 ${row.length} 格，契约要求 ${schema.columns.length} 格`);
          return;
        }
        row.forEach((cell, cellIndex) => {
          if (typeof cell !== "string" && typeof cell !== "number") {
            errors.push(`第 ${index + 1} 行第 ${cellIndex + 1} 格必须是字符串或数字`);
          } else if (String(cell).length > MAX_TEXT) {
            errors.push(`第 ${index + 1} 行第 ${cellIndex + 1} 格超过 ${MAX_TEXT} 字`);
          }
        });
      });
    }
    return errors.length > 0 ? { ok: false, errors: errors.slice(0, 8) } : { ok: true };
  }

  const items = obj.items;
  if (!Array.isArray(items)) return { ok: false, errors: ["items 必须是数组"] };
  if (items.length > MAX_ITEMS) return { ok: false, errors: [`items 超过 ${MAX_ITEMS} 条`] };

  items.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      errors.push(`第 ${index + 1} 条不是对象`);
      return;
    }
    const item = entry as Record<string, unknown>;
    for (const key of Object.keys(item)) {
      if (!(key in schema.fields)) errors.push(`第 ${index + 1} 条含未声明的字段：${key}`);
    }
    for (const key of schema.required) {
      const value = item[key];
      if (value === undefined || value === null || value === "") errors.push(`第 ${index + 1} 条缺必填字段：${key}`);
    }
    for (const [key, type] of Object.entries(schema.fields)) {
      const value = item[key];
      if (value === undefined || value === null) continue;
      if (typeof value !== type) errors.push(`第 ${index + 1} 条的 ${key} 应为 ${type}`);
      else if (typeof value === "string" && value.length > MAX_TEXT) {
        errors.push(`第 ${index + 1} 条的 ${key} 超过 ${MAX_TEXT} 字`);
      }
    }
  });

  return errors.length > 0 ? { ok: false, errors: errors.slice(0, 8) } : { ok: true };
}

/** 空数据（新建文件时给界面一个可写的起点）。 */
export function emptyData(schema: DataSchema): Record<string, unknown> {
  return schema.kind === "table" ? { columns: [...schema.columns], rows: [] } : { items: [] };
}
