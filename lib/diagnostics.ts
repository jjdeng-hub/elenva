/**
 * 诊断输出（可观测性用）。
 *
 * 依据《深入理解 AI Agent》ch5 L189（每个长连接都需要活性信号）、ch5 L195
 * （所有自动手段用尽后才暴露错误，并附上已尝试过的恢复动作）。
 *
 * 设计口径：
 * - **失败必输出**：diagError / diagWarn 无条件打印，供「连不上 / 没反应」时定位。
 * - **成功保持简洁**：过程性追踪走 diagTrace，默认关闭，`ELENVA_DIAG=1` 时才打印。
 * - **不泄露凭据**：字段名命中敏感词一律替换成 `***`（auth.json 里的 API key
 *   曾经因为排查被原样打进终端）。
 * - 这个模块**必须能在浏览器里 import**（前端也要拼同款错误描述），
 *   所以只依赖 console 与纯 JS 能力，不引入任何 node: 模块。
 */

/** 字段值最长保留字符数——够定位问题，又不至于把整坨 payload 打进日志 */
const MAX_FIELD_LENGTH = 300;
/** describeError 最多展开几层 cause 链 */
const MAX_CAUSE_DEPTH = 3;

const SENSITIVE_KEY = /(key|token|secret|password|passwd|authorization|credential|cookie|apikey)/i;

function truncate(value: string, max = MAX_FIELD_LENGTH): string {
  return value.length <= max ? value : `${value.slice(0, max)}…(+${value.length - max})`;
}

/** 本地时间戳（带时区偏移）——原来的日志行没有时间戳，出问题时只能靠文件 mtime 猜 */
export function formatTimestamp(now: Date = new Date()): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absOffset = Math.abs(offsetMinutes);
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    + `.${pad(now.getMilliseconds(), 3)}`
    + `${sign}${pad(Math.floor(absOffset / 60))}:${pad(absOffset % 60)}`
  );
}

/** 单个字段值 → 可打印字符串（对象走 JSON，敏感键脱敏） */
export function formatFieldValue(key: string, value: unknown): string {
  if (SENSITIVE_KEY.test(key)) {
    return typeof value === "string" && value.length > 0
      ? `***(${value.length}字符)`
      : "***";
  }
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return truncate(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value instanceof Error) return describeError(value);
  if (typeof value === "object") {
    // 嵌套对象也过一遍敏感键（排查时很容易顺手把整个 config / 请求头丢进来）
    return truncate(stringifyRedacted(value));
  }
  try {
    return truncate(String(value));
  } catch {
    return truncate(Object.prototype.toString.call(value));
  }
}

/** JSON 序列化，但逐层把敏感键替换掉 */
function stringifyRedacted(value: unknown): string {
  return JSON.stringify(value, (key, nested) => (SENSITIVE_KEY.test(key) ? "***" : nested)) ?? String(value);
}

/** 把任意错误描述成一行可定位的文本：类型 + 消息 + 常见的 code/status/cause */
export function describeError(error: unknown, depth = 0): string {
  if (error === undefined || error === null) return "无错误对象";
  if (!(error instanceof Error)) {
    if (typeof error === "string") return truncate(error);
    return truncate(formatFieldValue("value", error));
  }

  const parts: string[] = [];
  const name = error.name || "Error";
  parts.push(error.message ? `${name}: ${truncate(error.message)}` : name);

  // HTTP / 网关类错误常见的附加字段：状态码是排查时最有用的一项
  const extra = error as Error & {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    errno?: unknown;
  };
  for (const key of ["code", "status", "statusCode", "errno"] as const) {
    const value = extra[key];
    if (value !== undefined && value !== null && typeof value !== "object") {
      parts.push(`${key}=${String(value)}`);
    }
  }

  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause !== undefined && depth < MAX_CAUSE_DEPTH) {
    parts.push(`cause(${depth + 1})=${describeError(cause, depth + 1)}`);
  }
  return parts.join(" | ");
}

export type DiagnosticFields = Record<string, unknown>;

/** 组装一行诊断文本（纯函数，便于自检） */
export function formatDiagnosticLine(options: {
  scope: string;
  message: string;
  fields?: DiagnosticFields;
  error?: unknown;
  now?: Date;
}): string {
  const parts = [`[elenva][${formatTimestamp(options.now)}][${options.scope}] ${options.message}`];
  for (const [key, value] of Object.entries(options.fields ?? {})) {
    parts.push(`${key}=${formatFieldValue(key, value)}`);
  }
  if (options.error !== undefined) parts.push(`error=${describeError(options.error)}`);
  return parts.join(" · ");
}

function emit(level: "error" | "warn" | "info", line: string): void {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

/** 失败路径：无条件输出 */
export function diagError(
  scope: string,
  message: string,
  fields?: DiagnosticFields,
  error?: unknown,
): void {
  emit("error", formatDiagnosticLine({ scope, message, fields, error }));
}

/** 可疑但不算失败：无条件输出（用于「等待过久 / 重连中」这类要用户看见的信号） */
export function diagWarn(
  scope: string,
  message: string,
  fields?: DiagnosticFields,
  error?: unknown,
): void {
  emit("warn", formatDiagnosticLine({ scope, message, fields, error }));
}

/** 是否开启过程追踪（`ELENVA_DIAG=1`）。默认关，避免正常流程刷屏。
 * 本模块会被前端 import（复用 describeError），浏览器里没有 process —— 必须判空。 */
export function diagTraceEnabled(): boolean {
  if (typeof process === "undefined") return false;
  const value = process.env?.ELENVA_DIAG;
  return value === "1" || value === "true";
}

/** 过程追踪：仅 ELENVA_DIAG=1 时输出，用来回答「到底卡在哪一步」 */
export function diagTrace(
  scope: string,
  message: string,
  fields?: DiagnosticFields,
  error?: unknown,
): void {
  if (!diagTraceEnabled()) return;
  emit("info", formatDiagnosticLine({ scope, message, fields, error }));
}
