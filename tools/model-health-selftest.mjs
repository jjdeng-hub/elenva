// 模型健康面板（模块 6 · 第 3 轮）的自检：
// 纯函数层（成功率 / 状态阈值 / 近期失败边界 / 重试接管退化）
// + 扫描层（聚合 / 窗口 / aborted 排除 / context_edit 重试标记 / 脏行 / 旧文件 mtime 跳过 / 空数据）
// + 缓存（60s 命中 + 显式清缓存重扫）
// + 路由层（GET 契约）
// + 调用点静态核对（模型页新节 / 设为默认链路 / .gitignore 白名单）。
// 运行：node tools/model-health-selftest.mjs
//
// 隔离：PI_CODING_AGENT_DIR 指向 mkdtemp 出来的临时目录，全用**虚构**数据，不碰真实 ~/.pi/agent。
// lib/*.ts 是纯 TS（无 JSX），jiti 可直载（见记忆 F1/F3）；.mjs 必须放仓库内才 resolve 到 jiti。
import { createJiti } from "jiti";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "elenva-model-health-selftest-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const lib = await jiti.import("../lib/model-health.ts");
const {
  aggregateModelHealth,
  classifyModelHealth,
  hasRecentFailure,
  resetModelHealthCacheForTest,
  MODEL_HEALTH_WINDOW_DAYS,
  MODEL_HEALTH_RECENT_FAILURE_DAYS,
} = lib;

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

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-16T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

const sessionsRoot = join(agentDir, "sessions");

function resetSessions() {
  rmSync(sessionsRoot, { recursive: true, force: true });
  mkdirSync(sessionsRoot, { recursive: true });
  resetModelHealthCacheForTest();
}

function writeSession(project, file, entries) {
  const dir = join(sessionsRoot, project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

/** 造一条虚构 assistant 消息行（字段贴近真实落盘形态：entry 带 id/timestamp，message 带 provider/model/stopReason） */
function assistant(id, { provider, model, stopReason, atMs, errorMessage }) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: iso(atMs),
    message: {
      role: "assistant",
      content: stopReason === "error" ? [] : [{ type: "text", text: "虚构回复" }],
      provider,
      model,
      stopReason,
      ...(errorMessage ? { errorMessage } : {}),
    },
  };
}

const header = (id) => ({ type: "session", id, cwd: "/home/demo/pi-workspace", timestamp: iso(NOW - DAY) });

/** 找 report 里某个 key 的条目 */
const row = (report, key) => report.models.find((m) => m.key === key);

/* ---------------- 1. 纯函数：状态阈值与近期失败边界 ---------------- */

function makeEntry({ calls, failures, recoveredFailures = 0, rate, lastFailureAt }) {
  return {
    provider: "p",
    model: "m",
    key: "p/m",
    calls,
    failures,
    recoveredFailures,
    successRate: rate,
    status: "ok",
    lastCallAt: iso(NOW),
    lastFailureAt: lastFailureAt ?? null,
    lastError: lastFailureAt ? "虚构错误" : null,
  };
}

check("阈值：≥98% 正常 / 90–98% 不稳 / <90% 且近期失败 有故障", () => {
  eq(classifyModelHealth(makeEntry({ calls: 100, failures: 1, rate: 0.99 }), NOW), "ok", "99%");
  eq(classifyModelHealth(makeEntry({ calls: 100, failures: 2, rate: 0.98 }), NOW), "ok", "恰好 98%");
  eq(classifyModelHealth(makeEntry({ calls: 100, failures: 5, rate: 0.95 }), NOW), "unstable", "95%");
  eq(classifyModelHealth(makeEntry({ calls: 100, failures: 10, rate: 0.9 }), NOW), "unstable", "恰好 90%");
  eq(
    classifyModelHealth(makeEntry({ calls: 10, failures: 5, rate: 0.5, lastFailureAt: iso(NOW - HOUR) }), NOW),
    "failing",
    "50% + 近期失败",
  );
});

check("近期失败边界：7 天内算近期，超出则退为不稳", () => {
  const boundary = MODEL_HEALTH_RECENT_FAILURE_DAYS * DAY;
  assert(hasRecentFailure(makeEntry({ calls: 2, failures: 1, rate: 0.5, lastFailureAt: iso(NOW - boundary + 1000) }), NOW), "7 天内应算近期");
  assert(!hasRecentFailure(makeEntry({ calls: 2, failures: 1, rate: 0.5, lastFailureAt: iso(NOW - boundary - HOUR) }), NOW), "超过 7 天不算近期");
  eq(
    classifyModelHealth(makeEntry({ calls: 10, failures: 5, rate: 0.5, lastFailureAt: iso(NOW - 8 * DAY) }), NOW),
    "unstable",
    "低成功率但无近期失败 → 不稳",
  );
});

