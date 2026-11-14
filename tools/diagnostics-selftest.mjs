// 诊断输出的自检：lib/diagnostics.ts（脱敏 / 错误展开 / 时间戳 / 行格式）
// + lib/agent-liveness.ts（空闲看门狗判定与文案）
// + lib/agent-event-connection.ts（失败现场拼装、重连状态上报）。
// 运行：node tools/diagnostics-selftest.mjs
//
// 为什么要这些用例：「连不上 / 发消息没反应」以前只能看到
// 「Timed out starting the agent session. Please try again.」——
// 这里把「能定位问题的那几项」（哪一步、状态码、等了多久、试了几次、现场参数）
// 钉成回归，避免以后又被简化回一句无用文案。
//
// 隔离：全部用虚构数据，不读 ~/.pi/agent，不发任何网络请求。
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const {
  formatTimestamp,
  formatFieldValue,
  describeError,
  formatDiagnosticLine,
} = await jiti.import("../lib/diagnostics.ts");
const {
  assessLiveness,
  formatNoEventNotice,
  formatStalledNotice,
  AGENT_IDLE_WARN_MS,
  AGENT_IDLE_STALL_MS,
} = await jiti.import("../lib/agent-liveness.ts");
const {
  AgentEventConnection,
  AgentEventConnectionError,
  decorateConnectionMessage,
} = await jiti.import("../lib/agent-event-connection.ts");

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
const checkAsync = async (name, fn) => {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
};
const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};
const includes = (haystack, needle, message) =>
  assert(String(haystack).includes(needle), `${message}（实际：${haystack}）`);
const excludes = (haystack, needle, message) =>
  assert(!String(haystack).includes(needle), `${message}（实际：${haystack}）`);

/* ---------------- 1. 时间戳：排查第一个要回答的就是「哪一刻」 ---------------- */

check("formatTimestamp 是带时区偏移的本地时间", () => {
  const text = formatTimestamp(new Date(2026, 9, 18, 8, 23, 6, 123));
  assert(
    /^2026-10-18T08:23:06\.123[+-]\d{2}:\d{2}$/.test(text),
    `格式不符：${text}`,
  );
});

/* ---------------- 2. 脱敏：API key 曾经被原样打进终端 ---------------- */

check("敏感字段名一律脱敏（含常见变体）", () => {
  const secret = "oc_sk_fc05b2c4e69c_YYiqLHbFjgKJNqEEC6G9JdQwRo6Lp6Px";
  for (const key of ["apiKey", "api_key", "key", "token", "secret", "password", "Authorization", "cookie"]) {
    const out = formatFieldValue(key, secret);
    excludes(out, secret, `${key} 泄漏了原文`);
    includes(out, "***", `${key} 未脱敏`);
  }
});

check("脱敏后仍保留长度线索（便于判断是不是填错/被截断）", () => {
  const out = formatFieldValue("apiKey", "abcdefghij");
  includes(out, "10", "没有留下长度线索");
});

check("嵌套对象里的敏感键也脱敏", () => {
  const out = formatFieldValue("headers", { authorization: "Bearer sk-live-1234567890", accept: "text/plain" });
  excludes(out, "sk-live-1234567890", "嵌套 key 泄漏");
  includes(out, "text/plain", "非敏感字段被误删");
});

check("非敏感字段原样保留", () => {
  assert(formatFieldValue("model", "deepseek-v4.1-flash") === "deepseek-v4.1-flash", "普通字符串被改了");
  assert(formatFieldValue("status", 500) === "500", "数字被改了");
  assert(formatFieldValue("ok", false) === "false", "布尔被改了");
});

check("超长值截断，避免整坨 payload 刷屏", () => {
  const out = formatFieldValue("body", "x".repeat(1000));
  assert(out.length < 1000, `未截断：${out.length}`);
  includes(out, "…(+", "截断标记缺失");
});

