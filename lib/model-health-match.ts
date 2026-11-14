/**
 * 健康数据 ↔ 模型库行 的匹配与行内故障标（2026-10-19 · 模型页变体 C）。
 *
 * 为什么需要单独一层：两侧 id 的真实来源不同，天然会漂。
 *
 *   健康侧（`lib/model-health.ts`）：扫 `~/.pi/agent/sessions`，键取**会话文件里 assistant 消息
 *     的 provider / model** —— 那是内核当年真正发出去、厂商回来的取值，历史会话会留着
 *     已改名 / 已下线 / 别名的 id。
 *   模型库侧（`lib/models-loader.ts` → `allModelList`）：键取**模型注册表里的 provider / id**
 *     （厂商目录 + models.json + 本机 models-store 缓存），同一版面里还会同时出现
 *     `deepseek/deepseek-flash` 与 `opencode-go/deepseek-v4-flash` 这种「名字像、其实两个模型」。
 *
 * 实测过的坑（编排侧 2026-10-19 本机取证）：健康区报 `deepseek/deepseek-flash`，而模型库里
 * `deepseek-v4-flash` 属于 opencode-go；任何「按 id 相似度 / 按模型名猜」的匹配都会把
 * 故障标到隔壁那个模型上——那比不标更坏（用户会去换一个没坏的模型）。
 *
 * 因此这里只允许两级匹配，且都要求 **同 provider**：
 *   1) `${provider}/${id}` 精确命中；
 *   2) 整串大小写不敏感、且**唯一**命中（id 大小写在不同来源可能不一致；多条命中视为有歧义）。
 * 都到不了就返回 undefined —— **宁可漏标，也不错标**。
 *
 * 本文件是纯函数、无 node 依赖，客户端组件与 node 自测共用同一实现
 * （自测：`tools/model-page-selftest.mjs`）。
 */

export type ModelHealthState = "ok" | "unstable" | "failing";

/** 健康侧一条记录里、模型行用得上的字段（结构子集：两侧解耦，不 import 服务端模块）。 */
export interface ModelHealthEntryLike {
  status: ModelHealthState;
  calls: number;
  failures: number;
  /** failures 中被自动重试接管的次数（服务端可选给出） */
  recoveredFailures?: number;
  successRate: number;
  lastFailureAt?: string | null;
  lastError?: string | null;
}

/** 唯一的键规则：`provider/modelId`（两侧都用它，别再各写一遍拼接）。 */
export function modelHealthKey(provider: string, modelId: string): string {
  return `${provider.trim()}/${modelId.trim()}`;
}

/**
 * 从健康索引里取「这个模型行」的记录。取不到 = 不标（见文件头：宁可漏标）。
 * 空的 provider / id 一律视为取不到——`"/"` 这种键不能和任何真实模型撞上。
 */
export function lookupModelHealth<T extends ModelHealthEntryLike>(
  index: Record<string, T> | undefined,
  provider: string,
  modelId: string,
): T | undefined {
  if (!index) return undefined;
  const p = provider.trim();
  const m = modelId.trim();
  if (!p || !m) return undefined;
  const key = modelHealthKey(p, m);
  const exact = index[key];
  if (exact) return exact;
  const folded = key.toLowerCase();
  let hit: T | undefined;
  for (const [k, v] of Object.entries(index)) {
    if (k.toLowerCase() !== folded) continue;
    if (hit) return undefined; // 大小写不敏感后有多条 → 有歧义，不标
    hit = v;
  }
  return hit;
}

/** 行内故障标的长度上限（再长就挤掉模型名，明细放 title / 展开面板）。 */
export const FAILING_BADGE_MAX = 48;
const ERROR_SUMMARY_MAX = 32;

/** 调用数那一小段：全失败说全失败，部分失败给比例。 */
export function failingCallText(entry: Pick<ModelHealthEntryLike, "calls" | "failures">): string {
  const calls = Number.isFinite(entry.calls) ? Math.max(0, entry.calls) : 0;
  const failures = Number.isFinite(entry.failures) ? Math.max(0, entry.failures) : 0;
  if (calls > 0 && failures >= calls) return `${calls} 次调用全失败`;
  return `失败 ${failures}/${calls} 次`;
}

/**
 * 把会话里记下的错误原文压成一段短摘要，给行内故障标用。
 *
 * 实测原文有三种形态（本机 session 取证）：
 *   `400: {"type":"server_error","message":"Upstream request failed: Model is unavailable."}`
 *   `opencode-go API error (502): {"type":"server_error",...}`
 *   `Request timed out.` / `Streaming response failed: [rate_limit_error] upstream model is overloaded`
 * 取 `HTTP 码 + 人能读的那半句`；**不做中文改写**（翻译错误信息等于编数据），原文留在 title。
 */
export function summarizeModelError(raw: string | null | undefined, max = ERROR_SUMMARY_MAX): string {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const codeMatch = text.match(/(?:^|\()\s*(\d{3})\s*(?::|\))/);
  const code = codeMatch ? codeMatch[1] : "";
  const braceAt = text.indexOf("{");
  let message = text;
  if (braceAt >= 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.slice(braceAt));
    } catch {
      parsed = undefined;
    }
    const inner =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as { message?: unknown }).message
        : undefined;
    if (typeof inner === "string" && inner.trim()) {
      message = inner;
    } else {
      // JSON 里没有 message：别把「厂商名 + API error (502)」这种前缀当正文（码已经在上面取到了）
      const head = text.slice(0, braceAt);
      message = code && head.includes(code) ? "" : head;
    }
  }
  message = message
    .replace(/\(request_id:[^)]*\)/gi, " ")
    .replace(/^[\s:：,，-]+|[\s:：,，.-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // 「Upstream request failed: Model is unavailable」这类前缀是噪声，取最后一段
  const lastSegment = message.split(/[:：]\s*/).pop()?.trim();
  if (lastSegment) message = lastSegment;
  if (!message) return code;  const short = message.length > max ? `${message.slice(0, max)}…` : message;
  return code ? `${code} ${short}` : short;
}

/** 模型行右侧那颗标：`有故障 · 4 次调用全失败 · 400 Model is unavailable`。 */
export function failingBadgeText(
  entry: Pick<ModelHealthEntryLike, "calls" | "failures" | "lastError">,
  max = FAILING_BADGE_MAX,
): string {
  const head = `有故障 · ${failingCallText(entry)}`;
  const detail = summarizeModelError(entry.lastError);
  const text = detail ? `${head} · ${detail}` : head;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
