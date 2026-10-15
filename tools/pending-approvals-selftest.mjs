// 待审批可观测层（lib/pending-approvals.ts）的自检：
// 活审批注册 / 清理 / 幂等覆盖 / 多会话多 kind 独立 / list 顺序 /
// 队列解析（正常 / 坏行跳过 / 缺失 / cap 20 / 字段缺省 / 新→旧）。
// 运行：node tools/pending-approvals-selftest.mjs
//
// 隔离：PI_CODING_AGENT_DIR 指向 mkdtemp 出来的临时目录，全用**虚构**数据，
// 不碰真实 ~/.pi/agent。lib/*.ts 是纯 TS（无 JSX），jiti 可直载（见记忆 F1/F3）。
import { createJiti } from "jiti";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "elenva-pending-approvals-selftest-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const lib = await jiti.import("../lib/pending-approvals.ts");
const {
  registerPendingApproval,
  resolvePendingApproval,
  listPendingApprovals,
  readQueuedApprovals,
  getPendingApprovalsPath,
  PENDING_APPROVALS_FILE,
  QUEUE_TAIL_LIMIT,
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

const queuePath = () => join(agentDir, PENDING_APPROVALS_FILE);
const writeQueue = (lines) => writeFileSync(queuePath(), `${lines.join("\n")}\n`, "utf8");
const clearLive = () => {
  // 注册表是模块级 Map：用已登记的键逐条清理，保持用例相互独立
  for (const item of listPendingApprovals()) resolvePendingApproval(item.sessionId, item.kind);
};

/* ============================ 活审批注册表 ============================ */

check("getPendingApprovalsPath 指向 agentDir 下的 jsonl", () => {
  eq(getPendingApprovalsPath(), queuePath(), "路径口径");
});

check("注册后可列出，字段完整", () => {
  clearLive();
  registerPendingApproval({
    sessionId: "sess-a",
    kind: "tool",
    reason: "删除工作区外文件",
    detail: "rm -rf /tmp/x",
    at: "2026-10-15T10:00:00.000Z",
  });
  const items = listPendingApprovals();
  eq(items.length, 1, "条数");
  eq(items[0].sessionId, "sess-a", "sessionId");
  eq(items[0].kind, "tool", "kind");
  eq(items[0].reason, "删除工作区外文件", "reason");
  eq(items[0].detail, "rm -rf /tmp/x", "detail");
  eq(items[0].at, "2026-10-15T10:00:00.000Z", "at");
});

check("resolve 后清空", () => {
  clearLive();
  registerPendingApproval({ sessionId: "sess-b", kind: "tool", reason: "r", detail: "d" });
  resolvePendingApproval("sess-b", "tool");
  eq(listPendingApprovals().length, 0, "清理后条数");
});

check("同 session+kind 幂等覆盖（不叠加）", () => {
  clearLive();
  registerPendingApproval({ sessionId: "sess-c", kind: "tool", reason: "旧", detail: "d1", at: "2026-10-15T01:00:00.000Z" });
  registerPendingApproval({ sessionId: "sess-c", kind: "tool", reason: "新", detail: "d2", at: "2026-10-15T02:00:00.000Z" });
  const items = listPendingApprovals();
  eq(items.length, 1, "覆盖后条数");
  eq(items[0].reason, "新", "取后写入的值");
});

check("多会话多 kind 相互独立", () => {
  clearLive();
  registerPendingApproval({ sessionId: "s1", kind: "tool", reason: "t", detail: "d" });
  registerPendingApproval({ sessionId: "s1", kind: "plan", reason: "p", detail: "d" });
  registerPendingApproval({ sessionId: "s2", kind: "tool", reason: "t2", detail: "d" });
  eq(listPendingApprovals().length, 3, "三条并存");
  resolvePendingApproval("s1", "tool");
  const left = listPendingApprovals();
  eq(left.length, 2, "只清掉 s1/tool");
  assert(left.some((x) => x.sessionId === "s1" && x.kind === "plan"), "s1/plan 仍在");
});

check("list 按 at 新→旧", () => {
  clearLive();
  registerPendingApproval({ sessionId: "old", kind: "tool", reason: "r", detail: "d", at: "2026-10-15T01:00:00.000Z" });
  registerPendingApproval({ sessionId: "mid", kind: "tool", reason: "r", detail: "d", at: "2026-10-15T02:00:00.000Z" });
  registerPendingApproval({ sessionId: "new", kind: "tool", reason: "r", detail: "d", at: "2026-10-15T03:00:00.000Z" });
  const ids = listPendingApprovals().map((x) => x.sessionId);
  assert(JSON.stringify(ids) === JSON.stringify(["new", "mid", "old"]), `顺序应为 new,mid,old，实际 ${ids.join(",")}`);
});

check("缺 sessionId / 非法 kind 静默跳过，且 resolve 缺失键不抛", () => {
  clearLive();
  registerPendingApproval({ sessionId: "", kind: "tool", reason: "r", detail: "d" });
  registerPendingApproval({ sessionId: null, kind: "tool", reason: "r", detail: "d" });
  registerPendingApproval({ sessionId: "sess-x", kind: "other", reason: "r", detail: "d" });
  eq(listPendingApprovals().length, 0, "无效登记不入表");
  resolvePendingApproval("never-registered", "plan");
});

/* ============================== 队列读取 ============================== */

check("队列正常解析：字段保留 + kind=queued + 新→旧", () => {
  clearLive();
  writeQueue([
    JSON.stringify({ toolName: "bash", detail: "git push", reason: "推送到远端", cwd: "/home/demo/w", sessionId: "q1", at: "2026-10-15T01:00:00.000Z" }),
    JSON.stringify({ toolName: "write", detail: "x.ts", reason: "越界写入", ruleKey: "write:outside", cwd: "/home/demo/w", sessionId: "q2", at: "2026-10-15T02:00:00.000Z" }),
  ]);
  const items = readQueuedApprovals();
  eq(items.length, 2, "条数");
  eq(items[0].kind, "queued", "来源标记");
  eq(items[0].sessionId, "q2", "新的一条在前");
  eq(items[1].sessionId, "q1", "旧的一条在后");
  eq(items[1].toolName, "bash", "toolName");
  eq(items[1].reason, "推送到远端", "reason");
  eq(items[1].cwd, "/home/demo/w", "cwd");
});

check("损坏行跳过，合法行仍保留", () => {
  writeQueue([
    "{ 坏掉的 json",
    JSON.stringify({ toolName: "bash", reason: "ok", sessionId: "q3" }),
    "[]",
    "null",
    JSON.stringify({ toolName: "bash", reason: "ok2", sessionId: "q4" }),
  ]);
  const items = readQueuedApprovals();
  eq(items.length, 2, "只剩两条合法");
  assert(items.every((x) => x.reason === "ok" || x.reason === "ok2"), "内容正确");
});

check("文件缺失 = []", () => {
  rmSync(queuePath(), { force: true });
  assert(!existsSync(queuePath()), "文件已删");
  eq(readQueuedApprovals().length, 0, "缺失返回空数组");
});

check("cap：只取尾部最近 QUEUE_TAIL_LIMIT 条（首条为最新）", () => {
  const total = QUEUE_TAIL_LIMIT + 5;
  const lines = Array.from({ length: total }, (_, i) =>
    JSON.stringify({ toolName: "bash", reason: `r${i + 1}`, sessionId: `s${i + 1}`, at: `2026-10-15T00:${String(i).padStart(2, "0")}:00.000Z` }),
  );
  writeQueue(lines);
  const items = readQueuedApprovals();
  eq(items.length, QUEUE_TAIL_LIMIT, "封顶条数");
  eq(items[0].sessionId, `s${total}`, "首条是最新写入");
  eq(items[items.length - 1].sessionId, `s${total - QUEUE_TAIL_LIMIT + 1}`, "末条落在窗口起点");
});

check("字段缺省：没有的字段为 undefined，不伪造", () => {
  writeQueue([JSON.stringify({ at: "2026-10-15T00:00:00.000Z" })]);
  const items = readQueuedApprovals();
  eq(items.length, 1, "条数");
  eq(items[0].sessionId, undefined, "sessionId 缺省");
  eq(items[0].reason, undefined, "reason 缺省");
  eq(items[0].toolName, undefined, "toolName 缺省");
  eq(items[0].kind, "queued", "kind 仍补齐");
});

rmSync(root, { recursive: true, force: true });

console.log(fail === 0 ? "\n全部通过" : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