/* ---------------- 3. describeError：状态码 / 异常类型要能看出来 ---------------- */

check("普通 Error 展开成「类型: 消息」", () => {
  assert(describeError(new Error("boom")) === "Error: boom", describeError(new Error("boom")));
});

check("带 code / status 的错误把状态码带出来", () => {
  const error = Object.assign(new Error("Request failed"), { code: "prompt_rejected", status: 500 });
  const text = describeError(error);
  includes(text, "Request failed", "丢了消息");
  includes(text, "code=prompt_rejected", "丢了 code");
  includes(text, "status=500", "丢了状态码");
});

check("cause 链最多展开 3 层", () => {
  const root = new Error("connection refused");
  const mid = new Error("fetch failed", { cause: root });
  const top = new Error("upstream error", { cause: mid });
  const text = describeError(top);
  includes(text, "cause(1)=", "未展开第一层 cause");
  includes(text, "connection refused", "丢了根因");
});

check("非 Error 输入也能描述", () => {
  assert(describeError("plain string") === "plain string", describeError("plain string"));
  assert(describeError(null) === "无错误对象", describeError(null));
  assert(describeError(undefined) === "无错误对象", describeError(undefined));
});

check("formatDiagnosticLine 一行内包含 scope / 消息 / 字段 / 错误", () => {
  const line = formatDiagnosticLine({
    scope: "session-start",
    message: "会话启动失败",
    fields: { sessionId: "01a14c61", cwd: "/root/pi-workspace" },
    error: Object.assign(new Error("api key expired"), { status: 401 }),
    now: new Date(2026, 9, 18, 8, 23, 6, 123),
  });
  includes(line, "[elenva][2026-10-18T08:23:06.123", "缺时间戳");
  includes(line, "[session-start]", "缺作用域");
  includes(line, "会话启动失败", "缺消息");
  includes(line, "sessionId=01a14c61", "缺关键参数");
  includes(line, "status=401", "缺状态码");
});

/* ---------------- 4. 空闲看门狗：判定必须卡在阈值上 ---------------- */

check("活动正常时判定为 fresh", () => {
  const now = 1_000_000;
  const r = assessLiveness({ startedAt: now - 5_000, lastEventAt: now - 1_000, now });
  assert(r.state === "fresh", `期望 fresh，实际 ${r.state}`);
  assert(r.idleMs === 1_000, `idleMs 应为 1000，实际 ${r.idleMs}`);
  assert(r.sawAnyEvent === true, "sawAnyEvent 应为 true");
});

check("达到 warn 阈值即判 idle（边界取等号）", () => {
  const now = 1_000_000;
  const r = assessLiveness({ startedAt: now - AGENT_IDLE_WARN_MS, lastEventAt: null, now });
  assert(r.state === "idle", `期望 idle，实际 ${r.state}`);
  assert(r.sawAnyEvent === false, "一个事件都没收到时 sawAnyEvent 应为 false");
});

check("达到 stall 阈值即判 stalled", () => {
  const now = 1_000_000;
  const r = assessLiveness({ startedAt: now - AGENT_IDLE_STALL_MS, lastEventAt: null, now });
  assert(r.state === "stalled", `期望 stalled，实际 ${r.state}`);
});

check("有事件时按「距最近一次事件」判定，而不是按开始时间", () => {
  const now = 1_000_000;
  const r = assessLiveness({
    startedAt: now - AGENT_IDLE_STALL_MS * 3,
    lastEventAt: now - 1_000,
    now,
  });
  assert(r.state === "fresh", `刚收到过事件不应判卡死，实际 ${r.state}`);
});

check("阈值可注入（便于按真实延迟调整）", () => {
  const now = 1_000_000;
  const r = assessLiveness({ startedAt: now - 100, lastEventAt: null, now }, { warnMs: 50, stallMs: 80 });
  assert(r.state === "stalled", `期望 stalled，实际 ${r.state}`);
});

