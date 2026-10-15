/**
 * elenva-skills 纯函数自检（不装扩展、不起会话、不调模型）。
 *
 * 跑法：node extensions/elenva-skills/selftest.mjs
 * 全绿输出 SELFTEST: OK / n 通过；有失败输出 SELFTEST: FAILED 并以退出码 1 结束。
 */
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false, interopDefault: true });
const { validateSkillDraft, isValidSkillDraftName, SKILL_DRAFT_NAME_MAX } = await jiti.import("./draft.ts");

let pass = 0;
let fail = 0;
const check = (name, condition, extra = "") => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
  condition ? (pass += 1) : (fail += 1);
};

/* ── 1. name 校验 ─────────────────────────────────────────────────────── */
check("合法名：单段", isValidSkillDraftName("debug") === true);
check("合法名：连字符", isValidSkillDraftName("debug-node-esm") === true);
check("合法名：带数字", isValidSkillDraftName("fix-2fa") === true);
check("非法名：大写", isValidSkillDraftName("Debug") === false);
check("非法名：下划线 / 点 / 空格", ["a_b", "a.b", "a b"].every((n) => !isValidSkillDraftName(n)));
check("非法名：首尾连字符 / 连续连字符", ["-x", "x-", "a--b"].every((n) => !isValidSkillDraftName(n)));
check("非法名：空 / 非字符串", [!isValidSkillDraftName(""), !isValidSkillDraftName(null), !isValidSkillDraftName(7)].every(Boolean));
check(`非法名：超过 ${SKILL_DRAFT_NAME_MAX}`, isValidSkillDraftName("a".repeat(SKILL_DRAFT_NAME_MAX + 1)) === false);
check(`合法名：正好 ${SKILL_DRAFT_NAME_MAX}`, isValidSkillDraftName("a".repeat(SKILL_DRAFT_NAME_MAX)) === true);

/* ── 2. validateSkillDraft：归一与拒绝 ────────────────────────────────── */
const good = validateSkillDraft({ name: "  demo-skill  ", description: "  何时用  ", body: "\n# 标题\n正文\n" });
check("合法草稿通过", good.ok === true);
check("返回体 trim 归一", good.ok && good.draft.name === "demo-skill" && good.draft.description === "何时用" && good.draft.body === "# 标题\n正文");

const badName = validateSkillDraft({ name: "Bad Name", description: "d", body: "b" });
check("非法 name 被拒", badName.ok === false && badName.error.includes("name"));
check("description 为空被拒", validateSkillDraft({ name: "ok", description: "   ", body: "b" }).ok === false);
check("body 为空被拒", validateSkillDraft({ name: "ok", description: "d", body: "" }).ok === false);
check("缺字段被拒", validateSkillDraft({}).ok === false);
check("非字符串字段被拒", validateSkillDraft({ name: 1, description: 2, body: 3 }).ok === false);

console.log(fail === 0 ? `SELFTEST: OK  ${pass} 通过` : `SELFTEST: FAILED  ${fail} 失败 / ${pass} 通过`);
process.exit(fail === 0 ? 0 : 1);
