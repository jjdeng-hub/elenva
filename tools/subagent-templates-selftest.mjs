// 子代理模板（lib/subagent-templates.ts）的自检：
// 纯数据层（结构 / 工具名核对 / 职责分工）+ 纯函数层（toProfile 覆盖合并 / 数组防串引用）
// + 落盘一致性（经 lib/subagents.saveSubagentProfile 写盘，再解析 frontmatter 回读，
//   顺带验证「同名覆盖」与手建路径行为一致）。
//
// 运行：node tools/subagent-templates-selftest.mjs
//
// 隔离：全在 mkdtemp 出来的临时目录里，用**虚构**数据，不碰真实 ~/.pi/agent。
// lib/*.ts 是纯 TS（无 JSX），jiti 可直载（见记忆 F3）。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "elenva-subagent-templates-selftest-"));

let fail = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`FAIL  ${name}\n      ${e instanceof Error ? e.message.split("\n")[0] : e}`);
  }
};

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const templates = await jiti.import("../lib/subagent-templates.ts");
const toolPresets = await jiti.import("../lib/tool-presets.ts");
const { SUBAGENT_TEMPLATES, getSubagentTemplate, toProfile } = templates;

// 权威工具名清单 == lib/tool-presets.ts 的 BUILTIN_TOOL_NAMES（= PRESET_FULL + powershell）。
const CANONICAL_TOOLS = new Set([...toolPresets.PRESET_FULL, "powershell"]);
const READ_ONLY = [...toolPresets.PRESET_READ_ONLY].sort();
const ICONS = new Set(["search", "shield-alert", "shield-check"]);

// ---------------------------------------------------------------- 纯数据层
console.log("纯数据层：");

check("内置模板 ≥3 个，id 合法且唯一", () => {
  assert.ok(SUBAGENT_TEMPLATES.length >= 3, `expected >=3 templates, got ${SUBAGENT_TEMPLATES.length}`);
  const ids = SUBAGENT_TEMPLATES.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, "template ids must be unique");
  for (const t of SUBAGENT_TEMPLATES) {
    assert.match(t.id, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, `bad id: ${t.id}`);
  }
});

check("模板字段完整：显示名 / 描述 / systemPrompt / 布尔字段 / 图标", () => {
  for (const t of SUBAGENT_TEMPLATES) {
    assert.ok(t.displayName.trim(), `${t.id}: displayName required`);
    assert.ok(t.description.trim(), `${t.id}: description required`);
    assert.ok(t.systemPrompt.trim().length > 80, `${t.id}: systemPrompt too short`);
    assert.ok(t.systemPrompt.includes("## 边界"), `${t.id}: systemPrompt must state boundaries`);
    assert.ok(t.systemPrompt.includes("## 输出格式"), `${t.id}: systemPrompt must state output format`);
    for (const key of ["loadSkills", "loadExtensions", "inheritContext", "runInBackground", "enabled"]) {
      assert.equal(typeof t[key], "boolean", `${t.id}: ${key} must be boolean`);
    }
    assert.ok(Number.isInteger(t.maxTurns) && t.maxTurns > 0, `${t.id}: maxTurns must be a positive integer`);
    assert.ok(t.maxTurns <= 50, `${t.id}: maxTurns should stay a conservative budget`);
    assert.ok(ICONS.has(t.icon), `${t.id}: unknown icon ${t.icon}`);
  }
});

check("模型字段默认继承（模板里不硬编码 model / thinking）", () => {
  for (const t of SUBAGENT_TEMPLATES) {
    assert.equal(t.model, undefined, `${t.id}: model must not be hardcoded`);
    assert.equal(t.thinking, undefined, `${t.id}: thinking must not be hardcoded`);
  }
});

check("工具名全部来自实码清单，且无重复", () => {
  for (const t of SUBAGENT_TEMPLATES) {
    assert.ok(Array.isArray(t.tools) && t.tools.length > 0, `${t.id}: tools required`);
    assert.equal(new Set(t.tools).size, t.tools.length, `${t.id}: duplicate tools`);
    for (const tool of t.tools) {
      assert.ok(CANONICAL_TOOLS.has(tool), `${t.id}: unknown tool "${tool}"`);
    }
  }
});

