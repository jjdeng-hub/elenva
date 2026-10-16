/**
 * 技能草稿的**服务端**部分：路径拼接（依赖 `node:path`）。
 *
 * 为什么与 `lib/skill-drafts.ts` 分开：后者被客户端组件 `components/MessageView.tsx`
 * 导入，一旦那条链上出现 `node:path`，webpack 会把 Node 内置模块拖进 client bundle，
 * 生产构建（`next build --webpack`）报：
 *   `UnhandledSchemeError: Reading from "node:path" is not handled by plugins`
 * 所以凡沾 `node:*` / `fs` 的东西一律留在本文件，只允许服务端模块导入
 * （当前唯一导入方：`app/api/skills/draft/save/route.ts`）。
 */
import { join } from "node:path";

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
