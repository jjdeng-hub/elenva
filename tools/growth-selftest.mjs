// 成长仪表（模块 7 · 第 4 轮）的自检：
// 周分桶（周一为起点 / 8 周窗口 / 窗口外与未来不计）
// + 失败口径（provider error 计、aborted 不计）+ 工具调用归轮 + 项目粗分组 + 会话跨周去重
// + 脏行容错 + 旧文件 mtime 跳过 + 空数据 + 60s 缓存 + 一句话读图（规则生成）
// + 路由契约（GET /api/growth）+ 调用点静态核对（成长页 / AppShell / 侧栏 / .gitignore 白名单）。
// 运行：node tools/growth-selftest.mjs
//
// 隔离：PI_CODING_AGENT_DIR 指向 mkdtemp 出来的临时目录，全用**虚构**数据，不碰真实 ~/.pi/agent。
// 时区固定 UTC，让「本地周一」可预期（周日历逻辑仍按宿主时区走，这里只锁测试基准）。
// .mjs 必须放仓库内才 resolve 到 jiti（见记忆 F1）；lib/*.ts 是纯 TS（无 JSX），jiti 可直载。
process.env.TZ = "UTC";

import { createJiti } from "jiti";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "elenva-growth-selftest-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const { aggregateGrowth, resetGrowthCacheForTest, summarizeGrowth, GROWTH_WINDOW_WEEKS } = await jiti.import(
  "../lib/growth-metrics.ts",
);

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
const eq = (actual, expected, message) => {
  if (actual !== expected) throw new Error(`${message}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
};
const near = (actual, expected, message) => {
  if (Math.abs(actual - expected) > 1e-9) {
    throw new Error(`${message}：期望 ${expected}，实际 ${actual}`);
  }
};

/* ---------------- 基准时刻与虚构时间轴（UTC） ---------------- */

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-16T12:00:00.000Z"); // 周五 → 本周一 2026-10-12
const CUR = Date.parse("2026-10-13T10:00:00.000Z"); // 本周二
const PREV = Date.parse("2026-10-06T10:00:00.000Z"); // 上周二
const TWO_AGO = Date.parse("2026-09-29T10:00:00.000Z"); // 两周前周二
const OUT = Date.parse("2026-08-11T10:00:00.000Z"); // 8 周窗口之外（窗口从 2026-08-24 起）
const iso = (ms) => new Date(ms).toISOString();

const sessionsRoot = join(agentDir, "sessions");

function resetSessions() {
  rmSync(sessionsRoot, { recursive: true, force: true });
  mkdirSync(sessionsRoot, { recursive: true });
  resetGrowthCacheForTest();
}

function writeSession(project, file, entries) {
  const dir = join(sessionsRoot, project);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  return path;
}

let uid = 0;
const header = (id, cwd) => ({ type: "session", id, cwd, timestamp: iso(NOW - 60 * DAY) });
const user = (atMs, text = "虚构任务") => ({
  type: "message",
  id: `u${++uid}`,
  parentId: null,
  timestamp: iso(atMs),
  message: { role: "user", content: [{ type: "text", text }], timestamp: atMs },
});
const assistant = (atMs, { stopReason = "stop", toolCalls = 0, errorMessage } = {}) => ({
  type: "message",
  id: `a${++uid}`,
  parentId: null,
  timestamp: iso(atMs),
  message: {
    role: "assistant",
    provider: "fake",
    model: "fake-1",
    stopReason,
    content: [
      ...Array.from({ length: toolCalls }, (_, i) => ({ type: "toolCall", toolCallId: `t${i}`, toolName: "bash", input: {} })),
      { type: "text", text: "虚构回复" },
    ],
    ...(errorMessage ? { errorMessage } : {}),
  },
});

const curWeek = (r) => r.weeks[r.weeks.length - 1];
const prevWeek = (r) => r.weeks[r.weeks.length - 2];
const proj = (r, label) => r.projects.find((p) => p.label === label);

/* ---------------- 1. 空数据 ---------------- */

check("空数据：8 个零桶 + empty 结论，而非报错", () => {
  resetSessions();
  const r = aggregateGrowth(NOW);
  eq(r.windowWeeks, GROWTH_WINDOW_WEEKS, "窗口周数");
  eq(r.weeks.length, 8, "8 个周桶");
  eq(r.weeks[0].weekStart, "2026-08-24", "最早一周（周一）");
  eq(r.weeks[7].weekStart, "2026-10-12", "本周一");
  eq(r.weeks[7].isCurrent, true, "最后一个是本周");
  eq(r.weeks[6].isCurrent, false, "上周不是本周");
  eq(r.totals.turns, 0, "无轮次");
  eq(r.totals.sessions, 0, "无任务");
  eq(r.projects.length, 0, "无项目");
  eq(r.headline.verdict, "empty", "结论为空");
  assert(/还没有可读的会话记录/.test(r.headline.text), "空态文案");
});

/* ---------------- 2. 分桶 / 轮次 / 工具调用 / 窗口 ---------------- */

check("按周分桶：轮次与工具调用归入正确周；窗口外不计", () => {
  resetSessions();
  writeSession("proj-a", "s1.jsonl", [
    header("s1", "/home/demo/pi-workspace"),
    user(CUR),
    assistant(CUR + HOUR, { toolCalls: 2 }),
    assistant(CUR + 2 * HOUR, { toolCalls: 1, stopReason: "toolUse" }),
    user(PREV),
    assistant(PREV + HOUR, {}),
    user(OUT),
    assistant(OUT + HOUR, { toolCalls: 5 }),
  ]);
  const r = aggregateGrowth(NOW);
  eq(curWeek(r).turns, 1, "本周轮次");
  eq(curWeek(r).toolCalls, 3, "本周工具调用");
  eq(curWeek(r).sessions, 1, "本周任务数");
  eq(curWeek(r).label, "10/12", "本周标签");
  eq(prevWeek(r).turns, 1, "上周轮次");
  eq(prevWeek(r).toolCalls, 0, "上周无工具调用");
  eq(r.totals.turns, 2, "窗口内共 2 轮（窗口外的 1 轮不计）");
  eq(r.totals.toolCalls, 3, "工具调用合计 3");
});

/* ---------------- 3. 失败口径 ---------------- */

check("失败口径：provider error 计失败；aborted 不计（即便带 errorMessage）", () => {
  resetSessions();
  writeSession("proj-fail", "s1.jsonl", [
    header("s2", "/srv/work/alpha"),
    // 失败轮
    user(CUR),
    assistant(CUR + HOUR, { stopReason: "error", errorMessage: "Request timed out." }),
    // 用户中断轮（带 errorMessage，但不算失败）
    user(CUR),
    assistant(CUR + HOUR, { stopReason: "aborted", errorMessage: "Request was aborted" }),
    // 正常轮
    user(CUR),
    assistant(CUR + HOUR, { stopReason: "toolUse", toolCalls: 1 }),
  ]);
  const r = aggregateGrowth(NOW);
  eq(curWeek(r).turns, 3, "3 轮");
  eq(curWeek(r).failedTurns, 1, "仅 1 轮失败");
  near(curWeek(r).failureRate, 1 / 3, "失败率 1/3");
  eq(r.totals.failedTurns, 1, "合计失败 1");
});

/* ---------------- 4. 项目粗分组 ---------------- */

check("项目分组：按 cwd 分组、末段为展示名、按轮次降序", () => {
  resetSessions();
  writeSession("proj-alpha", "a.jsonl", [
    header("sa", "/srv/work/alpha"),
    user(CUR),
    assistant(CUR + HOUR, {}),
    user(CUR),
    assistant(CUR + HOUR, {}),
    user(PREV),
    assistant(PREV + HOUR, {}),
  ]);
  writeSession("proj-beta", "b.jsonl", [
    header("sb", "/srv/work/beta"),
    user(CUR),
    assistant(CUR + HOUR, {}),
  ]);
  const r = aggregateGrowth(NOW);
  eq(r.projects.length, 2, "两个项目");
  eq(r.projects[0].label, "alpha", "轮次多的排前");
  eq(r.projects[0].project, "/srv/work/alpha", "保留完整 cwd");
  eq(r.projects[0].totals.turns, 3, "alpha 三轮");
  eq(r.projects[1].label, "beta", "beta 次之");
  eq(proj(r, "alpha").weeks.length, 8, "项目也有 8 周桶");
});

check("无 cwd 的旧会话归入 unknown（不丢账）", () => {
  resetSessions();
  writeSession("proj-x", "x.jsonl", [
    { type: "session", id: "sx", timestamp: iso(NOW - DAY) }, // 无 cwd
    user(CUR),
    assistant(CUR + HOUR, {}),
  ]);
  const r = aggregateGrowth(NOW);
  eq(proj(r, "未知").project, "unknown", "归入 unknown");
  eq(proj(r, "未知").totals.turns, 1, "轮次不丢");
});

/* ---------------- 5. 会话跨周去重 ---------------- */

check("跨周会话：每周各算一个任务；合计按会话 id 去重", () => {
  resetSessions();
  writeSession("proj-span", "span.jsonl", [
    header("ss", "/srv/work/span"),
    user(PREV),
    assistant(PREV + HOUR, {}),
    user(CUR),
    assistant(CUR + HOUR, {}),
  ]);
  const r = aggregateGrowth(NOW);
  eq(curWeek(r).sessions, 1, "本周 1 个任务");
  eq(prevWeek(r).sessions, 1, "上周 1 个任务");
  eq(r.totals.sessions, 1, "合计仍是同一个任务（去重）");
  near(r.totals.turnsPerSession, 2, "每任务 2 轮");
});

/* ---------------- 6. 脏行 / 旧文件 / 未来时间戳 ---------------- */

check("脏行 / 半截 JSON / 非 JSON 容错，不影响其余轮次", () => {
  resetSessions();
  const dir = join(sessionsRoot, "proj-dirty");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "s.jsonl"),
    [
      JSON.stringify(header("sd", "/srv/work/dirty")),
      '{"type":"message","id":"broken","message":{',
      JSON.stringify(user(CUR)),
      "not json at all",
      JSON.stringify(assistant(CUR + HOUR, {})),
      JSON.stringify(user(TWO_AGO)),
      JSON.stringify(assistant(TWO_AGO + HOUR, {})),
    ].join("\n") + "\n",
    "utf8",
  );
  const r = aggregateGrowth(NOW);
  eq(r.totals.turns, 2, "有效轮次仍被统计");
});

check("8 周没写过的旧文件按 mtime 跳过（不解析）", () => {
  resetSessions();
  const path = writeSession("proj-old", "old.jsonl", [header("so", "/srv/work/old"), user(CUR), assistant(CUR + HOUR, {})]);
  const old = (NOW - 60 * DAY) / 1000;
  utimesSync(path, old, old);
  const r = aggregateGrowth(NOW);
  eq(r.totals.turns, 0, "旧文件被跳过");
});

check("未来时间戳（下一周）不计入窗口", () => {
  resetSessions();
  writeSession("proj-future", "f.jsonl", [
    header("sf", "/srv/work/future"),
    user(NOW + 3 * DAY),
    assistant(NOW + 3 * DAY + HOUR, {}),
  ]);
  const r = aggregateGrowth(NOW);
  eq(r.totals.turns, 0, "未来轮次不计");
});

/* ---------------- 7. 缓存 ---------------- */

check("60s 缓存命中；显式清缓存后重扫", () => {
  resetSessions();
  writeSession("proj-cache", "c.jsonl", [header("sc", "/srv/work/cache"), user(CUR), assistant(CUR + HOUR, {})]);
  const first = aggregateGrowth(NOW);
  const second = aggregateGrowth(NOW + 1000);
  assert(first === second, "TTL 内应返回同一份缓存");
  resetGrowthCacheForTest();
  const third = aggregateGrowth(NOW + 1000);
  assert(first !== third, "清缓存后应重扫");
  eq(third.totals.turns, 1, "重扫结果一致");
});

/* ---------------- 8. 一句话读图（纯函数） ---------------- */

const wk = (weekStart, { turns, failedTurns = 0, sessions = turns, toolCalls = 0, isCurrent = false }) => ({
  weekStart,
  label: "x",
  isCurrent,
  sessions,
  turns,
  failedTurns,
  toolCalls,
  failureRate: turns > 0 ? failedTurns / turns : 0,
  turnsPerSession: sessions > 0 ? turns / sessions : 0,
  toolCallsPerSession: sessions > 0 ? toolCalls / sessions : 0,
});

check("读图：失败率下降 → 变顺；文案含 ↓ 与百分点", () => {
  const h = summarizeGrowth([wk("2026-10-05", { turns: 10, failedTurns: 1 }), wk("2026-10-12", { turns: 10, failedTurns: 0, isCurrent: true })]);
  eq(h.verdict, "smoother", "变顺");
  assert(/↓ 10\.0 个百分点/.test(h.text), `文案含下降幅度：${h.text}`);
});

check("读图：失败率上升 → 变钝", () => {
  const h = summarizeGrowth([wk("2026-10-05", { turns: 10, failedTurns: 1 }), wk("2026-10-12", { turns: 10, failedTurns: 3, isCurrent: true })]);
  eq(h.verdict, "blunter", "变钝");
  assert(/↑ 20\.0 个百分点/.test(h.text), `文案含上升幅度：${h.text}`);
});

check("读图：变化 <1 个百分点 → 持平", () => {
  const h = summarizeGrowth([wk("2026-10-05", { turns: 100, failedTurns: 10 }), wk("2026-10-12", { turns: 100, failedTurns: 11, isCurrent: true })]);
  eq(h.verdict, "flat", "持平");
  assert(/持平/.test(h.text), `文案含持平：${h.text}`);
});

check("读图：本周无轮次 → 数据不足；上周无记录 → 首周", () => {
  const empty = summarizeGrowth([wk("2026-10-05", { turns: 0, sessions: 0 }), wk("2026-10-12", { turns: 0, sessions: 0, isCurrent: true })]);
  eq(empty.verdict, "empty", "无数据");
  const fresh = summarizeGrowth([wk("2026-10-05", { turns: 0, sessions: 0 }), wk("2026-10-12", { turns: 4, failedTurns: 0, isCurrent: true })]);
  eq(fresh.verdict, "new", "首周");
  assert(/上周无记录/.test(fresh.text), `首周文案：${fresh.text}`);
});

/* ---------------- 9. 路由层 ---------------- */

const route = await jiti.import("../app/api/growth/route.ts");

check("GET /api/growth 返回报告契约", async () => {
  resetSessions();
  writeSession("proj-route", "r.jsonl", [
    header("sr", "/srv/work/route"),
    user(CUR),
    assistant(CUR + HOUR, { stopReason: "error", errorMessage: "虚构错误" }),
  ]);
  const res = await route.GET();
  eq(res.status, 200, "HTTP 200");
  eq(res.headers.get("Cache-Control"), "no-store", "不缓存响应");
  const data = await res.json();
  eq(data.weeks.length, 8, "8 周桶");
  eq(data.totals.turns, 1, "路由与扫描器同源");
  eq(typeof data.headline.text, "string", "透出一句话读图");
  eq(data.projects[0].label, "route", "项目粗分组透出");
});

/* ---------------- 10. 调用点静态核对 ---------------- */

const readSource = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

check("路由只读：导出 GET，无写入方法", () => {
  const source = readSource("app/api/growth/route.ts");
  assert(/export async function GET\(/.test(source), "应导出 GET");
  assert(!/export async function (POST|PUT|DELETE|PATCH)\(/.test(source), "不应有写方法");
  assert(/aggregateGrowth/.test(source), "应调用扫描器");
});

check("成长页：周趋势 + 一句话 + 项目表 + 口径说明", () => {
  const source = readSource("components/GrowthPage.tsx");
  assert(/fetch\("\/api\/growth"/.test(source), "应取 /api/growth");
  assert(/function WeekBars\(/.test(source), "应有周趋势柱状图");
  assert(/headline\?\.text/.test(source), "应渲染一句话读图");
  assert(/smoother/.test(source) && /blunter/.test(source), "应区分变顺 / 变钝");
  assert(/按项目 · 近 8 周/.test(source), "应有项目粗分组表");
  assert(/任务类型/.test(source), "应说明「任务类型」取舍");
  assert(/aborted 不计/.test(source), "应说明失败口径");
  assert(!/dark:/.test(source), "不应写 dark: 前缀（深色走变量）");
});

check("接入：AppShell 渲染 + 侧栏入口", () => {
  const shell = readSource("components/AppShell.tsx");
  assert(/import \{ GrowthPage \}/.test(shell), "AppShell 应引入成长页");
  assert(/view === "growth" && <GrowthPage \/>/.test(shell), "AppShell 应渲染成长页");
  assert(/growth: "成长"/.test(shell), "应有页面标题");
  const sidebar = readSource("components/WorkstationSidebar.tsx");
  assert(/\| "growth"/.test(sidebar), "侧栏 View 应含 growth");
  assert(/label="成长"/.test(sidebar), "侧栏应有成长入口");
});

check(".gitignore 白名单包含本自测（随仓库分发，非本机夹具）", () => {
  assert(/!tools\/growth-selftest\.mjs/.test(readSource(".gitignore")), "应加入白名单");
});

rmSync(root, { recursive: true, force: true });

console.log(fail === 0 ? "\n全部通过" : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
