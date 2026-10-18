// 技能用量顾问（模块 4 · 第 5 轮）的自检：
// 纯函数层（概览读数 / 高频榜与 cap / 吃灰清单分层与窗口过滤 / 空数据 / 老数据兼容）
// + 窗口聚合层（近 7/30 天同次扫描统计 / 边界含头 / mtime 兜底口径 / 30s 缓存）
// + 仓库边界（.gitignore 白名单 / API 契约「只增不改」静态核对）。
// 运行：node tools/skill-advisor-selftest.mjs
//
// 隔离：PI_CODING_AGENT_DIR 指向 mkdtemp 出来的临时目录，全用**虚构**技能名
// （alpha-helper / beta-scanner / gamma-agent / delta-reviewer，均为杜撰），
// 不碰真实 ~/.pi/agent。lib/*.ts 是纯 TS（无 JSX），jiti 可直载（见记忆 F1/F3）。
import { createJiti } from "jiti";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "elenva-skill-advisor-selftest-"));
const agentDir = join(root, "agent");
const sessionsDir = join(agentDir, "sessions", "--fixture-proj--");
mkdirSync(sessionsDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const alias = { "@": new URL("../", import.meta.url).pathname };
const jiti1 = createJiti(import.meta.url, { alias }); // 实例 A：窗口聚合 + 缓存
const jiti2 = createJiti(import.meta.url, { alias }); // 实例 B：换夹具后绕开模块级 30s 缓存
const jiti3 = createJiti(import.meta.url, { alias }); // 实例 C：mtime 兑底场景也要新实例（jiti2 已缓存）
const jitiAdvisor = createJiti(import.meta.url, { alias });

const usage1 = await jiti1.import("../lib/skill-usage.ts");
const { aggregateSkillUsage } = usage1;
const advisorLib = await jitiAdvisor.import("../lib/skill-advisor.ts");
const { buildSkillAdvisorReport, HOT_LIMIT } = advisorLib;

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
const eq = (a, b, msg = "") => {
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg}\n      期望 ${jb}\n      实得 ${ja}`);
};

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

/** 写一个虚构会话文件（行数组含对象/字符串混合） */
function writeSession(name, lines) {
  const body = lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n";
  writeFileSync(join(sessionsDir, name), body, "utf8");
}

/**
 * 合法的技能块（内核 parseSkillBlock 的正则要求 `>\n正文\n</skill>`；
 * 落盘时内容是转义形态，这里直接给未转义的文本）。
 * 注：2026-10-18 上一轮把命令路径改成真正解析后，旧夹具里 `<skill …>x</skill>`
 * 这类**不合法**的块就不再被计入了 —— 本夹具已按合法形态重建。
 */
const skillBlock = (name, location) => `<skill name="${name}" location="${location}">\n正文\n</skill>`;
const globalSkillPath = (name) => `${agentDir}/skills/${name}/SKILL.md`;

// ───────────────────────────────────────────────
// 场景 A：窗口聚合（同次扫描出 7/30 天统计，老字段一个不丢）
// ───────────────────────────────────────────────
const in7 = now - 2 * DAY;          // 近 7 天内
const in30_not7 = now - 20 * DAY;   // 近 30 天、7 天外
const out30 = now - 40 * DAY;       // 窗口外（honor 边界用 now-7d-60s / now-30d-60s 单测）
// 全部虚构技能名（杜撰，与真实已装技能无涉）
writeSession("2026-10-16T00-00-00-000Z_fixture-a.jsonl", [
  { type: "session", id: "fixture-a", cwd: "/fixture", timestamp: iso(in7) },
  {
    type: "message", id: "a1", timestamp: iso(in7),
    message: { role: "user", content: [{ type: "text", text: skillBlock("alpha-helper", globalSkillPath("alpha-helper")) }] },
  },
  {
    type: "message", id: "a2", timestamp: iso(in30_not7),
    message: { role: "user", content: [{ type: "text", text: `${skillBlock("alpha-helper", globalSkillPath("alpha-helper"))}\n\n${skillBlock("beta-scanner", globalSkillPath("beta-scanner"))}` }] },
  },
  {
    type: "message", id: "a3", timestamp: iso(out30),
    message: { role: "user", content: [{ type: "text", text: skillBlock("gamma-agent", globalSkillPath("gamma-agent")) }] },
  },
  // 助手行混入同名 skill 块也不该被计数（只扫用户消息行）
  { type: "message", id: "a4", timestamp: iso(in7), message: { role: "assistant", content: [{ type: "text", text: skillBlock("alpha-helper", "x") }] } },
]);

const a = aggregateSkillUsage();
check("场景A · 总数只算用户行（助手行不计）", () => eq(a.total, 4, "alpha×2 + beta×1 + gamma×1"));
check("场景A · 排行榜不变坏死（降序）", () => eq(a.skills.map((s) => s.name), ["alpha-helper", "beta-scanner", "gamma-agent"]));
check("场景A · 近7天窗口（20天前不算）", () => eq(a.recent.days7, { "alpha-helper": 1 }));
check("场景A · 近30天窗口（40天前不算）", () => eq(a.recent.days30, { "alpha-helper": 2, "beta-scanner": 1 }));
check("场景A · 窗口总数", () => eq([a.recent.total7, a.recent.total30], [1, 3]));
check("场景A · lastUsed 与 recent.at 均为合法 ISO", () => {
  for (const v of [...Object.values(a.lastUsed), a.recent.at]) {
    if (!Number.isFinite(Date.parse(v))) throw new Error(`非 ISO：${v}`);
  }
});
check("场景A · 老字段契约不变（total/skills/lastUsed 三键仍在）", () => {
  for (const key of ["total", "skills", "lastUsed", "recent"]) {
    if (!(key in a)) throw new Error(`缺字段 ${key}`);
  }
});

// 缓存：30s 内第二次调用应返回同一对象（不重扫）
const a2 = aggregateSkillUsage();
check("场景A · 30s 内存缓存生效（同引用）", () => {
  if (a2 !== a) throw new Error("缓存被意外重算");
});

// ───────────────────────────────────────────────
// 场景 B：边界含头（恰好 7 天/30 天前 ± 60s）
// ───────────────────────────────────────────────
writeSession("2026-10-16T01-00-00-000Z_fixture-b.jsonl", [
  { type: "session", id: "fixture-b", cwd: "/fixture", timestamp: iso(now) },
  {
    type: "message", id: "b1", timestamp: iso(now - 7 * DAY + 60_000),
    message: { role: "user", content: [{ type: "text", text: skillBlock("delta-reviewer", globalSkillPath("delta-reviewer")) }] },
  },
  {
    type: "message", id: "b2", timestamp: iso(now - 7 * DAY - 60_000),
    message: { role: "user", content: [{ type: "text", text: skillBlock("epsilon-migrate", globalSkillPath("epsilon-migrate")) }] },
  },
  {
    type: "message", id: "b3", timestamp: iso(now - 30 * DAY + 60_000),
    message: { role: "user", content: [{ type: "text", text: skillBlock("epsilon-migrate", globalSkillPath("epsilon-migrate")) }] },
  },
  {
    type: "message", id: "b4", timestamp: iso(now - 30 * DAY - 60_000),
    message: { role: "user", content: [{ type: "text", text: skillBlock("zeta-plot", globalSkillPath("zeta-plot")) }] },
  },
]);
const mod2 = await jiti2.import("../lib/skill-usage.ts");
mod2.resetSkillUsageCacheForTest(); // jiti 模块注册表跨实例共享，30s 缓存必须显式清掉再重扫
const b = mod2.aggregateSkillUsage();
check("场景B · 7 天边界：窗内含头、窗外不含", () => {
  eq(b.recent.days7["delta-reviewer"], 1, "–7d+60s 应算进 7 天窗");
  // 窗外技能键不落在 days7 里（0 调用不建键），UI 侧用 ?? 0 兼位
  eq(b.recent.days7["epsilon-migrate"] ?? 0, 0, "–7d–60s 不算");
});
check("场景B · 30 天边界：窗内含头、窗外不含", () => {
  // epsilon 两笔（–7d–60s、–30d+60s）都在 30 天窗内 → 2
  eq(b.recent.days30["epsilon-migrate"], 2, "–30d+60s 应算进 30 天窗");
  eq(b.recent.days30["zeta-plot"] ?? 0, 0, "–30d–60s 不算");
});

// ───────────────────────────────────────────────
// 场景 C：mtime 兜底口径（行上没有 timestamp → 按文件 mtime 计入窗口）
// ───────────────────────────────────────────────
const noTsDir = join(agentDir, "sessions", "--fixture-nots--");
mkdirSync(noTsDir, { recursive: true });
const oldMs = now - 3 * DAY;
const noTsFile = join(noTsDir, "2026-10-16T02-00-00-000Z_fixture-nots.jsonl");
// 老式消息行：无外层 timestamp —— 只能靠 mtime 近似（用 JSON.stringify 写成合法块）
writeFileSync(noTsFile, [
  JSON.stringify({ type: "session", id: "fixture-nots", cwd: "/fixture", timestamp: iso(oldMs) }),
  JSON.stringify({
    type: "message",
    message: { role: "user", content: [{ type: "text", text: skillBlock("eta-docs", globalSkillPath("eta-docs")) }] },
  }),
].join("\n") + "\n", "utf8");
utimesSync(noTsFile, oldMs, oldMs);
const mod3 = await jiti3.import("../lib/skill-usage.ts");
mod3.resetSkillUsageCacheForTest();
const c = mod3.aggregateSkillUsage();
check("场景C · 无 timestamp 行按 mtime 兜底（3 天前 → 7/30 天窗内）", () => {
  eq(c.recent.days7["eta-docs"], 1);
  eq(c.recent.days30["eta-docs"], 1);
});

// ───────────────────────────────────────────────
// 场景 D：顾问纯函数（概览 / 高频榜 / 吃灰清单）
// ───────────────────────────────────────────────
const entry = (name, state, useCount, lastUsedAt = null, addedAt = null) => ({
  name, state, useCount, lastUsedAt, addedAt,
  filePath: `/fixture/${name}/SKILL.md`, baseDir: `/fixture/${name}`, source: "", scope: "global", reason: "",
});
const usageMock = (recent) => ({
  total: recent ? Object.values(recent.days30).reduce((s, n) => s + n, 0) : 0,
  skills: [], lastUsed: {}, recent,
});

check("场景D · 概览读数与 idle 计数", () => {
  const report = buildSkillAdvisorReport(
    { entries: [entry("alpha-helper", "active", 12), entry("beta-scanner", "stale", 2, iso(now - 20 * DAY)), entry("gamma-agent", "unused", 0)] },
    usageMock({ at: iso(now), days7: { "alpha-helper": 3 }, days30: { "alpha-helper": 4, "beta-scanner": 1 }, total7: 3, total30: 5 }),
  );
  eq(report.overview, {
    totalSkills: 3, active: 1, stale: 1, unused: 1, idle: 1,
    totalCalls: 5, calls7: 3, calls30: 5,
  });
});

check("场景D · 吃灰过滤：stale 但近30天仍用 → 不进清单", () => {
  // beta-scanner 分层为 stale（最近一次 20 天前），但 30 天窗口有 1 次调用 → 残值，不建议归档
  const report = buildSkillAdvisorReport(
    { entries: [entry("beta-scanner", "stale", 2, iso(now - 20 * DAY))] },
    usageMock({ at: iso(now), days7: {}, days30: { "beta-scanner": 1 }, total7: 0, total30: 1 }),
  );
  eq(report.idle, []);
});

check("场景D · 吃灰清单：建议动作与原因直通界面", () => {
  const reason = "已有 45 天没调用过";
  // reason 与 lifecycle 分层时同源（由 buildSkillLifecycle 注入），顾问层只负责透传
  const report = buildSkillAdvisorReport(
    { entries: [{ ...entry("gamma-agent", "unused", 0, null, iso(now - 45 * DAY)), reason }] },
    usageMock({ at: iso(now), days7: {}, days30: {}, total7: 0, total30: 0 }),
  );
  eq(report.idle, [{
    name: "gamma-agent", state: "unused", reason,
    lastUsedAt: null, addedAt: iso(now - 45 * DAY), suggestedAction: "archive",
  }]);
});

check("场景D · 高频榜：降序 + cap + 窗口径", () => {
  const entries = Array.from({ length: HOT_LIMIT + 2 }, (_, i) => entry(`hot-${i}`, "active", HOT_LIMIT + 2 - i, iso(now)));
  const report = buildSkillAdvisorReport(
    { entries },
    usageMock({ at: iso(now), days7: { "hot-0": 9 }, days30: { "hot-0": 10 }, total7: 9, total30: 10 }),
  );
  eq(report.hot.length, HOT_LIMIT, `高频榜 cap = ${HOT_LIMIT}`);
  eq(report.hot[0], { name: "hot-0", count: HOT_LIMIT + 2, count7: 9, count30: 10, lastUsedAt: iso(now) });
  // 排行第二的吃灰门槛外（active），高频榜不要求窗口内有调用
  eq(report.hot[1].name, "hot-1");
});

check("场景D · 高频榜不上历史已归档技能", () => {
  // lifecycle.entries 只含当前装着的技能——历史调用计数不在榜（归档的 ghost 不复活）
  const report = buildSkillAdvisorReport(
    { entries: [entry("alpha-helper", "active", 3)] },
    usageMock({ at: iso(now), days7: {}, days30: {}, total7: 0, total30: 0 }),
  );
  eq(report.hot.map((h) => h.name), ["alpha-helper"]);
});

check("场景D · 高频榜优先用 usage.entries，带 scope/project/key（项目技能可上榜）", () => {
  // 归因层（模块 4 尾巴轮）：有 entries 时不再从已安装技能里取，而是直接用与 total
  // 同口径的读数条目 —— 项目技能（不在安装枚举里）因此可见；键/域带 additive 字段
  const report = buildSkillAdvisorReport(
    { entries: [entry("alpha-helper", "active", 1)] },
    {
      total: 5,
      recent: { at: iso(now), days7: {}, days30: {}, total7: 0, total30: 0 },
      entries: [
        { key: "global:alpha-helper", name: "alpha-helper", scope: "global", count: 1, command: 1, read: 0, count7: 0, count30: 1, lastUsedAt: iso(now) },
        { key: "project:proj-x:proj-skill", name: "proj-skill", scope: "project", project: "proj-x", count: 4, command: 0, read: 4, count7: 0, count30: 4, lastUsedAt: iso(now) },
      ],
    },
  );
  eq(report.hot.map((h) => h.key), ["project:proj-x:proj-skill", "global:alpha-helper"]);
  eq(report.hot[0].scope, "project", "项目技能带 scope=project");
  eq(report.hot[0].project, "proj-x", "项目技能带项目标识");
  eq(report.hot[1].scope, "global");
});

check("场景D · 空数据：全零且不抛", () => {
  const report = buildSkillAdvisorReport({ entries: [] }, usageMock({ at: iso(now), days7: {}, days30: {}, total7: 0, total30: 0 }));
  eq(report.overview, { totalSkills: 0, active: 0, stale: 0, unused: 0, idle: 0, totalCalls: 0, calls7: 0, calls30: 0 });
  eq(report.hot, []);
  eq(report.idle, []);
});

check("场景D · 老数据兼容：无 recent 字段时全部退化为零窗口口径", () => {
  const report = buildSkillAdvisorReport(
    { entries: [entry("alpha-helper", "active", 5), entry("beta-scanner", "stale", 1)] },
    // 模拟 2026-10-16 之前的响应：没有 recent
    { total: 6, skills: [], lastUsed: {} },
  );
  eq(report.overview.totalCalls, 6);
  eq(report.overview.calls7, 0);
  eq(report.overview.calls30, 0);
  eq(report.hot[0], { name: "alpha-helper", count: 5, count7: 0, count30: 0, lastUsedAt: null });
  // stale 且窗口读数为 0 → 进吃灰清单（能拿到建议，只是读不到窗口）
  eq(report.idle.length, 1);
});

check("场景D · suggestedAction 只可能是 archive", () => {
  const report = buildSkillAdvisorReport(
    { entries: [entry("gamma-agent", "unused", 0), entry("beta-scanner", "stale", 1)] },
    usageMock({ at: iso(now), days7: {}, days30: {}, total7: 0, total30: 0 }),
  );
  for (const item of report.idle) eq(item.suggestedAction, "archive");
});

// ───────────────────────────────────────────────
// 场景 E：仓库边界（.gitignore 白名单 / API 契约「只增不改」静态核对）
// ───────────────────────────────────────────────
const { readFileSync } = await import("node:fs");
check("场景E · .gitignore 白名单已放行本自测", () => {
  const gitignore = readFileSync(new URL("../.gitignore", import.meta.url), "utf8");
  if (!gitignore.includes("!tools/skill-advisor-selftest.mjs")) throw new Error("白名单缺 !tools/skill-advisor-selftest.mjs");
});
check("场景E · /api/skill-usage 契约「只增不改」", () => {
  const route = readFileSync(new URL("../app/api/skill-usage/route.ts", import.meta.url), "utf8");
  if (!route.includes("aggregateSkillUsage()")) throw new Error("route 未直接返回聚合结果");
  if (route.includes("recent:") || route.includes("delete ")) throw new Error("route 不应字段级改写响应");
});
check("场景E · 归因新增字段 additive（entries 在类型与顾问层都接上）", () => {
  const usageSource = readFileSync(new URL("../lib/skill-usage.ts", import.meta.url), "utf8");
  if (!usageSource.includes("entries: SkillUsageEntry[]")) throw new Error("SkillUsageReport 缺 additive 字段 entries");
  const advisorSource = readFileSync(new URL("../lib/skill-advisor.ts", import.meta.url), "utf8");
  if (!advisorSource.includes("usage.entries")) throw new Error("顾问层未消费 entries（项目技能上不了榜）");
});

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
