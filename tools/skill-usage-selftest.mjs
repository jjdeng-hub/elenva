// 技能用量口径自测（模块 4 修复轮 · R1 解析加固 + R2 覆盖 read 路径）。
//
// R1 断言（修前会被误计，修后必须为 0）：
//   · 用户在正文里**引用/讨论** skill 块（不在文本起始）→ 不计
//   · 非 JSON 的**损坏行**（含字面 "role":"user" + skill 块）→ 不计
// R2 断言（会话级激活口径）：
//   · read …/skills/<name>/SKILL.md 被识别（全局根 / projects-memory 根都认）
//   · 同一会话读同一技能多次 → 计 1；跨会话 → 各计 1
//   · 同会话被 write/edit/skill_manage/skill_draft 改写的技能，其读取不计（维护否决）
//   · 同会话既 /skill: 又 read → 只算命令一次，不双计
//   · bash / grep 文本里出现的 SKILL.md 字符串 → 不计
//
// 运行：node tools/skill-usage-selftest.mjs
//
// 隔离：PI_CODING_AGENT_DIR 指向 mkdtemp 出来的临时目录，夹具全是**明显虚构**
// 的技能名与路径（/fixtures/...），不碰真实 ~/.pi/agent。lib/skill-usage.ts → pi SDK
// 为纯 JS，jiti 可直载。
import { createJiti } from "jiti";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "elenva-skill-usage-selftest-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const { aggregateSkillUsage, resetSkillUsageCacheForTest } = await jiti.import("../lib/skill-usage.ts");

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

const sessionsDir = join(agentDir, "sessions");
const now = new Date().toISOString();

function writeSession(relDir, name, lines) {
  const dir = join(sessionsDir, relDir);
  mkdirSync(dir, { recursive: true });
  const header = { type: "session", id: name, timestamp: now };
  const body = lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n");
  writeFileSync(join(dir, `${name}.jsonl`), `${JSON.stringify(header)}\n${body}\n`, "utf8");
}