check("职责分工：调研 / 审计 只读，复核 允许 bash 但不给写工具", () => {
  const researcher = getSubagentTemplate("researcher");
  const auditor = getSubagentTemplate("auditor");
  const verifier = getSubagentTemplate("verifier");
  assert.ok(researcher && auditor && verifier, "expected researcher / auditor / verifier templates");

  for (const t of [researcher, auditor]) {
    assert.deepEqual([...t.tools].sort(), READ_ONLY, `${t.id}: must be read-only`);
  }
  assert.ok(verifier.tools.includes("bash"), "verifier needs bash to run checks");
  for (const forbidden of ["edit", "write"]) {
    assert.ok(!verifier.tools.includes(forbidden), `verifier must not have ${forbidden}`);
  }
});

check("getSubagentTemplate 命中与未命中", () => {
  assert.equal(getSubagentTemplate("researcher")?.id, "researcher");
  assert.equal(getSubagentTemplate("nope"), undefined);
});

// ---------------------------------------------------------------- 纯函数层
console.log("纯函数层：");

check("toProfile：默认字段来自模板，name = id", () => {
  for (const t of SUBAGENT_TEMPLATES) {
    const p = toProfile(t);
    assert.equal(p.name, t.id);
    assert.equal(p.displayName, t.displayName);
    assert.equal(p.description, t.description);
    assert.equal(p.systemPrompt, t.systemPrompt);
    assert.deepEqual(p.tools, t.tools);
    assert.equal(p.loadSkills, t.loadSkills);
    assert.equal(p.loadExtensions, t.loadExtensions);
    assert.equal(p.inheritContext, t.inheritContext);
    assert.equal(p.runInBackground, t.runInBackground);
    assert.equal(p.enabled, t.enabled);
    assert.equal(p.maxTurns, t.maxTurns);
    assert.equal(p.model, undefined);
    assert.equal(p.thinking, undefined);
  }
});

check("toProfile：字段齐全（与 saveSubagentProfile 需要的形状一致）", () => {
  const keys = Object.keys(toProfile(SUBAGENT_TEMPLATES[0])).sort();
  assert.deepEqual(keys, [
    "description", "displayName", "enabled", "inheritContext", "loadExtensions", "loadSkills",
    "maxTurns", "name", "runInBackground", "systemPrompt", "tools",
  ]);
});

check("toProfile：overrides 覆盖单字段，其余保持模板默认", () => {
  const t = getSubagentTemplate("researcher");
  const p = toProfile(t, { displayName: "改名后的调研员" });
  assert.equal(p.displayName, "改名后的调研员");
  assert.equal(p.name, t.id, "name should stay the template id when not overridden");
  assert.equal(p.systemPrompt, t.systemPrompt);
  assert.deepEqual(p.tools, t.tools);
});

check("toProfile：tools 被覆盖时整组替换；显式 undefined 视为未覆盖", () => {
  const t = getSubagentTemplate("verifier");
  const replaced = toProfile(t, { tools: ["read"] });
  assert.deepEqual(replaced.tools, ["read"]);
  const fallback = toProfile(t, { tools: undefined, displayName: undefined });
  assert.deepEqual(fallback.tools, t.tools);
  assert.equal(fallback.displayName, t.displayName);
});

// S4：`null` 与 `undefined` 语义锁定。toProfile 用 `??` 判覆盖 → 两者都表示「未覆盖、
// 继承模板」，而**不是**「清空」。断言打在真实 toProfile 产物的字段上，防止以后有人
// 把 `??` 改成 `in`／`hasOwnProperty`（那会把 null 变成清空）而无人察觉。
check("toProfile：null 与 undefined 同义——均落回模板继承（不是清空）", () => {
  const t = getSubagentTemplate("verifier");
  const withNull = toProfile(t, {
    name: null, displayName: null, description: null, systemPrompt: null, tools: null,
    loadSkills: null, loadExtensions: null, inheritContext: null, runInBackground: null,
    enabled: null, model: null, thinking: null, maxTurns: null,
  });
  assert.equal(withNull.name, t.id, "name=null 应继承模板 id");
  assert.equal(withNull.displayName, t.displayName);
  assert.equal(withNull.description, t.description);
  assert.equal(withNull.systemPrompt, t.systemPrompt);
  assert.deepEqual(withNull.tools, t.tools, "tools=null 应继承模板工具集");
  assert.equal(withNull.loadSkills, t.loadSkills);
  assert.equal(withNull.loadExtensions, t.loadExtensions);
  assert.equal(withNull.inheritContext, t.inheritContext);
  assert.equal(withNull.runInBackground, t.runInBackground);
  assert.equal(withNull.enabled, t.enabled);
  assert.equal(withNull.model, undefined);
  assert.equal(withNull.thinking, undefined);
  assert.equal(withNull.maxTurns, t.maxTurns);

  const withUndefined = toProfile(t, { displayName: undefined, tools: undefined, maxTurns: undefined });
  assert.equal(withUndefined.displayName, t.displayName);
  assert.deepEqual(withUndefined.tools, t.tools);
  assert.equal(withUndefined.maxTurns, t.maxTurns);

  // 「显式清空」必须另有表达：tools 的 [] 才是真清空（null 做不到）
  assert.deepEqual(toProfile(t, { tools: [] }).tools, [], "tools=[] 才是显式清空");
});

