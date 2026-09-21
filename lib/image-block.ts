/**
 * 图片内容块 —— 单点取数工具（全项目唯一的形态入口）。
 *
 * 形态约定（2026-09-21 统一，分支 fix/image-shape）：
 *   · 规范形态 = SDK / 磁盘上的平铺形态：`{ type: "image", data, mimeType }`；
 *   · 客户端专有扩展：`url`（tool-result 懒加载图，仅内存，不写盘）；
 *   · legacy `{ source: { type, data, media_type, url } }` 只可能出现在旧数据里，
 *     这里仅作读取兜底 —— **任何写入路径都不得再产出 legacy**。
 *
 * 背景：曾因「声明 legacy、磁盘平铺」的漂移导致上传图刷新后渲染空图、编辑丢图
 * （见 tools/pi-surface-check.ts 第④段的记录）。渲染与编辑路径统一走
 * `imageBlockSrc` / `imageData`，新读取点不要再手写形态分支。
 */

function asRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 取图片块的内联 base64 数据；没有内联数据（例如只有 url 的懒加载块）时返回 null。 */
export function imageData(block: unknown): { data: string; mimeType: string } | null {
  if (!asRecord(block) || block.type !== "image") return null;

  if (typeof block.data === "string" && block.data.length > 0) {
    return {
      data: block.data,
      mimeType: typeof block.mimeType === "string" && block.mimeType ? block.mimeType : "image/png",
    };
  }

  const legacy = asRecord(block.source) ? block.source : null;
  if (legacy && legacy.type === "base64" && typeof legacy.data === "string" && legacy.data.length > 0) {
    return {
      data: legacy.data,
      mimeType: typeof legacy.media_type === "string" && legacy.media_type ? legacy.media_type : "image/png",
    };
  }

  return null;
}

/** 渲染用 src：优先懒加载 url，其次内联 base64，最后 legacy url；都无法解析时返回空串。 */
export function imageBlockSrc(block: unknown): string {
  if (!asRecord(block) || block.type !== "image") return "";

  if (typeof block.url === "string" && block.url.length > 0) return block.url;

  const inline = imageData(block);
  if (inline) return `data:${inline.mimeType};base64,${inline.data}`;

  const legacy = asRecord(block.source) ? block.source : null;
  if (legacy && legacy.type === "url" && typeof legacy.url === "string" && legacy.url.length > 0) {
    return legacy.url;
  }

  return "";
}
