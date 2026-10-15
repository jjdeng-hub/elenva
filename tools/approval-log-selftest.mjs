// 审批决策日志（lib/approval-log.ts）的自检：
// 路径口径 / 追写 / 摘要截断 / 非法入参跳过 / 坏行容错 / 读取裁剪(上限 1000) /
// 过滤纯函数（decision / sessionId / all / 非法）/ limit 归一化 / 缺失文件 / 写失败不抛。
// 运行：node tools/approval-log-selftest.mjs
//
// 隔离：PI_CODING_AGENT_DIR 指向 mkdtemp 出来的临时目录，全用**虚构**数据，
// 不碰真实 ~/.pi/agent。lib/*.ts 是纯 TS（无 JSX），jiti 可直载（见记忆 F1/F3）。
import { createJiti } from "jiti";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "elenva-approval-log-selftest-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const lib = await jiti.import("../lib/approval-log.ts");
const {
  APPROVAL_LOG_FILE,
  DEFAULT_HISTORY_LIMIT,
  MAX_APPROVAL_LOG_ENTRIES,
  MAX_HISTORY_LIMIT,
  MAX_SUMMARY_CHARS,
  appendApprovalLog,
  filterApprovalEntries,
  getApprovalLogPath,
  normalizeLimit,
  parseApprovalLog,
  readApprovalLog,
  truncateSummary,
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

const logPath = () => join(agentDir, APPROVAL_LOG_FILE);
const clearLog = () => writeFileSync(logPath(), "", "utf8");
const readLines = () => readFileSync(logPath(), "utf8").split("\n").filter((line) => line.trim().length > 0);
/** 造一条合法的日志行（虚构数据） */
const line = (overrides = {}) =>
  JSON.stringify({
    ts: "2026-10-16T00:00:00.000Z",
    sessionId: "sess-demo",
    kind: "tool",
    tool: "bash",
    summary: "rm -rf /tmp/demo",
    decision: "denied",
    source: "dialog",
    ...overrides,
  });

/* ============================ 路径与写入 ============================ */

check("getApprovalLogPath 指向 agentDir 下的 jsonl", () => {
  eq(getApprovalLogPath(), logPath(), "路径口径");
  eq(APPROVAL_LOG_FILE, "elenva-approval-log.jsonl", "文件名");
});

check("追写一条：字段完整、ts 缺省为 ISO 时间", () => {
  clearLog();
  appendApprovalLog({
    sessionId: "sess-1",
    kind: "tool",
    tool: "bash",
    summary: "git push --force",
    decision: "denied",
    source: "dialog",
    reason: "强制推送会覆盖远端历史",
  });
  const lines = readLines();
  eq(lines.length, 1, "行数");
  const entry = JSON.parse(lines[0]);
  eq(entry.sessionId, "sess-1", "sessionId");
  eq(entry.kind, "tool", "kind");
  eq(entry.tool, "bash", "tool");
  eq(entry.summary, "git push --force", "summary");
  eq(entry.decision, "denied", "decision");
  eq(entry.source, "dialog", "source");
  eq(entry.reason, "强制推送会覆盖远端历史", "reason");
  assert(Number.isFinite(Date.parse(entry.ts)), `ts 应为可解析的时间（实际 ${entry.ts}）`);
});

check("无 reason 时不写 reason 字段（保持行紧凑）", () => {
  clearLog();
  appendApprovalLog({
    sessionId: "sess-1",
    kind: "tool",
    tool: "bash",
    summary: "ls",
    decision: "approved",
    source: "dialog",
  });
  const entry = JSON.parse(readLines()[0]);
  assert(!("reason" in entry), "reason 不该出现");
});

check("非法 kind / decision / source 静默跳过（不抛、不落盘）", () => {
  clearLog();
  appendApprovalLog({ kind: "other", tool: "bash", summary: "x", decision: "denied", source: "dialog" });
  appendApprovalLog({ kind: "tool", tool: "bash", summary: "x", decision: "maybe", source: "dialog" });
  appendApprovalLog({ kind: "tool", tool: "bash", summary: "x", decision: "denied", source: "telepathy" });
  eq(readLines().length, 0, "非法入参不写入");
});

check("摘要超长截断到 200 字（含省略号）", () => {
  eq(truncateSummary("a".repeat(500)).length, MAX_SUMMARY_CHARS, "截断长度");
  assert(truncateSummary("a".repeat(500)).endsWith("…"), "截断带省略号");
  eq(truncateSummary("  a\n b  "), "a b", "换行 / 空白归一");
  clearLog();
  appendApprovalLog({
    sessionId: "sess-1",
    kind: "tool",
    tool: "bash",
    summary: "x".repeat(1000),
    decision: "queued",
    source: "queue",
  });
  eq(JSON.parse(readLines()[0]).summary.length, MAX_SUMMARY_CHARS, "落盘的 summary 也被截断");
});

check("写失败不抛（agentDir 不存在时静默返回）", () => {
  const backup = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "does-not-exist");
  try {
    appendApprovalLog({
      sessionId: "sess-1",
      kind: "tool",
      tool: "bash",
      summary: "x",
      decision: "approved",
      source: "dialog",
    });
  } finally {
    process.env.PI_CODING_AGENT_DIR = backup;
  }
});

/* ============================ 解析与坏行 ============================ */