check("toProfile：name 去空白；空串回落到模板 id", () => {
  const t = getSubagentTemplate("auditor");
  assert.equal(toProfile(t, { name: "  my-agent  " }).name, "my-agent");
  assert.equal(toProfile(t, { name: "   " }).name, t.id);
});

check("toProfile：可选字段可覆盖（model / thinking / maxTurns / 布尔位）", () => {
  const t = getSubagentTemplate("researcher");
  const p = toProfile(t, { model: "demo/model-1", thinking: "low", maxTurns: 5, runInBackground: true });
  assert.equal(p.model, "demo/model-1");
  assert.equal(p.thinking, "low");
  assert.equal(p.maxTurns, 5);
  assert.equal(p.runInBackground, true);
});

check("toProfile：tools 每次都是新数组，改动不串到模板或其它结果", () => {
  const t = getSubagentTemplate("researcher");
  const a = toProfile(t);
  const b = toProfile(t);
  a.tools.push("bash");
  assert.ok(!b.tools.includes("bash"), "second result must not see first mutation");
  assert.ok(!t.tools.includes("bash"), "template constant must not be mutated");
  assert.notEqual(a.tools, b.tools);
  assert.notEqual(a.tools, t.tools);
});

// ---------------------------------------------------------------- 落盘一致性层
console.log("落盘一致性层：");

const subagents = await jiti.import("../lib/subagents.ts");
const { parseFrontmatter } = await jiti.import("../lib/frontmatter.ts");
const projectRoot = join(root, "project");
mkdirSync(projectRoot, { recursive: true });
const agentsDir = join(projectRoot, ".pi", "agents");

check("模板落盘 → frontmatter 回读一致（tools / display_name / max_turns / body）", () => {
  for (const t of SUBAGENT_TEMPLATES) {
    const displayName = `虚构-${t.displayName}`;
    subagents.saveSubagentProfile(projectRoot, "project", toProfile(t, { displayName }));
    const file = join(agentsDir, `${t.id}.md`);
    const { data, rest } = parseFrontmatter(readFileSync(file, "utf8"));
    assert.equal(data.display_name, displayName, `${t.id}: display_name`);
    assert.equal(data.description, t.description, `${t.id}: description`);
    assert.equal(data.tools, t.tools.join(", "), `${t.id}: tools`);
    assert.equal(data.enabled, true, `${t.id}: enabled`);
    assert.equal(data.max_turns, t.maxTurns, `${t.id}: max_turns`);
    assert.equal(data.model, undefined, `${t.id}: model must stay inherited`);
    assert.equal(rest.trim(), t.systemPrompt.trim(), `${t.id}: body must equal systemPrompt`);
  }
});

check("同名重复创建 = 覆盖同一个文件（与手建路径一致，不产生重复）", () => {
  const t = getSubagentTemplate("researcher");
  subagents.saveSubagentProfile(projectRoot, "project", toProfile(t, { displayName: "第二次创建" }));
  const matching = readdirSync(agentsDir).filter((f) => f === `${t.id}.md`);
  assert.equal(matching.length, 1, "same name must overwrite, not duplicate");
  const { data } = parseFrontmatter(readFileSync(join(agentsDir, `${t.id}.md`), "utf8"));
  assert.equal(data.display_name, "第二次创建");
});

check("模板 profile 能被 listSubagentProfiles 读回（scope/name 正确）", () => {
  const listed = subagents.listSubagentProfiles(projectRoot);
  for (const t of SUBAGENT_TEMPLATES) {
    const found = listed.find((p) => p.name === t.id && p.scope === "project");
    assert.ok(found, `expected persisted profile ${t.id}`);
    assert.deepEqual(found.tools, t.tools);
  }
});

rmSync(root, { recursive: true, force: true });
console.log(fail === 0 ? "\n全部通过" : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
