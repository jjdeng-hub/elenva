// 技能草稿纯函数（lib/skill-drafts.ts）的自检：
// name 校验 / validateSkillDraft 归一与拒绝 / yamlScalar 安全引号 / buildSkillMarkdown 拼装 /
// 路径拼接 / 重名判定 / readSkillDraft 宽松解析。全用**虚构**数据。
// 运行：node tools/skill-drafts-selftest.mjs
//
// lib/skill-drafts.ts 依赖扩展里的纯模块 extensions/elenva-skills/draft.ts（零依赖），
// jiti 可直载并解析 `@/` 别名（见记忆 F1/F3）。
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const {
  isValidSkillDraftName,
  validateSkillDraft,
  yamlScalar,
  buildSkillMarkdown,
  skillDraftDir,
  skillDraftPath,
  isSkillDraftTaken,
  readSkillDraft,
  SKILL_DRAFT_NAME_MAX,
} = await jiti.import("../lib/skill-drafts.ts");

let fail = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
};
const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};
const eq = (actual, expected, message) =>
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`,
  );

/* ============================ name 校验 ============================ */

check("合法 name：单词 / 连字符 / 数字", () => {
  assert(isValidSkillDraftName("debug"), "单词");
  assert(isValidSkillDraftName("debug-node-esm"), "连字符");
  assert(isValidSkillDraftName("fix-2fa"), "数字");
});

check("非法 name：大写 / 下划线 / 点 / 空格 / 空 / 非字符串", () => {
  for (const bad of ["Debug", "a_b", "a.b", "a b", "", " ", null, undefined, 7, "中文名"]) {
    assert(!isValidSkillDraftName(bad), `应拒绝 ${JSON.stringify(bad)}`);
  }
});

check("非法 name：首尾连字符 / 连续连字符", () => {
  for (const bad of ["-x", "x-", "a--b", "--"]) assert(!isValidSkillDraftName(bad), `应拒绝 ${bad}`);
});

check(`name 长度边界：${SKILL_DRAFT_NAME_MAX} 通过、+1 拒绝`, () => {
  assert(isValidSkillDraftName("a".repeat(SKILL_DRAFT_NAME_MAX)), "等于上限应通过");
  assert(!isValidSkillDraftName("a".repeat(SKILL_DRAFT_NAME_MAX + 1)), "超上限应拒绝");
});

/* ============================ validateSkillDraft ============================ */

check("合法草稿：通过并 trim 归一", () => {
  const r = validateSkillDraft({ name: "  demo-skill  ", description: "  何时用  ", body: "\n# 标题\n正文\n" });
  eq(r.ok, true, "通过");
  eq(r.draft, { name: "demo-skill", description: "何时用", body: "# 标题\n正文" }, "归一结果");
});

check("非法字段：name / description / body / 缺字段 / 非字符串", () => {
  for (const input of [
    { name: "Bad Name", description: "d", body: "b" },
    { name: "ok", description: "   ", body: "b" },
    { name: "ok", description: "d", body: "" },
    {},
    { name: 1, description: 2, body: 3 },
  ]) {
    const r = validateSkillDraft(input);
    assert(r.ok === false && typeof r.error === "string" && r.error.length > 0, `应拒绝 ${JSON.stringify(input)}`);
  }
});

/* ============================ yamlScalar ============================ */

check("yamlScalar：常规值保持裸写法（对齐现有 SKILL.md）", () => {
  eq(yamlScalar("debug-node-esm"), "debug-node-esm", "标识符");
  eq(yamlScalar("从文档提取文本"), "从文档提取文本", "中文");
  eq(yamlScalar("含“全角冒号：不影响”"), "含“全角冒号：不影响”", "全角冒号");
  eq(yamlScalar('带"引号"的说明'), '带"引号"的说明', "行内双引号");
});

check("yamlScalar：会被 YAML 读歪的值加双引号", () => {
  eq(yamlScalar("含冒号: 后面有空格"), '"含冒号: 后面有空格"', "冒号加空格");
  eq(yamlScalar("以冒号结尾:"), '"以冒号结尾:"', "冒号结尾");
  eq(yamlScalar("- 看起来像列表"), '"- 看起来像列表"', "指示符开头");
  eq(yamlScalar("井号前有空格 # 注释"), '"井号前有空格 # 注释"', "空格加井号");
  eq(yamlScalar(" 首尾空白 "), '" 首尾空白 "', "首尾空白");
  eq(yamlScalar("多行\n文本"), '"多行\\n文本"', "换行");
  eq(yamlScalar(""), '""', "空串");
});

/* ============================ buildSkillMarkdown ============================ */

check("buildSkillMarkdown：标准形态（frontmatter + 空行 + 正文 + 尾换行）", () => {
  const md = buildSkillMarkdown({ name: "demo", description: "何时用", body: "# 标题\n正文" });
  eq(md, "---\nname: demo\ndescription: 何时用\n---\n\n# 标题\n正文\n", "全文");
  assert(md.endsWith("\n") && !md.endsWith("\n\n"), "以单个换行结尾");
});

check("buildSkillMarkdown：CRLF 归一为 LF", () => {
  const md = buildSkillMarkdown({ name: "demo", description: "d", body: "# 标题\r\n正文\r\n" });
  assert(!md.includes("\r"), "不应残留 CR");
  assert(md.includes("\n# 标题\n正文\n"), "正文用 LF");
});

check("buildSkillMarkdown：描述含冒号时 frontmatter 仍可安全解析", () => {
  const md = buildSkillMarkdown({ name: "demo", description: "何时用: 冒号场景", body: "正文" });
  eq(md.split("\n")[2], 'description: "何时用: 冒号场景"', "描述行加引号");
});

check("buildSkillMarkdown：首行即 frontmatter，正文与前端无粘连", () => {
  const md = buildSkillMarkdown({ name: "demo", description: "d", body: "\n\n正文\n\n" });
  eq(md, "---\nname: demo\ndescription: d\n---\n\n正文\n", "空行归一");
});

/* ============================ 路径与重名判定 ============================ */

check("路径拼接：dir / file", () => {
  const root = join("/tmp", "fake-skills-root");
  eq(skillDraftDir(root, "demo"), join(root, "demo"), "目录");
  eq(skillDraftPath(root, "demo"), join(root, "demo", "SKILL.md"), "文件");
});

check("重名判定：目录存在 / 文件存在 / 都不存在", () => {
  const root = join("/tmp", "fake-skills-root");
  const dir = skillDraftDir(root, "demo");
  const file = skillDraftPath(root, "demo");
  assert(isSkillDraftTaken((p) => p === dir, root, "demo") === true, "目录在 → 重名");
  assert(isSkillDraftTaken((p) => p === file, root, "demo") === true, "文件在 → 重名");
  assert(isSkillDraftTaken(() => false, root, "demo") === false, "都不在 → 不重名");
});

/* ============================ readSkillDraft ============================ */

check("readSkillDraft：合法入参取到草稿并 trim", () => {
  eq(
    readSkillDraft({ name: " demo ", description: " d ", body: " b " }),
    { name: "demo", description: "d", body: "b" },
    "归一",
  );
});

check("readSkillDraft：name 非法仍返回草稿（卡上标错并禁用保存）", () => {
  eq(
    readSkillDraft({ name: "Bad Name", description: "d", body: "b" }),
    { name: "Bad Name", description: "d", body: "b" },
    "宽松解析",
  );
});

check("readSkillDraft：缺字段 / 非对象 / 非字符串 → null", () => {
  assert(readSkillDraft({ name: "demo", description: "d" }) === null, "缺 body");
  assert(readSkillDraft({ name: "", description: "d", body: "b" }) === null, "空 name");
  assert(readSkillDraft({ name: 1, description: 2, body: 3 }) === null, "非字符串");
  assert(readSkillDraft(null) === null, "null");
  assert(readSkillDraft("demo") === null, "字符串");
  assert(readSkillDraft(undefined) === null, "undefined");
});

console.log(fail === 0 ? `SELFTEST: OK  ${"全部通过"}` : `SELFTEST: FAILED  ${fail} 组失败`);
process.exit(fail === 0 ? 0 : 1);
