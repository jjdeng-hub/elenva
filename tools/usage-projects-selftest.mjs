// 用量项目归因（lib/usage-aggregate.ts projects 字段）+ 周窗口口径的自检（模块 6 · 第 2 轮）：
// 会话头 cwd → projects 分组（同项目多文件合并 / 无头旧文件归 unknown / 空目录），
// 以及周预算（weeklyUsd）要用的「滚动 7 天」窗口 = days 末尾 7 项的求和口径。
// 运行：node tools/usage-projects-selftest.mjs
//
// 隔离：PI_CODING_AGENT_DIR 指向 mkdtemp 出来的临时目录，夹具全是**明显虚构**的
// 项目路径（/fixtures/proj-*）与花费数字，不碰真实 ~/.pi/agent（同 budget-guard-selftest）。
// lib/usage-aggregate.ts → session-reader.ts → pi SDK 均为纯 JS，jiti 可直载。
import { createJiti } from "jiti";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "elenva-usage-projects-selftest-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const { aggregateUsage } = await jiti.import("../lib/usage-aggregate.ts");

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
const near = (actual, expected, eps, message) =>
  assert(Math.abs(actual - expected) < eps, `${message}（期望 ≈${expected}，实际 ${actual}）`);

/** 造一个会话文件：首行会话头（可选 cwd）+ 一条带 usage/cost 的 assistant 消息 */
function fixtureSession(dir, name, { id, cwd, cost, tokens = 100, timestamp }) {
  mkdirSync(dir, { recursive: true });
  const header = { type: "session", id, ...(cwd ? { cwd } : {}), timestamp };
  const message = {
    type: "message",
    timestamp,
    message: {
      role: "assistant",
      provider: "fixture",
      model: `fixture-${id}`,
      usage: { input: tokens, output: tokens, cacheRead: 0, cacheWrite: 0, cost: { total: cost } },
    },
  };
  writeFileSync(join(dir, `${name}.jsonl`), `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`, "utf8");
}

const now = new Date().toISOString();
const sessionsDir = join(agentDir, "sessions");
// 夹具（虚构）：proj-a 两个文件共 $0.30；proj-b 一个文件 $0.20；无 cwd 的旧格式 $0.10
fixtureSession(join(sessionsDir, "proj-a-fixtures"), "a1", { id: "fx-a1", cwd: "/fixtures/proj-a", cost: 0.12, timestamp: now });
fixtureSession(join(sessionsDir, "proj-a-fixtures"), "a2", { id: "fx-a2", cwd: "/fixtures/proj-a", cost: 0.18, timestamp: now });
fixtureSession(join(sessionsDir, "proj-b-fixtures"), "b1", { id: "fx-b1", cwd: "/fixtures/proj-b", cost: 0.2, timestamp: now });
fixtureSession(join(sessionsDir, "legacy-fixtures"), "old", { id: "fx-old", cwd: undefined, cost: 0.1, timestamp: now });

const report = await aggregateUsage();

check("projects：按会话头 cwd 分组，同项目多文件合并", () => {
  const keys = Object.keys(report.projects).sort();
  assert(keys.includes("/fixtures/proj-a"), `应有 proj-a（实际 ${keys.join(", ")}）`);
  near(report.projects["/fixtures/proj-a"].cost, 0.3, 1e-9, "proj-a 成本 = 两文件之和");
  eq2(report.projects["/fixtures/proj-a"].sessions, 2, "proj-a 会话数");
});

check("projects：无会话头 cwd 的旧文件归 unknown，不丢账", () => {
  near(report.projects.unknown.cost, 0.1, 1e-9, "unknown 成本");
  eq2(report.projects.unknown.sessions, 1, "unknown 会话数");
});

check("projects：总账守恒 = Σ项目（含 unknown）= today = 滚动 7 天", () => {
  const projectSum = Object.values(report.projects).reduce((s, p) => s + p.cost, 0);
  near(projectSum, 0.6, 1e-9, "Σ项目");
  near(report.today.cost, 0.6, 1e-9, "today");
  // 周预算（weeklyUsd）的取数口径：days 末项恒为今日、零填充，末尾 7 项 = 滚动 7 天
  const weekly = report.days.slice(-7).reduce((s, d) => s + d.cost, 0);
  near(weekly, 0.6, 1e-9, "滚动 7 天（夹具全在今日）");
});

check("days：滚动 7 天窗口的锚点 = 今日，不锚周一对齐（与「近 14 日」同族）", () => {
  eq2(report.days.length, 84, "84 天零填充序列");
  eq2(report.days[report.days.length - 1].date, localToday(), "末项是今日");
  eq2(report.days[report.days.length - 7].date, localToday(Date.now() - 6 * 86400000), "7 天前是第 -7 项");
});

check("sessions：与 projects 同源不冲突（各会话成本之和 = Σ项目）", () => {
  const sessionSum = Object.values(report.sessions).reduce((s, u) => s + u.cost, 0);
  const projectSum = Object.values(report.projects).reduce((s, p) => s + p.cost, 0);
  near(sessionSum, projectSum, 1e-9, "两套口径守恒");
});

check("空数据：无 sessions 目录 → projects 为空对象不炸", async () => {
  rmSync(sessionsDir, { recursive: true, force: true });
  const empty = await aggregateUsage();
  eq2(Object.keys(empty.projects).length, 0, "projects 空对象");
  eq2(empty.today.cost, 0, "today = 0");
});

function eq2(actual, expected, message) {
  assert(actual === expected, `${message}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
}
function localToday(nowMs = Date.now()) {
  const d = new Date(nowMs);
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, "0")}-${`${d.getDate()}`.padStart(2, "0")}`;
}

rmSync(root, { recursive: true, force: true });

console.log(fail === 0 ? "\n全部通过" : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