check("失败全被自动重试接管时，不判「有故障」", () => {
  eq(
    classifyModelHealth(
      makeEntry({ calls: 2, failures: 1, recoveredFailures: 1, rate: 0.5, lastFailureAt: iso(NOW - HOUR) }),
      NOW,
    ),
    "unstable",
    "重试已接管",
  );
  eq(
    classifyModelHealth(
      makeEntry({ calls: 3, failures: 2, recoveredFailures: 1, rate: 1 / 3, lastFailureAt: iso(NOW - HOUR) }),
      NOW,
    ),
    "failing",
    "仍有未接管的失败 → 有故障",
  );
  eq(classifyModelHealth(makeEntry({ calls: 0, failures: 0, rate: 1 }), NOW), "ok", "无调用 → 正常");
});

/* ---------------- 2. 扫描层：聚合 / 窗口 / 口径 ---------------- */

check("聚合：按 provider/model 计数，比率与状态正确", () => {
  resetSessions();
  writeSession("proj-a", "s1.jsonl", [
    header("s1"),
    assistant("a1", { provider: "alpha", model: "m1", stopReason: "stop", atMs: NOW - HOUR }),
    assistant("a2", { provider: "alpha", model: "m1", stopReason: "toolUse", atMs: NOW - 2 * HOUR }),
    assistant("a3", { provider: "alpha", model: "m1", stopReason: "error", atMs: NOW - 3 * HOUR, errorMessage: "Request timed out." }),
    assistant("b1", { provider: "beta", model: "m2", stopReason: "stop", atMs: NOW - 4 * HOUR }),
  ]);
  const report = aggregateModelHealth(NOW);
  eq(report.windowDays, MODEL_HEALTH_WINDOW_DAYS, "窗口天数");
  eq(report.totalCalls, 4, "总调用数");
  eq(report.totalFailures, 1, "总失败数");
  const alpha = row(report, "alpha/m1");
  eq(alpha.calls, 3, "alpha 调用数");
  eq(alpha.failures, 1, "alpha 失败数");
  assert(Math.abs(alpha.successRate - 2 / 3) < 1e-9, "alpha 成功率 2/3");
  eq(alpha.status, "failing", "alpha 状态");
  eq(alpha.lastError, "Request timed out.", "保留最近错误信息");
  eq(alpha.lastFailureAt, iso(NOW - 3 * HOUR), "最近失败时刻");
  const beta = row(report, "beta/m2");
  eq(beta.status, "ok", "beta 正常");
  eq(report.models[0].key, "alpha/m1", "有故障的排在前");
});

check("窗口：14 天外的消息不计入", () => {
  resetSessions();
  writeSession("proj-b", "s1.jsonl", [
    header("s2"),
    assistant("old", { provider: "alpha", model: "m1", stopReason: "error", atMs: NOW - 15 * DAY, errorMessage: "老错误" }),
    assistant("fresh", { provider: "alpha", model: "m1", stopReason: "stop", atMs: NOW - 13 * DAY }),
  ]);
  const report = aggregateModelHealth(NOW);
  const alpha = row(report, "alpha/m1");
  eq(alpha.calls, 1, "只计窗口内 1 次");
  eq(alpha.failures, 0, "窗口外失败不计");
  eq(alpha.status, "ok", "老失败不影响状态");
});

check("aborted（用户主动中断）不计入调用与失败", () => {
  resetSessions();
  writeSession("proj-c", "s1.jsonl", [
    header("s3"),
    assistant("x1", { provider: "alpha", model: "m1", stopReason: "stop", atMs: NOW - HOUR }),
    assistant("x2", { provider: "alpha", model: "m1", stopReason: "aborted", atMs: NOW - 2 * HOUR }),
  ]);
  const report = aggregateModelHealth(NOW);
  eq(report.totalCalls, 1, "aborted 不计调用");
  eq(row(report, "alpha/m1").status, "ok", "aborted 不算失败");
});

check("context_edit 摘除的失败记为「自动重试接管」", () => {
  resetSessions();
  writeSession("proj-d", "s1.jsonl", [
    header("s4"),
    assistant("g1", { provider: "gamma", model: "m3", stopReason: "stop", atMs: NOW - HOUR }),
    assistant("g2", { provider: "gamma", model: "m3", stopReason: "error", atMs: NOW - 2 * HOUR, errorMessage: "Streaming response failed" }),
    { type: "context_edit", id: "e1", parentId: "g2", timestamp: iso(NOW - 2 * HOUR), targetId: "g2", replacement: null },
  ]);
  const gamma = row(aggregateModelHealth(NOW), "gamma/m3");
  eq(gamma.calls, 2, "调用 2 次");
  eq(gamma.failures, 1, "失败 1 次");
  eq(gamma.recoveredFailures, 1, "被重试接管 1 次");
  eq(gamma.status, "unstable", "全被接管 → 不稳而非有故障");
});

check("脏行 / 半截 JSON 容错，不影响其余消息", () => {
  resetSessions();
  const dir = join(sessionsRoot, "proj-e");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "s1.jsonl"),
    [
      JSON.stringify(header("s5")),
      '{"type":"message","id":"broken","message":{',
      JSON.stringify(assistant("ok1", { provider: "delta", model: "m4", stopReason: "stop", atMs: NOW - HOUR })),
      "not json at all",
      JSON.stringify(assistant("ok2", { provider: "delta", model: "m4", stopReason: "error", atMs: NOW - 2 * HOUR, errorMessage: "x" })),
    ].join("\n") + "\n",
    "utf8",
  );
  const delta = row(aggregateModelHealth(NOW), "delta/m4");
  eq(delta.calls, 2, "有效行仍被统计");
  eq(delta.failures, 1, "失败仍被统计");
});

