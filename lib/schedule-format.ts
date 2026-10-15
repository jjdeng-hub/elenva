/**
 * 节律纯函数层（模块 3 · 第 5 轮）—— **客户端可安全导入**。
 *
 * 为什么单独一层：`lib/schedules.ts` 带 `node:fs` 与内核依赖，进不了浏览器包；
 * 而「这条规则用中文怎么说」与「cron 写得对不对」前端也要用（列表副标题、
 * 表单实时校验）。把它们放这里（零 node / 零内核依赖），再由 schedules.ts re-export，
 * 对外仍从 `@/lib/schedules` 取，既有行为不变。
 *
 * 约束：本文件禁止 import 任何 `node:*` / `@earendil-works/*`。
 */

// ============================================================================
// 触发规则
// ============================================================================

export type Schedule =
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; at: string }
  | { kind: "weekly"; weekday: number; at: string }
  | { kind: "cron"; expr: string };

export interface CronSpec {
  minutes: Set<number>;
  hours: Set<number>;
  doms: Set<number>;
  months: Set<number>;
  dows: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

// ============================================================================
// cron 解析（单一来源：前端实时校验与后端 validateSchedule 共用）
// ============================================================================

function parseField(raw: string, min: number, max: number, label: string): { values: Set<number>; restricted: boolean } {
  const text = raw.trim();
  if (!text) throw new Error(`cron 的${label}字段不能为空`);
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const piece = part.trim();
    if (!piece) throw new Error(`cron 的${label}字段有空项`);
    const slash = piece.indexOf("/");
    const rangeText = slash >= 0 ? piece.slice(0, slash) : piece;
    let step = 1;
    if (slash >= 0) {
      const stepText = piece.slice(slash + 1);
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) {
        throw new Error(`cron 的${label}字段步长不合法：${piece}`);
      }
      step = Number(stepText);
    }
    let start: number;
    let end: number;
    if (rangeText === "*") {
      start = min;
      end = max;
    } else if (/^\d+$/.test(rangeText)) {
      start = Number(rangeText);
      // `N/step` 与 cron 惯例一致：从 N 起、到上界为止
      end = slash >= 0 ? max : start;
    } else {
      const range = /^(\d+)-(\d+)$/.exec(rangeText);
      if (!range) throw new Error(`cron 的${label}字段不合法：${piece}`);
      start = Number(range[1]);
      end = Number(range[2]);
    }
    if (start < min || end > max || start > end) {
      throw new Error(`cron 的${label}字段超出范围（${min}-${max}）：${piece}`);
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  if (values.size === 0) throw new Error(`cron 的${label}字段没有有效取值`);
  return { values, restricted: text !== "*" };
}

/**
 * 解析 5 字段 cron：`分 时 日 月 周`。支持 `*`、`N`、星号加 `/n` 步长（含 `N-M/s`）、
 * `N-M`、逗号列表。**不支持**名称 / 宏等非标扩展（`@daily`、`JAN`、`MON`）——
 * 要日/周语义请直接用 daily / weekly 形态。
 */
export function parseCronExpr(expr: string): CronSpec {
  if (typeof expr !== "string") throw new Error("cron 表达式必须是字符串");
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron 需要 5 个字段（分 时 日 月 周），收到 ${fields.length} 个`);
  }
  const [minute, hour, dom, month, dow] = fields;
  const minutes = parseField(minute, 0, 59, "分");
  const hours = parseField(hour, 0, 23, "时");
  const doms = parseField(dom, 1, 31, "日");
  const months = parseField(month, 1, 12, "月");
  // 周字段：0=周日（同时接受 7=周日这一常见写法）
  const dowRaw = parseField(dow.replace(/\b7\b/g, "0"), 0, 6, "周");
  return {
    minutes: minutes.values,
    hours: hours.values,
    doms: doms.values,
    months: months.values,
    dows: dowRaw.values,
    domRestricted: doms.restricted,
    dowRestricted: dowRaw.restricted,
  };
}

/** cron 表达式校验：合法返回 null，非法返回中文原因（供表单实时反馈）。 */
export function cronExprError(expr: string): string | null {
  try {
    parseCronExpr(expr);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// ============================================================================
// 人话描述
// ============================================================================

/** 0=周日 … 6=周六（与 cron / Date.getDay() 一致） */
export const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

/** `9:5` / `09:05` → `09:05`；解析不出来就原样返回（描述函数不抛错）。 */
function formatAt(at: unknown): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(typeof at === "string" ? at.trim() : "");
  if (!match) return String(at ?? "");
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

/**
 * 把触发规则说成人话（列表副标题、表单预览共用）。
 * 例：`每小时（第 15 分）` / `每天 08:30` / `每周一 09:00` / `cron：0 8 * * *`。
 * 入参可能来自接口 / 旧数据，非法时不抛错，返回兜底文案。
 */
export function describeSchedule(schedule: Schedule | null | undefined): string {
  if (!schedule || typeof schedule !== "object") return "未设置";
  switch (schedule.kind) {
    case "hourly":
      return `每小时（第 ${schedule.minute} 分）`;
    case "daily":
      return `每天 ${formatAt(schedule.at)}`;
    case "weekly": {
      const name = WEEKDAY_NAMES[schedule.weekday];
      return `${name ? `每${name}` : `每周${schedule.weekday}`} ${formatAt(schedule.at)}`;
    }
    case "cron":
      return `cron：${String(schedule.expr ?? "").trim() || "（空）"}`;
    default:
      return "未知规则";
  }
}
