// 节律**执行链**回归（lib/scheduler.ts + lib/schedules.ts 的证据字段）。
//
// 模块 3 安全修复 C：`result: "ok"` 曾被界面显示成「成功」，但它实际只表示
// 「会话正常跑完」——工具报错、被护栏拦下、压根没跑检查，都可能是「正常结束」。
// 本夹具把运行层与验收层分开验证，并覆盖执行链边界：
//   ① 正常跑完：ok + 证据（跑过检查 1 次、无工具错误）
//   ② 工具出错后恢复：仍 ok，但证据里记下工具错误（不把可恢复错误判成整轮失败）
//   ③ 被护栏拦下：记 blocked，不计入 toolErrors
//   ④ prompt 错误：failed
//   ⑤ 超时：timeout（用假时钟推进 deadline，不真等一分钟）
//   ⑥ 启动失败：failed，不留下「运行中」幽灵
//   ⑦ 重复立即运行竞争：同 tick 两次触发只能启动一次会话（先复现、后加原子占位）
//   ⑧ 存储层：证据字段容错归一 + 旧记录无证据字段仍可读
//
// 隔离：PI_CODING_AGENT_DIR 指向 mkdtemp；会话执行链用测试注入器替换为假会话，
// **不创建真实 pi 会话**。运行：node tools/scheduler-runs-selftest.mjs
import { createJiti } from "jiti";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "elenva-scheduler-runs-selftest-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const scheduler = await jiti.import("../lib/scheduler.ts");
const schedules = await jiti.import("../lib/schedules.ts");
const {
  runScheduleTaskNow,
  reconcileRuns,
  isScheduleTaskRunning,
  getRunningScheduleTaskIds,
  setSchedulerSessionLauncherForTest,
} = scheduler;
const { createScheduleTask, getScheduleTask, getSchedulesPath } = schedules;

let fail = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS  ${name}`); }
  catch (error) { fail += 1; console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`); }
};
const assert = (cond, message) => { if (!cond) throw new Error(message); };

/** 假会话：手动 emit 事件、手动切 isRunning，不发真请求 */
function makeSession(sessionId) {
  const listeners = new Set();
  const state = { running: true, aborted: false, sends: [] };
  const session = {
    send: async (message) => {
      state.sends.push(message);
      if (message?.type === "abort") state.aborted = true;
      return {};
    },
    onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    isRunning: () => state.running,
  };
  return {
    session,
    realSessionId: sessionId,
    emit: (event) => { for (const listener of [...listeners]) listener(event); },
    setRunning: (value) => { state.running = value; },
    state,
  };
}

let taskSeq = 0;
function newTask(extra = {}) {
  taskSeq += 1;
  return createScheduleTask({
    name: `夹具任务${taskSeq}`,
    schedule: { kind: "daily", at: "09:00" },
    prompt: "只做勘察并汇报",
    cwd: root,
    ...extra,
  });
}
const lastRunOf = (id) => getScheduleTask(id)?.lastRun;

/**
 * 推进假时钟越过 3s 回收宽限期（RUN_REAP_GRACE_MS）后再回收，
 * 避免每个用例真等 3 秒。
 */
async function reap(offsetMs = 10_000) {
  const realNow = Date.now;
  Date.now = () => realNow() + offsetMs;
  try {
    await reconcileRuns();
  } finally {
    Date.now = realNow;
  }
}

const toolEnd = (toolCallId, toolName, { isError = false, text = "" } = {}) => ({
  type: "tool_execution_end",
  toolCallId,
  toolName,
  isError,
  result: isError && text ? { content: [{ type: "text", text }] } : { content: [{ type: "text", text: text || "ok" }] },
});
const toolStart = (toolCallId, toolName, args) => ({ type: "tool_execution_start", toolCallId, toolName, args });

// ── ① 正常跑完：ok + 检查证据 ──────────────────────────────────────────
{
  const task = newTask();
  const fake = makeSession("s-ok");
  setSchedulerSessionLauncherForTest(async () => ({ session: fake.session, realSessionId: fake.realSessionId }));
  const started = await runScheduleTaskNow(task.id);
  check("① 正常跑完：会话启动、进入运行中", () => {
    assert(started.started === true, `started=${JSON.stringify(started)}`);
    assert(isScheduleTaskRunning(task.id), "应在运行中");
    assert(getRunningScheduleTaskIds().has(task.id), "running 集合应含该任务");
  });
  fake.emit(toolStart("c1", "bash", { command: "node ./node_modules/typescript/bin/tsc --noEmit" }));
  fake.emit(toolEnd("c1", "bash", { isError: false, text: "0 errors" }));
  fake.setRunning(false);
  await reap();
  check("① 正常跑完：result=ok，证据记录检查动作", () => {
    const run = lastRunOf(task.id);
    assert(run?.result === "ok", `result=${run?.result}`);
    assert(run.evidence?.checksRan === 1, `checksRan=${run.evidence?.checksRan}`);
    assert(run.evidence?.checksFailed === 0, `checksFailed=${run.evidence?.checksFailed}`);
    assert(run.evidence?.lastCheckOk === true, `lastCheckOk=${run.evidence?.lastCheckOk}`);
    assert(run.evidence?.toolErrors === 0 && run.evidence?.blocked === 0, "不应有工具错误 / 拦截");
    assert(!isScheduleTaskRunning(task.id), "结束后不应仍标记运行中");
  });
}