check("14 天没写过的旧文件按 mtime 跳过（不解析）", () => {
  resetSessions();
  writeSession("proj-f", "s1.jsonl", [
    header("s6"),
    // 消息时间戳在窗口内，但把文件 mtime 改成 20 天前 → 应被跳过
    assistant("h1", { provider: "epsilon", model: "m5", stopReason: "error", atMs: NOW - HOUR, errorMessage: "被跳过的失败" }),
  ]);
  const old = (NOW - 20 * DAY) / 1000;
  utimesSync(join(sessionsRoot, "proj-f", "s1.jsonl"), old, old);
  const report = aggregateModelHealth(NOW);
  eq(report.models.length, 0, "旧文件被跳过");
});

check("空数据：无会话目录 / 无调用 → 空报告而非报错", () => {
  resetSessions();
  const report = aggregateModelHealth(NOW);
  eq(report.models.length, 0, "空列表");
  eq(report.totalCalls, 0, "零调用");
  eq(report.totalFailures, 0, "零失败");
});

/* ---------------- 3. 缓存 ---------------- */

check("60s 缓存命中；显式清缓存后重扫", () => {
  resetSessions();
  writeSession("proj-g", "s1.jsonl", [
    header("s7"),
    assistant("c1", { provider: "alpha", model: "m1", stopReason: "stop", atMs: NOW - HOUR }),
  ]);
  const first = aggregateModelHealth(NOW);
  const second = aggregateModelHealth(NOW + 1000);
  assert(first === second, "TTL 内应返回同一份缓存");
  resetModelHealthCacheForTest();
  const third = aggregateModelHealth(NOW + 1000);
  assert(first !== third, "清缓存后应重扫");
  eq(third.totalCalls, 1, "重扫结果一致");
});

/* ---------------- 4. 路由层 ---------------- */

const route = await jiti.import("../app/api/model-health/route.ts");

check("GET /api/model-health 返回报告契约", async () => {
  resetSessions();
  writeSession("proj-h", "s1.jsonl", [
    header("s8"),
    assistant("r1", { provider: "alpha", model: "m1", stopReason: "stop", atMs: NOW - HOUR }),
  ]);
  const res = await route.GET();
  eq(res.status, 200, "HTTP 200");
  eq(res.headers.get("Cache-Control"), "no-store", "不缓存响应");
  const data = await res.json();
  assert(Array.isArray(data.models), "models 是数组");
  eq(typeof data.at, "string", "at 为 ISO 字符串");
  eq(data.windowDays, MODEL_HEALTH_WINDOW_DAYS, "窗口天数透出");
  eq(data.models[0].key, "alpha/m1", "路由与扫描器同源");
});

/* ---------------- 5. 调用点静态核对 ---------------- */

const readSource = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

check("路由只读：导出 GET，无写入方法", () => {
  const source = readSource("app/api/model-health/route.ts");
  assert(/export async function GET\(/.test(source), "应导出 GET");
  assert(!/export async function (POST|PUT|DELETE|PATCH)\(/.test(source), "不应有写方法");
  assert(/aggregateModelHealth/.test(source), "应调用扫描器");
});

check("模型页：健康节渲染 + 状态 chip + 设为默认走既有设置链", () => {
  const source = readSource("components/ModelsPage.tsx");
  assert(/function ModelHealthSection\(/.test(source), "应有健康节组件");
  // 变体 C 后健康节常态折叠（数据下沉到模型行），但组件仍必须挂在页面上、
  // 仍要按状态条那套口径拿故障数（failingCount），不能变成没人渲染的死代码。
  assert(/<ModelHealthSection[\s\S]{0,240}failingCount=\{library\.failing\}/.test(source), "页面应渲染健康节并传入故障数");
  assert(/故障已标在对应模型行/.test(source), "折叠态应说明故障标去哪了");
  assert(/健康 · 近 14 天/.test(source), "应有标题");
  assert(/fetch\("\/api\/model-health"/.test(source), "应取 /api/model-health");
  assert(/chip-success/.test(source) && /chip-warn/.test(source) && /chip-danger/.test(source), "三档状态 chip");
  assert(/设为默认/.test(source), "应提供设为默认动作");
  assert(/method: "PUT"/.test(source) && /\/api\/pi-settings/.test(source), "设为默认应走 /api/pi-settings");
  assert(/没有模型调用记录/.test(source), "应有空态文案");
  assert(/未列延迟/.test(source), "应说明为何不做延迟");
});

check(".gitignore 白名单包含本自测（随仓库分发，非本机夹具）", () => {
  const source = readSource(".gitignore");
  assert(/!tools\/model-health-selftest\.mjs/.test(source), "应加入白名单");
});

rmSync(root, { recursive: true, force: true });

console.log(fail === 0 ? "\n全部通过" : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
