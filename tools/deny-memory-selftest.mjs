// 拒绝记忆（lib/deny-memory.ts）的自检：
// 纯函数（找最近同类决定 / 生成人话 / 拼接附注 / 读日志异常不抛 / 缺省键不误配）
// + 链路级（approval-log 的 ruleKey 写入 → 解析 → 匹配 → 附注，含排除当前会话）。
// 运行：node tools/deny-memory-selftest.mjs
//
// 隔离：PI_CODING_AGENT_DIR 指向 mkdtemp 出来的临时目录，全用**虚构**数据，
// 不碰真实 ~/.pi/agent。lib/*.ts 是纯 TS（无 JSX），jiti 可直载（见记忆 F1/F3）。
import { createJiti } from "jiti";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "elenva-deny-memory-selftest-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const {
  findLastDecision,
  describeLastDecision,
  appendLastDecisionNote,
  safeLastDecisionNote,
} = await jiti.import("../lib/deny-memory.ts");
const { appendApprovalLog, readApprovalLog } = await jiti.import("../lib/approval-log.ts");

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

// 用**本地时间**构造，避免时区差异影响「今天 / 昨天 / MM-DD」的判定
const now = new Date(2026, 9, 16, 15, 30); // 2026-10-16 15:30 本地
const tsToday = new Date(2026, 9, 16, 9, 12).toISOString();
const tsYesterday = new Date(2026, 9, 15, 9, 12).toISOString();
const tsOlder = new Date(2026, 9, 5, 9, 12).toISOString();

/** 造一条决定（虚构数据） */
const entry = (overrides = {}) => ({
  ts: tsToday,
  sessionId: "sess-a",
  kind: "tool",
  tool: "bash",
  summary: "rm -rf demo",
  decision: "denied",
  source: "dialog",
  reason: "递归或强制删除文件",
  ruleKey: "cmd:rm-rf",
  ...overrides,
});

/* ============================ 查找：同 ruleKey 的最近一条 ============================ */

check("无历史 / 空数组 → null", () => {
  eq(findLastDecision([], "cmd:rm-rf"), null, "空数组");
  eq(findLastDecision(null, "cmd:rm-rf"), null, "null 入参");
  eq(findLastDecision(undefined, "cmd:rm-rf"), null, "undefined 入参");
});

check("ruleKey 为空 / 非字符串 → null（缺省键不误配）", () => {
  const entries = [
    entry({ ruleKey: undefined, ts: tsOlder }),
    entry({ ruleKey: "k2", ts: tsToday }),
  ];
  eq(findLastDecision(entries, undefined), null, "undefined 键");
  eq(findLastDecision(entries, null), null, "null 键");
  eq(findLastDecision(entries, ""), null, "空串键");
  eq(findLastDecision(entries, "   "), null, "空白键");
});

check("同 ruleKey 选最新（与数组顺序无关）", () => {
  const older = entry({ ts: tsOlder, reason: "旧的一次" });
  const newer = entry({ ts: tsToday, reason: "新的一次" });
  eq(findLastDecision([older, newer], "cmd:rm-rf").reason, "新的一次", "旧→新");
  eq(findLastDecision([newer, older], "cmd:rm-rf").reason, "新的一次", "新→旧");
});

check("不同 ruleKey 不匹配；没有该键的历史不被拿来顶替", () => {
  const entries = [entry({ ruleKey: "path:dotenv" }), entry({ ruleKey: "cmd:rm-rf" })];
  eq(findLastDecision(entries, "path:auth"), null, "不存在的键");
  eq(findLastDecision(entries, "path:dotenv").ruleKey, "path:dotenv", "只取同名键");
});

check("ts 不可解析时按数组靠后者兜底（仍返回一条，不抛）", () => {
  const a = entry({ ts: "not-a-date", reason: "先" });
  const b = entry({ ts: "", reason: "后" });
  eq(findLastDecision([a, b], "cmd:rm-rf").reason, "后", "取靠后的");
});

check("排除当前会话（避免自指）", () => {
  const other = entry({ sessionId: "sess-b", ts: tsOlder, reason: "别的会话" });
  const self = entry({ sessionId: "sess-a", ts: tsToday, reason: "自己刚产生的" });
  eq(findLastDecision([other, self], "cmd:rm-rf", { excludeSessionId: "sess-a" }).reason, "别的会话", "排除自身后取更旧的");
  eq(findLastDecision([other, self], "cmd:rm-rf", { excludeSessionId: "sess-z" }).reason, "自己刚产生的", "无关会话不排除");
  eq(findLastDecision([self], "cmd:rm-rf", { excludeSessionId: "sess-a" }), null, "只剩自身 → null");
});

/* ============================ 人话：describeLastDecision ============================ */

check("无记录 → null", () => {
  eq(describeLastDecision(null, now), null, "null");
  eq(describeLastDecision(undefined, now), null, "undefined");
});

check("拒绝 + 原因：今天 / 昨天 / MM-DD 三种时间说法", () => {
  eq(
    describeLastDecision(entry({ ts: tsToday }), now),
    "上次同类操作：今天 09:12 被拒绝（递归或强制删除文件）",
    "今天",
  );
  eq(
    describeLastDecision(entry({ ts: tsYesterday }), now),
    "上次同类操作：昨天 09:12 被拒绝（递归或强制删除文件）",
    "昨天",
  );
  eq(
    describeLastDecision(entry({ ts: tsOlder }), now),
    "上次同类操作：10-05 09:12 被拒绝（递归或强制删除文件）",
    "更早（补零）",
  );
});

