// 节律核心引擎（lib/schedules.ts）的自检：
// computeNextRunAt 各形态与边界（跨分钟 / 天 / 周；* * * * *；每天 at=当前分钟；
// weekly 同日已过）+ cron 解析（宏 / 范围 / 步长 / 列表 / 非法 / 永不命中）+
// 校验（名称 / 内容 / cwd / schedule / 上限 / safety / timeout）+ 存储容错
// （读写往返 / 坏条丢弃 / 缺失返回空 / 0600 权限）。
// 运行：node tools/schedules-selftest.mjs
//
// 隔离：PI_CODING_AGENT_DIR 指向 mkdtemp 出来的临时目录，全用**虚构**数据，
// 不碰真实 ~/.pi/agent。lib/schedules.ts 是纯 TS（无 JSX），jiti 可直载（见记忆 F1/F3）。
import { createJiti } from "jiti";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "elenva-schedules-selftest-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const lib = await jiti.import("../lib/schedules.ts");
const {
  computeNextRunAt,
  nextRunAtForTask,
  parseCronExpr,
  describeSchedule,
  cronExprError,
  validateSchedule,
  assertScheduleRunnable,
  listScheduleTasks,
  createScheduleTask,
  updateScheduleTask,
  deleteScheduleTask,
  getScheduleTask,
  markScheduleFired,
  recordScheduleRun,
  getSchedulesPath,
  SCHEDULE_NAME_MAX,
  SCHEDULE_PROMPT_MAX,
  MAX_SCHEDULES,
  RUN_HISTORY_CAP,
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
const eq = (actual, expected, message) =>
  assert(actual === expected, `${message}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
const throws = (fn, message) => {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw, message);
};

/** 本地时间构造 ISO（computeNextRunAt 按本地时区，断言也按本地取回） */
const at = (y, mo, d, h, mi, s = 0) => new Date(y, mo - 1, d, h, mi, s).toISOString();
const parts = (iso) => {
  const date = new Date(iso);
  return {
    y: date.getFullYear(),
    mo: date.getMonth() + 1,
    d: date.getDate(),
    h: date.getHours(),
    mi: date.getMinutes(),
    dow: date.getDay(),
  };
};
const expectParts = (iso, expected, message) => {
  const actual = parts(iso);
  for (const key of Object.keys(expected)) {
    eq(actual[key], expected[key], `${message} · ${key}`);
  }
};

/* ============================ computeNextRunAt ============================ */

check("hourly：同小时内下一个整点分钟", () => {
  expectParts(computeNextRunAt({ kind: "hourly", minute: 45 }, at(2026, 1, 5, 10, 30)), { y: 2026, mo: 1, d: 5, h: 10, mi: 45 }, "hourly 同小时");
});

check("hourly：该分钟已过 → 下一小时", () => {
  expectParts(computeNextRunAt({ kind: "hourly", minute: 15 }, at(2026, 1, 5, 10, 30)), { d: 5, h: 11, mi: 15 }, "hourly 已过");
});

check("hourly：起点正好在整点分钟 → 顺延一小时", () => {
  expectParts(computeNextRunAt({ kind: "hourly", minute: 15 }, at(2026, 1, 5, 10, 15)), { d: 5, h: 11, mi: 15 }, "hourly 边界");
});

check("hourly：跨午夜（23:50 的下一个 05 分在次日 00:05）", () => {
  expectParts(computeNextRunAt({ kind: "hourly", minute: 5 }, at(2026, 1, 5, 23, 50)), { d: 6, h: 0, mi: 5 }, "hourly 跨天");
});

check("daily：今天时间点未到 → 今天", () => {
  expectParts(computeNextRunAt({ kind: "daily", at: "18:00" }, at(2026, 1, 5, 10, 30)), { d: 5, h: 18, mi: 0 }, "daily 今天");
});

check("daily：起点正好等于时间点 → 明天（严格晚于）", () => {
  expectParts(computeNextRunAt({ kind: "daily", at: "10:30" }, at(2026, 1, 5, 10, 30)), { d: 6, h: 10, mi: 30 }, "daily 同日已到");
});

check("daily：跨月边界", () => {
  expectParts(computeNextRunAt({ kind: "daily", at: "09:00" }, at(2026, 1, 31, 10, 0)), { mo: 2, d: 1, h: 9, mi: 0 }, "daily 跨月");
});

check("weekly：同星期几当天已过 → 下周", () => {
  // 2026-01-05 是周一（weekday 1）
  expectParts(computeNextRunAt({ kind: "weekly", weekday: 1, at: "09:00" }, at(2026, 1, 5, 10, 0)), { d: 12, h: 9, mi: 0, dow: 1 }, "weekly 下周");
});

check("weekly：同星期几当天未到 → 今天", () => {
  expectParts(computeNextRunAt({ kind: "weekly", weekday: 1, at: "09:00" }, at(2026, 1, 5, 8, 0)), { d: 5, h: 9, mi: 0, dow: 1 }, "weekly 今天");
});

check("weekly：不同星期几 → 本周内最近的", () => {
  // 起点 2026-01-04 周日 → 下一个周一 01-05
  expectParts(computeNextRunAt({ kind: "weekly", weekday: 1, at: "09:00" }, at(2026, 1, 4, 10, 0)), { d: 5, h: 9, mi: 0, dow: 1 }, "weekly 本周");
});

/* ============================ cron 解析 ============================ */

check("cron：* * * * * 最小颗粒 = 每分钟（+1 分钟）", () => {
  expectParts(computeNextRunAt({ kind: "cron", expr: "* * * * *" }, at(2026, 1, 5, 10, 30, 20)), { d: 5, h: 10, mi: 31 }, "cron 每分钟");
});

check("cron：*/15 步长", () => {
  expectParts(computeNextRunAt({ kind: "cron", expr: "*/15 * * * *" }, at(2026, 1, 5, 10, 31)), { h: 10, mi: 45 }, "cron 步长");
});

check("cron：分钟范围 + 小时范围", () => {
  expectParts(computeNextRunAt({ kind: "cron", expr: "0 9-17 * * *" }, at(2026, 1, 5, 10, 31)), { h: 11, mi: 0 }, "cron 范围");
});

check("cron：逗号列表（8 点与 20 点）", () => {
  expectParts(computeNextRunAt({ kind: "cron", expr: "0 8,20 * * *" }, at(2026, 1, 5, 10, 0)), { h: 20, mi: 0 }, "cron 列表");
});

check("cron：周字段（周一 08:30，起点周一 10:00 → 下周一）", () => {
  expectParts(computeNextRunAt({ kind: "cron", expr: "30 8 * * 1" }, at(2026, 1, 5, 10, 0)), { d: 12, dow: 1, h: 8, mi: 30 }, "cron 周");
});

check("cron：日 / 周都受限时取「或」（13 日或周五，最近是 1/9 周五）", () => {
  expectParts(computeNextRunAt({ kind: "cron", expr: "0 0 13 * 5" }, at(2026, 1, 5, 10, 0)), { d: 9, dow: 5, h: 0, mi: 0 }, "cron 日周或");
});

check("cron：7 视作周日（与 0 等价）", () => {
  expectParts(computeNextRunAt({ kind: "cron", expr: "0 0 * * 7" }, at(2026, 1, 5, 10, 0)), { d: 11, dow: 0 }, "cron 周日别名");
});

check("cron：永不命中（2 月 31 日）→ 抛错", () => {
  throws(() => computeNextRunAt({ kind: "cron", expr: "0 0 31 2 *" }, at(2026, 1, 5, 10, 0)), "应拒绝永不命中的 cron");
});

check("cron：非法字段 → 抛错（分钟 60 / 六字段 / 宏 / 名称）", () => {
  throws(() => parseCronExpr("60 * * * *"), "分钟 60 应拒绝");
  throws(() => parseCronExpr("* * * * * *"), "六字段应拒绝");
  throws(() => parseCronExpr("@daily"), "宏应拒绝");
  throws(() => parseCronExpr("0 0 * * MON"), "星期的名称应拒绝");
  throws(() => parseCronExpr("* * 0 * *"), "日为 0 应拒绝");
});

/* ============================ 校验 ============================ */

check("validateSchedule：daily at=25:00 拒绝", () => {
  throws(() => validateSchedule({ kind: "daily", at: "25:00" }), "25:00 应拒绝");
  throws(() => validateSchedule({ kind: "weekly", weekday: 7, at: "09:00" }), "weekday=7 应拒绝");
});

check("assertScheduleRunnable：能算出下一跳才算可用", () => {
  assertScheduleRunnable({ kind: "daily", at: "09:00" }, at(2026, 1, 5, 8, 0));
});

const makeInput = (overrides = {}) => ({
  name: "虚构日报",
  prompt: "汇总今天的虚构进展",
  cwd: agentDir,
  schedule: { kind: "daily", at: "09:00" },
  ...overrides,
});

check("createScheduleTask：空名称 / 超长名称 / 空内容拒绝", () => {
  throws(() => createScheduleTask(makeInput({ name: "   " })), "空名称应拒绝");
  throws(() => createScheduleTask(makeInput({ name: "x".repeat(SCHEDULE_NAME_MAX + 1) })), "超长名称应拒绝");
  throws(() => createScheduleTask(makeInput({ prompt: " " })), "空内容应拒绝");
  throws(() => createScheduleTask(makeInput({ prompt: "x".repeat(SCHEDULE_PROMPT_MAX + 1) })), "超长内容应拒绝");
});

check("createScheduleTask：cwd 不存在 / 相对路径拒绝", () => {
  throws(() => createScheduleTask(makeInput({ cwd: join(root, "does-not-exist") })), "不存在的工作区应拒绝");
  throws(() => createScheduleTask(makeInput({ cwd: "relative/dir" })), "相对路径应拒绝");
});

check("createScheduleTask：safety / timeout 非法拒绝", () => {
  throws(() => createScheduleTask(makeInput({ safety: "yolo" })), "非法 safety 应拒绝");
  throws(() => createScheduleTask(makeInput({ timeoutMinutes: 0 })), "0 分钟超时应拒绝");
  throws(() => createScheduleTask(makeInput({ timeoutMinutes: 2000 })), "超上限应拒绝");
});

/* ============================ 存储 ============================ */

check("存储：缺失文件 → 空列表", () => {
  rmSync(getSchedulesPath(), { force: true });
  eq(listScheduleTasks().length, 0, "缺文件应为空");
});

check("存储：create → get → update → delete 往返", () => {
  const created = createScheduleTask(makeInput({ catchUp: true, timeoutMinutes: 30 }));
  assert(created.id.startsWith("sched-"), "id 前缀");
  eq(getScheduleTask(created.id)?.name, "虚构日报", "创建后可取");
  const updated = updateScheduleTask(created.id, { enabled: false, name: "虚构周报" });
  eq(updated.enabled, false, "enabled 切换");
  eq(getScheduleTask(created.id)?.name, "虚构周报", "改名落盘");
  eq(getScheduleTask(created.id)?.catchUp, true, "未改字段保留");
  eq(getScheduleTask(created.id)?.timeoutMinutes, 30, "超时保留");
  deleteScheduleTask(created.id);
  eq(getScheduleTask(created.id), undefined, "删除后取不到");
  eq(listScheduleTasks().length, 0, "删除后为空");
});

check("存储：markScheduleFired / recordScheduleRun 写回", () => {
  const task = createScheduleTask(makeInput());
  const firedAt = at(2026, 1, 6, 9, 0);
  markScheduleFired(task.id, firedAt);
  eq(getScheduleTask(task.id)?.lastFiredAt, firedAt, "lastFiredAt 落盘");
  recordScheduleRun(task.id, { at: firedAt, sessionId: "sess-1", result: "ok", note: "测试" });
  const stored = getScheduleTask(task.id);
  eq(stored?.lastRun?.result, "ok", "lastRun.result");
  eq(stored?.lastRun?.sessionId, "sess-1", "lastRun.sessionId");
  deleteScheduleTask(task.id);
});

check("存储：nextRunAtForTask 以 lastFiredAt 为起点", () => {
  const task = createScheduleTask(makeInput({ schedule: { kind: "daily", at: "09:00" } }));
  markScheduleFired(task.id, at(2026, 1, 6, 9, 0));
  expectParts(nextRunAtForTask(getScheduleTask(task.id)), { d: 7, h: 9, mi: 0 }, "从 lastFiredAt 推算");
  deleteScheduleTask(task.id);
});

check("存储：坏任务逐条丢弃（不因一条脏数据失效）", () => {
  const path = getSchedulesPath();
  const good = {
    id: "sched-good",
    name: "好的",
    enabled: true,
    schedule: { kind: "hourly", minute: 5 },
    prompt: "跑",
    cwd: agentDir,
    safety: "standard",
    catchUp: false,
    timeoutMinutes: null,
    createdAt: at(2026, 1, 1, 0, 0),
    updatedAt: at(2026, 1, 1, 0, 0),
  };
  writeFileSync(path, JSON.stringify({
    version: 1,
    tasks: [
      null,
      { id: "no-schedule", name: "x", prompt: "p", cwd: agentDir },
      { ...good, id: "bad-schedule", schedule: { kind: "daily", at: "99:99" } },
      { ...good, id: "empty-prompt", prompt: "  " },
      good,
    ],
  }), "utf8");
  const tasks = listScheduleTasks();
  eq(tasks.length, 1, "只留合法条目");
  eq(tasks[0].id, "sched-good", "留下的就是好的那条");
});

check("存储：损坏 JSON → 空列表（不抛）", () => {
  writeFileSync(getSchedulesPath(), "{ 这不是 JSON", "utf8");
  eq(listScheduleTasks().length, 0, "坏 JSON 应降级为空");
});

check("存储：原子写产物权限 0600", () => {
  rmSync(getSchedulesPath(), { force: true });
  createScheduleTask(makeInput({ cwd: agentDir }));
  const mode = statSync(getSchedulesPath()).mode & 0o777;
  eq(mode, 0o600, "文件权限");
});

check("存储：任务总数上限 50", () => {
  const path = getSchedulesPath();
  const tasks = [];
  for (let i = 0; i < MAX_SCHEDULES; i++) {
    tasks.push({
      id: `sched-${i}`,
      name: `任务 ${i}`,
      enabled: true,
      schedule: { kind: "hourly", minute: i % 60 },
      prompt: "跑",
      cwd: agentDir,
      safety: "standard",
      catchUp: false,
      timeoutMinutes: null,
      createdAt: at(2026, 1, 1, 0, 0),
      updatedAt: at(2026, 1, 1, 0, 0),
    });
  }
  writeFileSync(path, JSON.stringify({ version: 1, tasks }), "utf8");
  throws(() => createScheduleTask(makeInput({ cwd: agentDir })), "第 51 条应拒绝");
});

/* ============================ describeSchedule / cronExprError ============================ */

check("describeSchedule：hourly / daily / weekly / cron 各形态", () => {
  eq(describeSchedule({ kind: "hourly", minute: 15 }), "每小时（第 15 分）", "hourly");
  eq(describeSchedule({ kind: "daily", at: "08:30" }), "每天 08:30", "daily");
  eq(describeSchedule({ kind: "daily", at: "9:05" }), "每天 09:05", "daily 补零");
  eq(describeSchedule({ kind: "weekly", weekday: 1, at: "09:00" }), "每周一 09:00", "weekly 周一");
  eq(describeSchedule({ kind: "weekly", weekday: 0, at: "09:00" }), "每周日 09:00", "weekly 周日=0");
  eq(describeSchedule({ kind: "weekly", weekday: 3, at: "20:00" }), "每周三 20:00", "weekly 周中");
  eq(describeSchedule({ kind: "cron", expr: "0 8 * * *" }), "cron：0 8 * * *", "cron");
});

check("describeSchedule：空 / 未知不抛错", () => {
  eq(describeSchedule(null), "未设置", "null");
  eq(describeSchedule(undefined), "未设置", "undefined");
  eq(describeSchedule({ kind: "bogus" }), "未知规则", "未知 kind");
});

check("cronExprError：合法返回 null，非法给出原因", () => {
  eq(cronExprError("*/15 9-17 * * 1"), null, "合法表达式");
  assert(cronExprError("60 * * * *"), "分钟 60 应有错误原因");
  assert(cronExprError("0 8 * *"), "缺字段应有错误原因");
});

/* ============================ runHistory ============================ */

check("runHistory：追加到头部（新→旧）且同步 lastRun", () => {
  rmSync(getSchedulesPath(), { force: true });
  const task = createScheduleTask(makeInput());
  recordScheduleRun(task.id, { at: at(2026, 2, 1, 9, 0), sessionId: "s1", result: "ok" });
  recordScheduleRun(task.id, { at: at(2026, 2, 2, 9, 0), sessionId: "s2", result: "failed", note: "虚构失败" });
  recordScheduleRun(task.id, { at: at(2026, 2, 3, 9, 0), sessionId: "s3", result: "skipped" });
  const stored = getScheduleTask(task.id);
  eq(stored.runHistory.length, 3, "历史条数");
  eq(stored.runHistory[0].sessionId, "s3", "最新在最前");
  eq(stored.runHistory[2].sessionId, "s1", "最旧在最后");
  eq(stored.runHistory[0].note, undefined, "无 note 不写");
  eq(stored.runHistory[1].note, "虚构失败", "note 保留");
  eq(stored.lastRun.sessionId, "s3", "lastRun 同步为最新");
  deleteScheduleTask(task.id);
});

check("runHistory：cap 20（超限丢最旧）", () => {
  const task = createScheduleTask(makeInput());
  for (let i = 1; i <= 25; i++) {
    recordScheduleRun(task.id, { at: at(2026, 3, 1, 0, i), sessionId: `s${i}`, result: "ok" });
  }
  const stored = getScheduleTask(task.id);
  eq(stored.runHistory.length, RUN_HISTORY_CAP, "截断到 cap");
  eq(stored.runHistory[0].sessionId, "s25", "头部仍是最新");
  eq(stored.runHistory[RUN_HISTORY_CAP - 1].sessionId, "s6", "最旧 5 条被丢弃");
  deleteScheduleTask(task.id);
});

check("runHistory：旧任务缺字段容错 + 坏条目逐条丢弃", () => {
  const legacy = {
    id: "sched-legacy",
    name: "旧任务",
    enabled: true,
    schedule: { kind: "hourly", minute: 7 },
    prompt: "跑",
    cwd: agentDir,
    safety: "standard",
    catchUp: false,
    timeoutMinutes: null,
    createdAt: at(2026, 1, 1, 0, 0),
    updatedAt: at(2026, 1, 1, 0, 0),
  };
  writeFileSync(getSchedulesPath(), JSON.stringify({ version: 1, tasks: [legacy] }), "utf8");
  eq(getScheduleTask("sched-legacy").runHistory, undefined, "缺字段不强行补");
  recordScheduleRun("sched-legacy", { at: at(2026, 1, 2, 7, 0), sessionId: "sx", result: "ok" });
  eq(getScheduleTask("sched-legacy").runHistory.length, 1, "旧任务第一次记录即建历史");

  const withBad = {
    ...legacy,
    runHistory: [
      { at: at(2026, 1, 3, 7, 0), sessionId: "good", result: "ok" },
      { at: at(2026, 1, 3, 8, 0), result: "ok" },
      { at: at(2026, 1, 3, 9, 0), sessionId: "bad-result", result: "yolo" },
      "nonsense",
    ],
  };
  writeFileSync(getSchedulesPath(), JSON.stringify({ version: 1, tasks: [withBad] }), "utf8");
  const hist = getScheduleTask("sched-legacy").runHistory;
  eq(hist.length, 1, "只留合法条目");
  eq(hist[0].sessionId, "good", "留下的是合法的");
});

check("runHistory：读盘时也按 cap 截断", () => {
  const entries = Array.from({ length: RUN_HISTORY_CAP + 10 }, (_, i) => ({
    at: at(2026, 4, 1, 0, i % 60),
    sessionId: `s${i}`,
    result: "ok",
  }));
  const task = {
    id: "sched-cap",
    name: "超长历史",
    enabled: true,
    schedule: { kind: "hourly", minute: 7 },
    prompt: "跑",
    cwd: agentDir,
    safety: "standard",
    catchUp: false,
    timeoutMinutes: null,
    runHistory: entries,
    createdAt: at(2026, 1, 1, 0, 0),
    updatedAt: at(2026, 1, 1, 0, 0),
  };
  writeFileSync(getSchedulesPath(), JSON.stringify({ version: 1, tasks: [task] }), "utf8");
  eq(getScheduleTask("sched-cap").runHistory.length, RUN_HISTORY_CAP, "读盘截断到 cap");
  rmSync(getSchedulesPath(), { force: true });
});

/* ============================ 收尾 ============================ */

try {
  rmSync(root, { recursive: true, force: true });
} catch {
  chmodSync(root, 0o700);
  rmSync(root, { recursive: true, force: true });
}

console.log(fail === 0 ? "\n全部通过" : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