check("parseApprovalLog 跳过坏行 / 结构不对的行，保持文件顺序", () => {
  const raw = [
    line({ summary: "first" }),
    "",
    "这不是 JSON",
    "{\"broken\":",
    "[1,2,3]",
    JSON.stringify({ ts: "x", kind: "tool", tool: "bash", summary: "no-decision" }),
    JSON.stringify({ ts: "x", kind: "nope", tool: "bash", summary: "bad-kind", decision: "denied" }),
    line({ summary: "second" }),
  ].join("\n");
  const entries = parseApprovalLog(raw);
  eq(entries.length, 2, "只留两行好数据");
  eq(entries[0].summary, "first", "顺序 1");
  eq(entries[1].summary, "second", "顺序 2");
});

check("source 缺失 / 非法按 dialog 兜底（不丢整条记录）", () => {
  const parsed = parseApprovalLog(
    [line({ source: undefined }), line({ source: "unknown-source" })].join("\n"),
  );
  eq(parsed.length, 2, "两条都保留");
  eq(parsed[0].source, "dialog", "缺失兜底");
  eq(parsed[1].source, "dialog", "非法兜底");
});

check("文件缺失时读出空结果，不抛", () => {
  const backup = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "empty-agent-dir");
  try {
    const result = readApprovalLog();
    eq(result.total, 0, "total");
    eq(result.entries.length, 0, "entries");
  } finally {
    process.env.PI_CODING_AGENT_DIR = backup;
  }
});

/* ============================ 读取：裁剪 / 排序 / limit ============================ */

check("读取裁剪：只保留最近 1000 条（新→旧）", () => {
  const total = MAX_APPROVAL_LOG_ENTRIES + 200;
  const rows = [];
  for (let i = 0; i < total; i += 1) {
    rows.push(line({ summary: `第 ${i} 条`, sessionId: `sess-${i}` }));
  }
  writeFileSync(logPath(), `${rows.join("\n")}\n`, "utf8");
  const result = readApprovalLog({ limit: MAX_HISTORY_LIMIT });
  eq(result.total, MAX_APPROVAL_LOG_ENTRIES, "裁剪后的总数");
  eq(result.entries[0].summary, `第 ${total - 1} 条`, "最新一条在最前");
  const all = readApprovalLog({ limit: MAX_HISTORY_LIMIT });
  eq(all.entries.length, MAX_HISTORY_LIMIT, "limit 生效");
});

check("limit 归一化：缺省 50 / 上限 200 / 非法回默认", () => {
  eq(normalizeLimit(undefined), DEFAULT_HISTORY_LIMIT, "缺省");
  eq(normalizeLimit(null), DEFAULT_HISTORY_LIMIT, "null");
  eq(normalizeLimit("abc"), DEFAULT_HISTORY_LIMIT, "非法字符串");
  eq(normalizeLimit(0), DEFAULT_HISTORY_LIMIT, "0");
  eq(normalizeLimit(-3), DEFAULT_HISTORY_LIMIT, "负数");
  eq(normalizeLimit(9999), MAX_HISTORY_LIMIT, "上限");
  eq(normalizeLimit("5"), 5, "字符串数字");
  eq(normalizeLimit(12.9), 12, "取整");
});

check("total 是过滤后总数，entries 只给 limit 条", () => {
  clearLog();
  for (let i = 0; i < 8; i += 1) {
    appendApprovalLog({
      sessionId: `sess-${i}`,
      kind: "tool",
      tool: "bash",
      summary: `cmd ${i}`,
      decision: i % 2 === 0 ? "approved" : "denied",
      source: "dialog",
      ts: `2026-10-16T00:00:0${i}.000Z`,
    });
  }
  const result = readApprovalLog({ decision: "denied", limit: 2 });
  eq(result.total, 4, "拒绝总数");
  eq(result.entries.length, 2, "limit 生效");
  eq(result.entries[0].summary, "cmd 7", "最新的拒绝在最前");
});

/* ============================ 过滤纯函数 ============================ */

check("filterApprovalEntries：decision / sessionId / all / 组合 / 非法值", () => {
  const entries = [
    { ts: "t1", sessionId: "a", kind: "tool", tool: "bash", summary: "1", decision: "approved", source: "dialog" },
    { ts: "t2", sessionId: "a", kind: "tool", tool: "bash", summary: "2", decision: "denied", source: "dialog" },
    { ts: "t3", sessionId: "b", kind: "plan", tool: "present_plan", summary: "3", decision: "denied", source: "dialog" },
    { ts: "t4", sessionId: "b", kind: "tool", tool: "bash", summary: "4", decision: "timeout", source: "auto" },
  ];
  eq(filterApprovalEntries(entries, { decision: "denied" }).length, 2, "按 decision");
  eq(filterApprovalEntries(entries, { decision: "all" }).length, 4, "all 不筛");
  eq(filterApprovalEntries(entries, {}).length, 4, "空条件不筛");
  eq(filterApprovalEntries(entries, { decision: "不存在的值" }).length, 4, "非法 decision 不筛");
  eq(filterApprovalEntries(entries, { sessionId: "a" }).length, 2, "按 sessionId");
  eq(filterApprovalEntries(entries, { decision: "denied", sessionId: "b" }).length, 1, "组合");
  eq(filterApprovalEntries(entries, { sessionId: " a " }).length, 2, "sessionId trim");
  assert(entries.length === 4, "纯函数不改动入参");
});

/* ============================ 收尾 ============================ */

try {
  rmSync(root, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}
console.log(fail === 0 ? "\n全部通过" : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
