const MAX_PROGRESS_LENGTH = 500;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 去掉终端控制字符（CSI / OSC / 单字符转义）与孤立的回车。
 *
 * 工具卡里我们不做 ANSI 着色，所以保留转义序列只会显示成 `[31m` 这样的噪声；
 * 孤立的 \r 则会让「取最后一行」拿到被进度条覆盖一半的内容。
 */
const ANSI_ESCAPE_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;

export function stripControlSequences(text: string): string {
  return text
    .replace(ANSI_ESCAPE_RE, "")
    .replace(/\r(?!\n)/g, "\n")
    // 除 \t \n 之外的 C0 控制字符
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

/**
 * 文本是否像「解码失败的乱码」。
 *
 * U+FFFD 是解码器遇到非法字节时的替换符（Windows 中文系统下 GBK 输出被按 UTF-8 读
 * 就会产生），拿它当一行摘要显示毫无意义，不如退回只显示工具名。
 *
 * 根治手段在 lib/project-command-env（给子进程注入 PYTHONIOENCODING=utf-8 等），
 * 这里只是兵很防范：用户可能在设置里自定义 shell，或跑出其他编码的程序。
 */
export function looksLikeMojibake(text: string): boolean {
  const replacementCount = (text.match(/\uFFFD/g) ?? []).length;
  if (replacementCount === 0) return false;
  // 单个替换符可能是正文里本来就有的字符；按比例判定更稳
  return replacementCount / Math.max(1, text.length) > 0.05 || replacementCount >= 3;
}

/** 取工具部分输出的最后一行作为进度摘要；乱码或全控制字符时返回 null */
export function getToolExecutionProgress(partialResult: unknown): string | null {
  if (!isObject(partialResult)) return null;

  const content = partialResult.content;
  if (!Array.isArray(content)) return null;

  const text = content
    .filter((block) => isObject(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
  if (!text) return null;

  const cleaned = stripControlSequences(text);
  const lines = cleaned.split(/\r?\n/);
  let latest = "";
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    latest = lines[index].trim();
    if (latest) break;
  }
  if (!latest) return null;

  const normalized = latest.replace(/\s+/g, " ");
  if (looksLikeMojibake(normalized)) return null;
  return normalized.length <= MAX_PROGRESS_LENGTH
    ? normalized
    : `...${normalized.slice(-(MAX_PROGRESS_LENGTH - 3))}`;
}
