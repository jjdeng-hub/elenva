/**
 * 行级 diff —— 工具卡「改动」区的兜底实现。
 *
 * 首选数据源是内核 edit 结果里的 `details.diff`（pi 的 edit-diff 模块生成的展示
 * diff：带行号、上下文裁剪、模糊匹配后的真实结果），由 MessageView 直接解析。
 * 这里负责两类兜底：
 *  1. 运行中（还没有 result）—— 用 input.edits 预览将要改什么；
 *  2. 非内核的 edit 变体（MCP 等）—— 只有 old/new 文本对，没有 details。
 */

export type DiffLine = { kind: "add" | "del" | "ctx"; text: string };
export type ParsedDiffLine = { kind: "add" | "del" | "ctx" | "gap"; num?: number; text: string };

/** 解析内核展示 diff 的行格式：`+12 line` / `-12 line` / ` 12 line` / `  ...`（上下文折叠标记） */
export function parseSdkDiff(diff: string): ParsedDiffLine[] {
  const out: ParsedDiffLine[] = [];
  for (const line of diff.split("\n")) {
    if (line === "") continue;
    if (line.startsWith("+")) {
      const match = /^\+\s*(\d+) (.*)$/.exec(line);
      out.push(match ? { kind: "add", num: Number(match[1]), text: match[2] } : { kind: "add", text: line.slice(1) });
      continue;
    }
    if (line.startsWith("-")) {
      const match = /^-\s*(\d+) (.*)$/.exec(line);
      out.push(match ? { kind: "del", num: Number(match[1]), text: match[2] } : { kind: "del", text: line.slice(1) });
      continue;
    }
    if (/^ +\s*\.\.\.$/.test(line)) {
      out.push({ kind: "gap", text: "…" });
      continue;
    }
    const match = /^ (\s*\d+) (.*)$/.exec(line);
    out.push(match ? { kind: "ctx", num: Number(match[1]), text: match[2] } : { kind: "ctx", text: line.slice(1) });
  }
  return out;
}

/**
 * 简单行级 diff：公共前后缀裁剪 + 中段 LCS。
 * 中段超过 ~250k 单元时退化为「整块删 + 整块增」，避免大文件编辑卡住主线程。
 */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const newLines = newText.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");

  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  const midOld = oldLines.slice(start, oldEnd);
  const midNew = newLines.slice(start, newEnd);
  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ kind: "ctx", text: oldLines[i] });

  if (midOld.length * midNew.length > 250_000) {
    for (const text of midOld) out.push({ kind: "del", text });
    for (const text of midNew) out.push({ kind: "add", text });
  } else {
    const rows = midOld.length;
    const cols = midNew.length;
    const width = cols + 1;
    const dp = new Uint32Array((rows + 1) * width);
    for (let i = rows - 1; i >= 0; i--) {
      for (let j = cols - 1; j >= 0; j--) {
        dp[i * width + j] = midOld[i] === midNew[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < rows && j < cols) {
      if (midOld[i] === midNew[j]) {
        out.push({ kind: "ctx", text: midOld[i] });
        i++;
        j++;
      } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
        out.push({ kind: "del", text: midOld[i] });
        i++;
      } else {
        out.push({ kind: "add", text: midNew[j] });
        j++;
      }
    }
    while (i < rows) out.push({ kind: "del", text: midOld[i++] });
    while (j < cols) out.push({ kind: "add", text: midNew[j++] });
  }

  for (let i = oldEnd; i < oldLines.length; i++) out.push({ kind: "ctx", text: oldLines[i] });
  return out;
}