// ── ② 工具出错后恢复：不判整轮失败，但证据留痕 ──────────────────────────
{
  const task = newTask();
  const fake = makeSession("s-recover");
  setSchedulerSessionLauncherForTest(async () => ({ session: fake.session, realSessionId: fake.realSessionId }));
  await runScheduleTaskNow(task.id);
  fake.emit(toolEnd("c1", "bash", { isError: true, text: "ENOENT: no such file or directory, open 'missing.txt'" }));
  fake.emit(toolEnd("c2", "read", { isError: false, text: "file contents" }));
  fake.setRunning(false);
  await reap();
  check("② 工具出错后恢复：仍走完（ok），错误单独留痕", () => {
    const run = lastRunOf(task.id);
    assert(run?.result === "ok", `可恢复工具错误不应判失败，实际 ${run?.result}`);
    assert(run.evidence?.toolErrors === 1, `toolErrors=${run.evidence?.toolErrors}`);
    assert(run.evidence?.checksRan === 0 && run.evidence?.lastCheckOk === null, "没跑检查应为 0 / null");
    assert(run.evidence?.sample?.[0]?.startsWith("bash:"), `sample=${JSON.stringify(run.evidence?.sample)}`);
  });
}

// ── ③ 被护栏拦下：记 blocked，不算工具错误 ──────────────────────────────
{
  const task = newTask();
  const fake = makeSession("s-blocked");
  setSchedulerSessionLauncherForTest(async () => ({ session: fake.session, realSessionId: fake.realSessionId }));
  await runScheduleTaskNow(task.id);
  fake.emit(toolEnd("c1", "write", { isError: true, text: "[只读] 该节律任务配置为只读模式：只做勘察与汇报。" }));
  fake.emit(toolEnd("c2", "bash", { isError: true, text: "[审批] 递归或强制删除文件 已加入待审批队列（第 1 项，未执行）。" }));
  fake.setRunning(false);
  await reap();
  check("③ 被护栏拦下：blocked 计数正确、不计入工具错误", () => {
    const run = lastRunOf(task.id);
    assert(run?.result === "ok", `result=${run?.result}`);
    assert(run.evidence?.blocked === 2, `blocked=${run.evidence?.blocked}`);
    assert(run.evidence?.toolErrors === 0, `toolErrors=${run.evidence?.toolErrors}`);
  });
}

// ── ④ prompt 错误：failed ───────────────────────────────────────────────
{
  const task = newTask();
  const fake = makeSession("s-prompt-error");
  setSchedulerSessionLauncherForTest(async () => ({ session: fake.session, realSessionId: fake.realSessionId }));
  await runScheduleTaskNow(task.id);
  fake.emit({ type: "prompt_error", errorMessage: "模型不可用（夹具）" });
  fake.setRunning(false);
  await reap();
  check("④ prompt 错误：failed，note 带原因", () => {
    const run = lastRunOf(task.id);
    assert(run?.result === "failed", `result=${run?.result}`);
    assert(run.note?.includes("模型不可用"), `note=${run.note}`);
  });
}

// ── ⑤ 超时：假时钟推进 deadline ─────────────────────────────────────────
{
  const task = newTask({ timeoutMinutes: 1 });
  const fake = makeSession("s-timeout");
  setSchedulerSessionLauncherForTest(async () => ({ session: fake.session, realSessionId: fake.realSessionId }));
  await runScheduleTaskNow(task.id);
  const realNow = Date.now;
  Date.now = () => realNow() + 120_000;
  try {
    await reconcileRuns(); // 越过 deadline → 请求中止
    fake.setRunning(false);
    await reconcileRuns(); // 回收为 timeout
  } finally {
    Date.now = realNow;
  }
  check("⑤ 超时：发送 abort 后回收为 timeout", () => {
    assert(fake.state.aborted === true, "应发送 abort");
    const run = lastRunOf(task.id);
    assert(run?.result === "timeout", `result=${run?.result}`);
    assert(run.note?.includes("超过 1 分钟"), `note=${run.note}`);
  });
}

