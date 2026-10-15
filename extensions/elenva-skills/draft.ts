/**
 * `skill_draft` 的纯校验层 —— 不碰文件系统、不依赖 pi 内核。
 *
 * 为什么单独一个文件：扩展会被 `install.mjs` 复制到 `<agentRoot>/extensions/elenva-skills/`，
 * 离开仓库后 import 不到 `@/lib/*`；而网页侧的保存接口 `lib/skill-drafts.ts` 需要同一套校验，
 * 于是把校验做成**零依赖纯模块**，网页侧按仓库先例（`@/extensions/elenva-todo/state`）直接复用，
 * 避免两处规则各写一遍后慢慢漂移。
 */

/** 技能名长度上限（与技能库目录名、SDK 加载器的实际使用一致） */
export const SKILL_DRAFT_NAME_MAX = 64;

/**
 * 技能名形态：小写字母 / 数字 / 连字符，且以字母数字开头结尾、不出现连续连字符。
 * 这条比「只允许这三类字符」更严一点，是为了挡住 `-x` / `x-` / `a--b` 这类
 * 在目录名与技能引用里都容易出问题的写法。
 */
export const SKILL_DRAFT_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface SkillDraft {
  name: string;
  description: string;
  body: string;
}

/** 工具入参 / 接口请求体的原始形态（校验前未知类型） */
export interface SkillDraftInput {
  name?: unknown;
  description?: unknown;
  body?: unknown;
}

export type SkillDraftValidation =
  | { ok: true; draft: SkillDraft }
  | { ok: false; error: string };

export function isValidSkillDraftName(value: unknown): value is string {
  return (
    typeof value === "string"
    && value.length > 0
    && value.length <= SKILL_DRAFT_NAME_MAX
    && SKILL_DRAFT_NAME_RE.test(value)
  );
}

/** 校验并归一（trim）一份草稿；失败时给出面向人的中文原因。 */
export function validateSkillDraft(input: SkillDraftInput): SkillDraftValidation {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const description = typeof input.description === "string" ? input.description.trim() : "";
  const body = typeof input.body === "string" ? input.body.trim() : "";

  if (!isValidSkillDraftName(name)) {
    return {
      ok: false,
      error: `name 不合法：需为小写字母 / 数字 / 连字符，以字母数字开头结尾，长度 ≤ ${SKILL_DRAFT_NAME_MAX}`,
    };
  }
  if (!description) return { ok: false, error: "description 不能为空" };
  if (!body) return { ok: false, error: "body 不能为空" };
  return { ok: true, draft: { name, description, body } };
}