check("时间倒流（时钟回拨）不会产生负数", () => {
  const r = assessLiveness({ startedAt: 2_000, lastEventAt: 3_000, now: 1_000 });
  assert(r.idleMs >= 0 && r.elapsedMs >= 0, `出现负数：${JSON.stringify(r)}`);
});

/* ---------------- 5. 看门狗文案：要说清「卡在哪一步、等了多久」 ---------------- */

check("「一条事件都没收到」的提示带出时长、阶段与连接状态", () => {
  const now = 1_000_000;
  const assessment = assessLiveness({ startedAt: now - 90_000, lastEventAt: null, now });
  const text = formatNoEventNotice({ assessment, phaseLabel: "正在连接内核…", connectionLabel: "重连中（第 2 次）" });
  includes(text, "90s", "缺等待时长");
  includes(text, "正在连接内核…", "缺当前阶段");
  includes(text, "重连中（第 2 次）", "缺连接状态");
});

check("判定 stalled 时给出「可能是哪一种」与下一步", () => {
  const now = 1_000_000;
  const assessment = assessLiveness({ startedAt: now - AGENT_IDLE_STALL_MS, lastEventAt: null, now });
  const text = formatNoEventNotice({ assessment, phaseLabel: "等待模型…" });
  includes(text, "静默卡死", "未给出卡死判断");
  includes(text, "ELENVA_DIAG", "未给出服务端排查入口");
});

check("未达 stall 时不武断下「卡死」结论", () => {
  const now = 1_000_000;
  const assessment = assessLiveness({ startedAt: now - AGENT_IDLE_WARN_MS, lastEventAt: null, now });
  const text = formatNoEventNotice({ assessment, phaseLabel: "等待模型…" });
  includes(text, "尚未判定为卡死", "缺少「还没到卡死」的说明");
});

check("收到过事件后又停住，提示距上一次事件多久", () => {
  const now = 1_000_000;
  const assessment = assessLiveness({ startedAt: now - 400_000, lastEventAt: now - 200_000, now });
  const text = formatStalledNotice({ assessment, phaseLabel: "工具执行中 · bash" });
  includes(text, "200s", "缺「距上次事件」时长");
  includes(text, "工具执行中 · bash", "缺阶段");
});

/* ---------------- 6. 失败现场拼装 ---------------- */

check("decorateConnectionMessage 把现场信息拼成一句话", () => {
  const text = decorateConnectionMessage("无法连接智能体事件流", {
    stage: "session_start",
    attempt: 3,
    elapsedMs: 12_340,
    serverDetail: "Error: 401 api_key_expired",
  });
  includes(text, "session_start", "缺失败阶段");
  includes(text, "第 3 次", "缺尝试次数");
  includes(text, "12.3s", "缺等待时长");
  includes(text, "api_key_expired", "缺服务端细节");
});

check("首次尝试不啰嗦地写「第 1 次」", () => {
  const text = decorateConnectionMessage("无法连接智能体事件流", { attempt: 1, elapsedMs: 500 });
  excludes(text, "第 1 次", "首次尝试不该写次数");
  includes(text, "0.5s", "缺等待时长");
});

/* ---------------- 7. 真实走一遍连接类：失败要能被说清 ---------------- */

function createFakeSource() {
  return {
    // 真实 EventSource 连上后 readyState 会变成 OPEN(1)；ensureConnected 会据此复检，
    // 夹具不模拟这一点就会永远停在 CONNECTING。
    readyState: 1,
    onmessage: null,
    onerror: null,
    closed: false,
    close() {
      this.closed = true;
      this.readyState = 2;
    },
    emit(payload) {
      this.onmessage?.({ data: JSON.stringify(payload) });
    },
  };
}

