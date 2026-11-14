/**
 * 正文文档的元信息（纯函数，无 node:* 依赖）。
 *
 * 「当前这一篇」在界面上要有标题、字数、阶段段落数、待补缺口 —— 这些都能从 Markdown
 * 本身推出来，不需要让 Agent 额外维护一份状态文件（多一份状态就多一处会不一致）。
 *
 * 约定（与 content 应用包的写作习惯一致）：
 * - 一级标题 `# ` 是篇名；
 * - `## ` 是段标题、`### ` 是小节；
 * - 待补只认 `【待你补：…】` / `【待你定：…】` 两种标记，与 prompt 里用的写法同源。
 */

export interface DocSection {
  level: number;
  title: string;
}

export interface DocMeta {
  title: string;
  /** 字数：去掉 Markdown 语法与空白后的字符数（中文按字，英文按字母，与公众号编辑器口径接近） */
  words: number;
  sections: DocSection[];
  /** 待你补 / 待你定的条目（去掉标记本身） */
  gaps: string[];
}

const GAP_RE = /【待[你我]{1,2}(?:补|定|确认)：([^】]{1,200})】/g;

/** 去掉常见 Markdown 语法，只留可读文字（用于字数与摘要）。 */
export function stripMarkdown(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "")
    .replace(/^\s{0,3}\d+\.\s+/gm, "")
    .replace(/(\*\*|__|\*|_|~~)/g, "")
    .replace(/^\s*[-*_]{3,}\s*$/gm, " ");
}

export function countWords(markdown: string): number {
  return stripMarkdown(markdown).replace(/\s+/g, "").length;
}

export function extractTitle(markdown: string): string {
  const heading = /^\s{0,3}#\s+(.+)$/m.exec(markdown);
  if (heading) return heading[1].trim();
  const firstLine = markdown.split("\n").map((line) => line.trim()).find((line) => line.length > 0);
  return firstLine ? stripMarkdown(firstLine).trim().slice(0, 60) : "";
}

export function extractSections(markdown: string): DocSection[] {
  const sections: DocSection[] = [];
  for (const line of markdown.split("\n")) {
    const m = /^\s{0,3}(#{2,3})\s+(.+)$/.exec(line);
    if (m) sections.push({ level: m[1].length, title: m[2].trim() });
  }
  return sections;
}

export function extractGaps(markdown: string): string[] {
  const seen = new Set<string>();
  const gaps: string[] = [];
  for (const match of markdown.matchAll(GAP_RE)) {
    const text = match[1].trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    gaps.push(text);
    if (gaps.length >= 8) break;
  }
  return gaps;
}

export function docMeta(markdown: string): DocMeta {
  return {
    title: extractTitle(markdown),
    words: countWords(markdown),
    sections: extractSections(markdown),
    gaps: extractGaps(markdown),
  };
}

/** 字数目标达成度（界面上的「1,240 / 1,400」）。目标缺省时返回 null。 */
export function wordProgress(words: number, target?: number): { words: number; target: number; ratio: number } | null {
  if (!target || target <= 0) return null;
  return { words, target, ratio: Math.min(1.5, words / target) };
}