check("四种决定的措辞；批准 / 无原因不带括号", () => {
  eq(
    describeLastDecision(entry({ decision: "approved", reason: undefined }), now),
    "上次同类操作：今天 09:12 被批准",
    "批准",
  );
  eq(
    describeLastDecision(entry({ decision: "queued" }), now),
    "上次同类操作：今天 09:12 被加入待审批队列（递归或强制删除文件）",
    "入队",
  );
  eq(
    describeLastDecision(entry({ decision: "timeout" }), now),
    "上次同类操作：今天 09:12 超时未决定（递归或强制删除文件）",
    "超时",
  );
});

check("ts 不可解析 / 原因空白时的降级", () => {
  eq(describeLastDecision(entry({ ts: "bogus" }), now), "上次同类操作：被拒绝（递归或强制删除文件）", "无时间");
  eq(describeLastDecision(entry({ reason: "   " }), now), "上次同类操作：今天 09:12 被拒绝", "空白原因不写括号");
  eq(describeLastDecision(entry({ reason: undefined }), now), "上次同类操作：今天 09:12 被拒绝", "无原因");
});

/* ============================ 拼接：appendLastDecisionNote ============================ */

check("无附注原样返回，不产生多余空行", () => {
  eq(appendLastDecisionNote("原始文案", null), "原始文案", "null");
  eq(appendLastDecisionNote("原始文案", undefined), "原始文案", "undefined");
  eq(appendLastDecisionNote("原始文案", ""), "原始文案", "空串");
  eq(appendLastDecisionNote("原始文案", "   "), "原始文案", "空白");
});

check("有附注：追加在原文案之后、空行隔开", () => {
  const note = "上次同类操作：今天 09:12 被拒绝（递归或强制删除文件）";
  eq(appendLastDecisionNote("原始文案", note), `原始文案\n\n${note}`, "拼接");
  eq(appendLastDecisionNote("原始文案", `  ${note}  `), `原始文案\n\n${note}`, "去掉附注首尾空白");
});

/* ============================ 安全包：safeLastDecisionNote ============================ */

check("读日志抛异常时静默返回 null（不抛）", () => {
  const note = safeLastDecisionNote("cmd:rm-rf", () => {
    throw new Error("boom");
  });
  eq(note, null, "异常被吞");
});

check("空 ruleKey 直接返回 null，不读日志", () => {
  let called = false;
  const reader = () => {
    called = true;
    return [];
  };
  eq(safeLastDecisionNote("", reader), null, "空键");
  eq(safeLastDecisionNote(undefined, reader), null, "缺省键");
  eq(called, false, "reader 不该被调用");
});

check("正常路径：注入 reader + 排除当前会话", () => {
  const entries = [
    entry({ sessionId: "sess-b", ts: tsToday, reason: "别的会话的决定" }),
    entry({ sessionId: "sess-a", ts: tsToday, reason: "自己的" }),
  ];
  eq(
    safeLastDecisionNote("cmd:rm-rf", () => entries, { now, excludeSessionId: "sess-a" }),
    "上次同类操作：今天 09:12 被拒绝（别的会话的决定）",
    "排除自身后取别的会话",
  );
});

/* ============================ 链路级：approval-log 写入 → 解析 → 附注 ============================ */

check("ruleKey 能落盘、能解析回来（additive，老条目不受影响）", () => {
  appendApprovalLog({
    sessionId: "sess-link",
    kind: "tool",
    tool: "bash",
    summary: "rm -rf /tmp/demo",
    decision: "denied",
    source: "dialog",
    reason: "递归或强制删除文件",
    ruleKey: "cmd:rm-rf",
    ts: tsToday,
  });
  appendApprovalLog({
    sessionId: "sess-link",
    kind: "tool",
    tool: "bash",
    summary: "ls",
    decision: "approved",
    source: "dialog",
    ts: tsToday,
  });
  const { entries } = readApprovalLog({ limit: 50 });
  const denied = entries.find((item) => item.decision === "denied");
  const approved = entries.find((item) => item.decision === "approved");
  eq(denied.ruleKey, "cmd:rm-rf", "ruleKey 写入并在解析后保留");
  eq(approved.ruleKey, undefined, "没传 ruleKey 的条目不该有该字段");
});

check("链路：读日志 → 找同类 → 生成附注（排除当前会话）", () => {
  const readEntries = () => readApprovalLog({ limit: 50 }).entries;
  eq(
    safeLastDecisionNote("cmd:rm-rf", readEntries, { now, excludeSessionId: "sess-other" }),
    "上次同类操作：今天 09:12 被拒绝（递归或强制删除文件）",
    "跨会话能拿到历史",
  );
  eq(
    safeLastDecisionNote("cmd:rm-rf", readEntries, { now, excludeSessionId: "sess-link" }),
    null,
    "只有当前会话自己的记录 → 不附注",
  );
  eq(safeLastDecisionNote("path:dotenv", readEntries, { now }), null, "没有同类历史 → 不附注");
});

/* ============================ 收尾 ============================ */

try {
  rmSync(root, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}
console.log(fail === 0 ? "\n全部通过" : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