// ── ⑥ 启动失败：failed，不留「运行中」幽灵 ──────────────────────────────
{
  const task = newTask();
  setSchedulerSessionLauncherForTest(async () => { throw new Error("无法创建会话（夹具）"); });
  const started = await runScheduleTaskNow(task.id);
  check("⑥ 启动失败：failed 且不留幽灵运行中", () => {
    assert(started.started === false, `started=${started.started}`);
    assert(started.note?.includes("创建会话失败"), `note=${started.note}`);
    assert(lastRunOf(task.id)?.result === "failed", `result=${lastRunOf(task.id)?.result}`);
    assert(!isScheduleTaskRunning(task.id), "启动失败后不应仍标记运行中");
  });
}

// ── ⑦ 重复立即运行竞争：同 tick 只能启动一次 ────────────────────────────
{
  const task = newTask();
  let launchCount = 0;
  const fake = makeSession("s-race");
  setSchedulerSessionLauncherForTest(async () => {
    launchCount += 1;
    return { session: fake.session, realSessionId: fake.realSessionId };
  });
  const first = runScheduleTaskNow(task.id);
  // 同步取快照：第一次触发应该已在「占位」窗口里（会话建好前就算运行中）。修复前
  // 这里会是 false（runs 里没有，也没有 pending），正好把竞争暴露成断言失败。
  const runningDuringPending = isScheduleTaskRunning(task.id);
  const second = runScheduleTaskNow(task.id);
  const [secondResult, firstResult] = await Promise.all([second, first]);
  check("⑦ 竞争：同 tick 两次触发只启动一次会话", () => {
    assert(runningDuringPending, "占位期间也应视为运行中");
    assert(secondResult.started === false, `第二次不应启动，实际 ${JSON.stringify(secondResult)}`);
    assert(secondResult.note?.includes("启动"), `note=${secondResult.note}`);
    assert(launchCount === 1, `会话启动次数应为 1，实际 ${launchCount}`);
  });
  fake.setRunning(false);
  await reap();
  check("⑦ 竞争：先启动的那次正常完成", () => {
    assert(firstResult.started === true, `started=${firstResult.started}`);
    assert(lastRunOf(task.id)?.result === "ok", `result=${lastRunOf(task.id)?.result}`);
    assert(!isScheduleTaskRunning(task.id), "结束后不应仍在运行");
  });
}

setSchedulerSessionLauncherForTest(null);

// ── ⑧ 存储层：证据容错 + 旧记录兼容 ─────────────────────────────────────
{
  const task = newTask();
  const file = getSchedulesPath();
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const target = raw.tasks.find((item) => item.id === task.id);
  // 故意塞坏证据（字符串计数 / 超长 sample）+ 一条无证据旧记录
  target.lastRun = {
    at: new Date().toISOString(), sessionId: "s-bad", result: "ok",
    evidence: { toolErrors: "三", blocked: -1, checksRan: 2.7, checksFailed: null, lastCheckOk: "yes", sample: ["a", "", "b", "c", "d"] },
  };
  target.runHistory = [
    { at: new Date().toISOString(), sessionId: "s-legacy", result: "ok", note: "旧记录无证据" },
    target.lastRun,
  ];
  writeFileSync(file, JSON.stringify(raw, null, 2));
  const reloaded = getScheduleTask(task.id);
  check("⑧ 存储层：坏证据归零、不丢任务；旧记录仍可读", () => {
    assert(reloaded !== undefined, "任务不应被丢弃");
    const evidence = reloaded.lastRun?.evidence;
    assert(evidence?.toolErrors === 0, `toolErrors=${evidence?.toolErrors}`);
    assert(evidence?.blocked === 0, `blocked=${evidence?.blocked}`);
    assert(evidence?.checksRan === 3, `checksRan=${evidence?.checksRan}`);
    assert(evidence?.lastCheckOk === null, `lastCheckOk=${evidence?.lastCheckOk}`);
    assert(evidence?.sample?.length === 3, `sample=${JSON.stringify(evidence?.sample)}`);
    const legacy = reloaded.runHistory?.find((run) => run.sessionId === "s-legacy");
    assert(legacy !== undefined && legacy.evidence === undefined, "旧记录应原样可读");
  });
}

setSchedulerSessionLauncherForTest(null);
rmSync(root, { recursive: true, force: true });
console.log(fail === 0 ? "\n全部通过" : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