function createHarness(options = {}) {
  const sources = [];
  const statuses = [];
  const events = [];
  const connection = new AgentEventConnection({
    createSource: () => {
      const source = createFakeSource();
      sources.push(source);
      return source;
    },
    onEvent: (event) => events.push(event),
    shouldMaintain: () => true,
    readinessTimeoutMs: options.readinessTimeoutMs ?? 50,
    reconnectDelayMs: options.reconnectDelayMs ?? 5,
    onStatus: (info) => statuses.push(info),
  });
  return { connection, sources, statuses, events };
}

const expectReject = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("期望 reject，实际 resolve");
};

await checkAsync("startup_error：报出失败阶段与服务端细节，且停止重连", async () => {
  const { connection, sources, statuses } = createHarness({ readinessTimeoutMs: 1_000 });
  const pending = connection.ensureConnected("sess-1");
  // 让 open() 先跑完，source 才存在
  await Promise.resolve();
  sources[0].emit({
    type: "startup_error",
    errorMessage: "Failed to start agent: api key expired",
    stage: "session_start",
    errorDetail: "Error: 401 api_key_expired",
    waitMs: 1_234,
  });
  const error = await expectReject(pending);
  assert(error instanceof AgentEventConnectionError, `错误类型不对：${error}`);
  assert(error.status === "startup_error", `status 应为 startup_error，实际 ${error.status}`);
  includes(error.message, "session_start", "提示里缺失败阶段");
  includes(error.message, "api_key_expired", "提示里缺服务端细节");
  includes(error.message, "1.2s", "提示里缺等待时长");
  const failed = statuses.find((item) => item.phase === "failed");
  assert(failed !== undefined, "未上报 failed 状态");
  assert(sources[0].closed === true, "失败后应关闭该 source");
  connection.close();
});

await checkAsync("静默无响应：ready_timeout 报出等了多久、第几次尝试", async () => {
  const { connection, statuses } = createHarness({ readinessTimeoutMs: 30, reconnectDelayMs: 5 });
  const pending = connection.ensureConnected("sess-2");
  const error = await expectReject(pending);
  assert(error instanceof AgentEventConnectionError, `错误类型不对：${error}`);
  assert(error.status === "ready_timeout", `status 应为 ready_timeout，实际 ${error.status}`);
  includes(error.message, "已等待", "提示里缺等待时长");
  includes(error.message, "超时", "未说明是超时");
  // 「第几次尝试」这类结构化现场进 detail（首次连接不啰嗦地写「第 1 次」，见纯函数用例）
  assert(error.detail.attempt === 1, `未记录尝试次数：${JSON.stringify(error.detail)}`);
  assert(error.detail.idleMs === null, `一个事件都没收到时应记 idleMs=null：${JSON.stringify(error.detail)}`);
  assert(error.detail.elapsedMs !== undefined && error.detail.elapsedMs > 0, "未记录等待时长");
  const retrying = statuses.find((item) => item.phase === "retrying");
  assert(retrying !== undefined, "未上报 retrying 状态（界面就看不到「正在重连」）");
  connection.close();
});

await checkAsync("连上后：重连计数归零，正常事件照常转发", async () => {
  const { connection, sources, statuses, events } = createHarness();
  const pending = connection.ensureConnected("sess-3");
  await Promise.resolve();
  sources[0].emit({ type: "connected", sessionId: "sess-3", isStreaming: false });
  await pending;
  sources[0].emit({ type: "agent_start" });
  // connected 本身也会转发给 onEvent（useAgentSession 的 handleAgentEvent 有对应分支），
  // 这里把「原样转发、不吞事件」一并钉住。
  assert(
    events.length === 2 && events[0].type === "connected" && events[1].type === "agent_start",
    `事件未原样转发：${JSON.stringify(events)}`,
  );
  assert(statuses.length === 0, `首次连接成功不该报状态：${JSON.stringify(statuses)}`);
  connection.close();
});

console.log(fail === 0 ? "\nSELFTEST: OK" : `\nSELFTEST: ${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