const userText = (text) => ({ type: "message", timestamp: now, message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (blocks) => ({ type: "message", timestamp: now, message: { role: "assistant", content: blocks } });
const readCall = (path) => ({ type: "toolCall", id: "t-read", name: "read", arguments: { path } });
const writeCall = (path) => ({ type: "toolCall", id: "t-write", name: "write", arguments: { path, content: "x" } });
const bashCall = (command) => ({ type: "toolCall", id: "t-bash", name: "bash", arguments: { command } });
const skillCall = (name, location) => `<skill name="${name}" location="${location}">\n正文\n</skill>`;
const globalSkill = (name) => `/fixtures/agent/skills/${name}/SKILL.md`;
const pmSkill = (name) => `/fixtures/agent/projects-memory/fixture-project/skills/${name}/SKILL.md`;

/* ── R1 用例 ───────────────────────────────────────────────── */
// 正规命令调用：块在文本起始
writeSession("r1", "command", [userText(`${skillCall("r1-command", globalSkill("r1-command"))}\n\n帮我做点事`)]);
// 引文：块出现在正文中间，不是起始 —— 修前误计为 1
writeSession("r1", "quoted", [
  userText(`我在读源码，里面对外暴露了 ${skillCall("r1-quoted", globalSkill("r1-quoted"))} 这样的块，说明一下它怎么解析`),
]);
// 损坏行：非 JSON，但含字面 "role":"user" 与 skill 块 —— 修前误计为 1
writeSession("r1", "corrupt", [
  `{"type":"message","timestamp":"${now}","message":{"role":"user"}, 这里坏了 ${skillCall("r1-corrupt", globalSkill("r1-corrupt"))}`,
]);
// 尾部多一个换行不该让锚定失配
writeSession("r1", "trailing", [userText(`${skillCall("r1-trailing", globalSkill("r1-trailing"))}\n`)]);

/* ── R2 用例 ───────────────────────────────────────────────── */
// 同一会话读同一技能 3 次（分页形态）→ 去重为 1
writeSession("r2", "dedupe", [
  userText("开始干活"),
  assistant([readCall(globalSkill("r2-dedupe"))]),
  assistant([{ type: "toolCall", id: "t2", name: "read", arguments: { path: globalSkill("r2-dedupe"), offset: 60, limit: 60 } }]),
  assistant([{ type: "toolCall", id: "t3", name: "read", arguments: { path: globalSkill("r2-dedupe"), offset: 120, limit: 60 } }]),
]);
// 跨会话各读一次 → 计 2（去重只发生在会话内）
writeSession("r2", "multi-a", [userText("a"), assistant([readCall(globalSkill("r2-multisession"))])]);
writeSession("r2", "multi-b", [userText("b"), assistant([readCall(globalSkill("r2-multisession"))])]);
// 维护否决：同会话读了又写同一技能 → 读取不计
writeSession("r2", "veto", [
  userText("改一下这个技能"),
  assistant([readCall(globalSkill("r2-vetoed"))]),
  assistant([writeCall(globalSkill("r2-vetoed"))]),
]);
// 只否决被改写的那个技能：读 A、写 B → A 仍计入
writeSession("r2", "veto-scoped", [
  userText("顺手改 B"),
  assistant([readCall(globalSkill("r2-other-read"))]),
  assistant([writeCall(globalSkill("r2-written-only"))]),
]);
// bash 文本里出现 SKILL.md 字符串 → 不计（只有结构化 read toolCall 才算）
writeSession("r2", "bash", [
  userText("找一下"),
  assistant([bashCall("grep -rn SKILL.md /fixtures/agent/skills/r2-bash/SKILL.md")]),
]);
// 同会话既 /skill: 又 read → 只算命令一次
writeSession("r2", "both", [
  userText(skillCall("r2-both", globalSkill("r2-both"))),
  assistant([readCall(globalSkill("r2-both"))]),
]);
// 链式命令：一条消息里连着两个 skill 块 → 各计 1
writeSession("r2", "chain", [
  userText(`${skillCall("r2-chain-a", globalSkill("r2-chain-a"))}\n\n${skillCall("r2-chain-b", globalSkill("r2-chain-b"))}`),
]);
// projects-memory 下的技能根同样识别
writeSession("r2", "pm", [userText("项目技能"), assistant([readCall(pmSkill("r2-pm"))])]);
// 读普通文件不算技能使用
writeSession("r2", "plain", [userText("看个文件"), assistant([readCall("/fixtures/agent/skills/README.md")])]);

resetSkillUsageCacheForTest();
const report = aggregateSkillUsage();
const byName = new Map(report.skills.map((entry) => [entry.name, entry.count]));
const countOf = (name) => byName.get(name) ?? 0;
const srcOf = (name) => report.skillSources[name] ?? { command: 0, read: 0 };

check("R1 · 起始处的 skill 块计为一次命令调用", () => {
  assert(countOf("r1-command") === 1, `期望 r1-command = 1，实际 ${countOf("r1-command")}`);
});
check("R1 · 引文（块不在文本起始）不计（断言 = 0）", () => {
  assert(countOf("r1-quoted") === 0, `期望 r1-quoted = 0，实际 ${countOf("r1-quoted")}`);
});
check("R1 · 损坏行（非 JSON）不计（断言 = 0）", () => {
  assert(countOf("r1-corrupt") === 0, `期望 r1-corrupt = 0，实际 ${countOf("r1-corrupt")}`);
});
check("R1 · 尾部多余换行不影响起始判定", () => {
  assert(countOf("r1-trailing") === 1, `期望 r1-trailing = 1，实际 ${countOf("r1-trailing")}`);
});
check("R2 · 同会话重复 read 同一技能去重为 1", () => {
  assert(countOf("r2-dedupe") === 1, `期望 r2-dedupe = 1，实际 ${countOf("r2-dedupe")}`);
  assert(srcOf("r2-dedupe").read === 1 && srcOf("r2-dedupe").command === 0, `来源应为 read=1/command=0，实际 ${JSON.stringify(srcOf("r2-dedupe"))}`);
});
check("R2 · 跨会话读取各计一次（会话内去重，不是全局）", () => {
  assert(countOf("r2-multisession") === 2, `期望 r2-multisession = 2，实际 ${countOf("r2-multisession")}`);
});
check("R2 · 维护否决：读了又写同一技能，读取不计（断言 = 0）", () => {
  assert(countOf("r2-vetoed") === 0, `期望 r2-vetoed = 0，实际 ${countOf("r2-vetoed")}`);
  assert(report.sources.readSkippedMaintenance >= 1, `期望 readSkippedMaintenance ≥ 1，实际 ${report.sources.readSkippedMaintenance}`);
});
check("R2 · 否决只针对被改写的技能，不误伤同会话读的其他技能", () => {
  assert(countOf("r2-other-read") === 1, `期望 r2-other-read = 1，实际 ${countOf("r2-other-read")}`);
  assert(countOf("r2-written-only") === 0, `期望 r2-written-only = 0（只有写没有读），实际 ${countOf("r2-written-only")}`);
});
check("R2 · bash 文本里的 SKILL.md 字符串不计（断言 = 0）", () => {
  assert(countOf("r2-bash") === 0, `期望 r2-bash = 0，实际 ${countOf("r2-bash")}`);
});
check("R2 · 同会话既命令又读取 → 只算命令一次，不双计", () => {
  assert(countOf("r2-both") === 1, `期望 r2-both = 1，实际 ${countOf("r2-both")}`);
  assert(srcOf("r2-both").command === 1 && srcOf("r2-both").read === 0, `来源应为 command=1/read=0，实际 ${JSON.stringify(srcOf("r2-both"))}`);
});
check("R2 · 一条消息里链式的多个 /skill: 块各计一次", () => {
  assert(countOf("r2-chain-a") === 1 && countOf("r2-chain-b") === 1, `期望 chain-a/b 各 1，实际 ${countOf("r2-chain-a")}/${countOf("r2-chain-b")}`);
});
check("R2 · projects-memory 下的技能根同样识别", () => {
  assert(countOf("r2-pm") === 1, `期望 r2-pm = 1，实际 ${countOf("r2-pm")}`);
});
check("R2 · 读非技能文件不计", () => {
  assert(!byName.has("README.md"), `README.md 不该成为技能名`);
});

check("总读数与来源拆分自洽（total = command + read）", () => {
  const exact = countOf("r1-command") + countOf("r1-trailing") + countOf("r2-dedupe") + countOf("r2-multisession") + countOf("r2-other-read") + countOf("r2-both") + countOf("r2-chain-a") + countOf("r2-chain-b") + countOf("r2-pm");
  assert(report.total === exact, `期望 total = ${exact}，实际 ${report.total}`);
  assert(report.sources.command + report.sources.read === report.total, `命令 ${report.sources.command} + 读取 ${report.sources.read} ≠ total ${report.total}`);
  assert(report.sources.command === 5, `期望 command = 5，实际 ${report.sources.command}`);
  assert(report.sources.read === 5, `期望 read = 5，实际 ${report.sources.read}`);
});
check("近 7 天窗口同时覆盖命令与读取", () => {
  assert(report.recent.total7 === report.total, `期望 total7 = ${report.total}，实际 ${report.recent.total7}`);
  assert(report.recent.days7["r2-dedupe"] === 1, `期望 days7[r2-dedupe] = 1，实际 ${report.recent.days7["r2-dedupe"]}`);
  assert(report.recent.days7["r2-quoted"] === undefined, `引用不应进入窗口`);
});
check("空会话目录：total=0 且不抛", () => {
  const empty = mkdtempSync(join(tmpdir(), "elenva-skill-usage-empty-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = empty;
  try {
    resetSkillUsageCacheForTest();
    const emptyReport = aggregateSkillUsage();
    assert(emptyReport.total === 0 && emptyReport.skills.length === 0, `期望空报告，实际 ${JSON.stringify(emptyReport.skills)}`);
  } finally {
    process.env.PI_CODING_AGENT_DIR = old;
    resetSkillUsageCacheForTest();
    rmSync(empty, { recursive: true, force: true });
  }
});

console.log(fail === 0 ? "\n全部通过" : `\n${fail} 项失败`);
rmSync(root, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
