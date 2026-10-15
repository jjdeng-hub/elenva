/**
 * 技能草稿 —— 网页侧（保存接口 + 草稿卡）用的纯函数层。
 *
 * 三件事：
 * 1. **校验**：直接复用扩展里的零依赖纯模块（同一套规则，见 `extensions/elenva-skills/draft.ts`）；
 * 2. **拼装**：把 `{name, description, body}` 拼成 SKILL.md（frontmatter + 正文），
 *    格式对齐现有技能库（`~/.pi/agent/skills/<name>/SKILL.md`：裸标量 frontmatter、`---` 后空一行）；
 * 3. **路径**：技能库根目录 → `<root>/<name>/SKILL.md`。
 *
 * 所有函数都不碰文件系统（写盘在 `app/api/skills/draft/save/route.ts`），
 * 便于 `tools/skill-drafts-selftest.mjs` 直接跑。
 */
import { join } from "node:path";
import {
  isValidSkillDraftName,
  SKILL_DRAFT_NAME_MAX,
  SKILL_DRAFT_NAME_RE,
  validateSkillDraft,
  type SkillDraft,
  type SkillDraftInput,
  type SkillDraftValidation,
} from "@/extensions/elenva-skills/draft";

export {
  isValidSkillDraftName,
  SKILL_DRAFT_NAME_MAX,
  SKILL_DRAFT_NAME_RE,
  validateSkillDraft,
};
export type { SkillDraft, SkillDraftInput, SkillDraftValidation };

/** 技能目录：`<skillsRoot>/<name>` */
export function skillDraftDir(skillsRoot: string, name: string): string {
  return join(skillsRoot, name);
}

/** 技能文件：`<skillsRoot>/<name>/SKILL.md` */
export function skillDraftPath(skillsRoot: string, name: string): string {
  return join(skillDraftDir(skillsRoot, name), "SKILL.md");
}

/**
 * 重名判定：技能目录或 SKILL.md 任一已存在，就认为重名（目录在 = 已有一个同名技能，
 * 可能带附属文件，不能动）。existst 以参数注入，便于纯函数自测。
 */
export function isSkillDraftTaken(
  exists: (path: string) => boolean,
  skillsRoot: string,
  name: string,
): boolean {
  return exists(skillDraftDir(skillsRoot, name)) || exists(skillDraftPath(skillsRoot, name));
}

/** YAML 里不能作为裸标量开头的字符（`-` 只在开头有歧义，正文里的连字符不受影响） */
const YAML_UNSAFE_START = /^[-?:,[\]{}#&*!|>'"%@`]/;

/**
 * 把一段文本安全地放进 YAML 标量位。
 *
 * 现有 SKILL.md 的 `name` / `description` 都是裸写法（不加引号），保持同样的观感；
 * 只有当裸写法会被 YAML 解析器读歪时才退到双引号（`JSON.stringify` 的转义对 YAML 双引号串同样合法）。
 * 触发条件：空串、首尾空白、换行、`冒号+空白`、`空白+#`、以 YAML 指示符开头。
 */
export function yamlScalar(value: string): string {
  if (value === "") return '""';
  if (value !== value.trim()) return JSON.stringify(value);
  if (/[\n\r]/.test(value)) return JSON.stringify(value);
  if (/:[ \t]/.test(value) || /:\s*$/.test(value)) return JSON.stringify(value);
  if (/\s#/.test(value)) return JSON.stringify(value);
  if (YAML_UNSAFE_START.test(value)) return JSON.stringify(value);
  return value;
}

/**
 * 拼装 SKILL.md 全文。
 *
 * 形态与现有技能一致：
 * ```
 * ---
 * name: <name>
 * description: <description>
 * ---
 *
 * <body>
 * ```
 * 正文统一成 LF、去首尾空白，并保证以单个换行结尾（编辑器与 diff 友好）。
 */
export function buildSkillMarkdown(draft: SkillDraft): string {
  const body = draft.body.replace(/\r\n/g, "\n").trim();
  return [
    "---",
    `name: ${yamlScalar(draft.name)}`,
    `description: ${yamlScalar(draft.description)}`,
    "---",
    "",
    body,
    "",
  ].join("\n");
}

/**
 * 从工具入参（`block.input`）里读出草稿，供草稿卡渲染。
 *
 * 这里**只要求三个字段是非空字符串**（宽松），不套 `name` 的正则 ——
 * 模型偶尔会给出不合规的名字，那种情况应当把草稿照常显示出来、在卡上标出
 * 校验错误并禁用保存，而不是整张卡空白。保存接口一侧仍走严格校验。
 */
export function readSkillDraft(input: unknown): SkillDraft | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  const body = typeof record.body === "string" ? record.body.trim() : "";
  if (!name || !description || !body) return null;
  return { name, description, body };
}
