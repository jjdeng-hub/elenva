// 待办侧账本（lib/todo-ledger.ts）自测。
// 运行：node tools/todo-ledger-selftest.mjs
//
// 全部用临时 agentDir，不碰真实 ~/.pi/agent。用例数据均为虚构。
import { createJiti } from "jiti";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const tl = await jiti.import("../lib/todo-ledger.ts");

const log = await jiti.import("../extensions/elenva-todo/ledger.ts");

let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
  if (!ok) fail++;
};

function makeAgentDir() {
  const root = mkdtempSync(join(tmpdir(), "elenva-ledger-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  return { root, agentDir, file: join(agentDir, "elenva-todo-ledger.json") };
}

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const iso = (daysAgo) => new Date(NOW - daysAgo * 24 * 60 * 60 * 1000).toISOString();
const ledgerOf = (sessions) => ({ sessions });

// ① 读取容错：缺失 / 坏 JSON / 坏结构 / 坏条目 / 字段缺省
{
  const env = makeAgentDir();
  check("① 文件缺失 → 空账本", JSON.stringify(tl.readTodoLedger(env.agentDir)) === JSON.stringify({ sessions: {} }));
  check("① 路径文件名正确", tl.getTodoLedgerPath(env.agentDir).endsWith("elenva-todo-ledger.json"));

  writeFileSync(env.file, "{ not json", "utf8");
  check("① 坏 JSON → 空账本", Object.keys(tl.readTodoLedger(env.agentDir).sessions).length === 0);

  writeFileSync(env.file, JSON.stringify({ version: 1, sessions: { s1: { A: { firstSeen: iso(4) }, B: { lastSeen: iso(1) }, "": { firstSeen: iso(4), lastSeen: iso(1) }, C: "nope" } } }), "utf8");
  const parsed = tl.readTodoLedger(env.agentDir);
  check("① 缺字段 / 空键 / 非对象条目被丢弃", Object.keys(parsed.sessions).length === 0);

  writeFileSync(env.file, JSON.stringify({ version: 1, sessions: { s1: { "写文档": { firstSeen: iso(4), lastSeen: iso(2) } }, s2: {} } }), "utf8");
  const ok = tl.readTodoLedger(env.agentDir);
  check("① 合法条目保留、空会话丢弃", ok.sessions.s1["写文档"].firstSeen === iso(4) && !("s2" in ok.sessions));
  rmSync(env.root, { recursive: true, force: true });
}

// ② 归一化口径：与扩展侧一致
{
  check("② normalizeItemKey 与扩展侧同口径", tl.normalizeItemKey("  写\t代码  并验证  ") === log.normalizeItemKey("  写\t代码  并验证  "));
  check("② 超长截断到 160", tl.normalizeItemKey("长".repeat(200)).length === 160);
}

// ③ 逾期筛选：<72h 不列、≥72h 列
{
  const ledger = ledgerOf({ s1: { "刚建": { firstSeen: iso(1), lastSeen: iso(0.5) }, "三天前": { firstSeen: iso(3), lastSeen: iso(0.2) } } });
  const out = tl.computeOverdueTodos(ledger, NOW);
  check("③ 3 天（整 72h）刚好算逾期", out.length === 1 && out[0].sessionId === "s1");
  check("③ oldestDays 向下取整为 3", out[0]?.oldestDays === 3, String(out[0]?.oldestDays));
  check("③ count 只数逾期条目", out[0]?.count === 1, String(out[0]?.count));
  const almost = ledgerOf({ s1: { "差一点": { firstSeen: new Date(NOW - (tl.OVERDUE_MS - 1000)).toISOString(), lastSeen: iso(0) } } });
  check("③ 差 1 秒不列", tl.computeOverdueTodos(almost, NOW).length === 0);
  check("③ 阈值常量是 72h", tl.OVERDUE_MS === 72 * 60 * 60 * 1000);
}

// ④ samples：最多 3 条、按天数降序
{
  const items = {};
  for (const d of [3, 5, 9, 4, 7]) items[`任务-${d}`] = { firstSeen: iso(d), lastSeen: iso(0) };
  const out = tl.computeOverdueTodos(ledgerOf({ s1: items }), NOW);
  check("④ samples 最多 3 条", out[0].samples.length === 3, String(out[0].samples.length));
  check("④ samples 按天数降序", out[0].samples.map((s) => s.days).join(",") === "9,7,5", out[0].samples.map((s) => s.days).join(","));
  check("④ count 为全部逾期条数（5）", out[0].count === 5, String(out[0].count));
  check("④ oldestDays 取最大天数（9）", out[0].oldestDays === 9, String(out[0].oldestDays));
}

// ⑤ 排序 + 会话数封顶
{
  const sessions = {};
  for (let i = 1; i <= 12; i++) {
    sessions[`s${i}`] = { [`任务${i}`]: { firstSeen: iso(i), lastSeen: iso(0) } };
  }
  const out = tl.computeOverdueTodos(ledgerOf(sessions), NOW);
  check("⑤ 最多 10 个会话", out.length === 10, String(out.length));
  check("⑤ 按 oldestDays 降序", out[0].sessionId === "s12" && out[9].sessionId === "s3", `${out[0].sessionId}…${out[9].sessionId}`);
}

// ⑥ 无法解析的时间戳跳过；不逾期的会话整体不出现
{
  const ledger = ledgerOf({
    s1: { "坏时间": { firstSeen: "not-a-date", lastSeen: iso(0) }, "新条目": { firstSeen: iso(0), lastSeen: iso(0) } },
    s2: { "昨天": { firstSeen: iso(1), lastSeen: iso(1) } },
  });
  check("⑥ 坏时间戳跳过、无逾期会话不列出", tl.computeOverdueTodos(ledger, NOW).length === 0);
}

console.log(`\nSELFTEST: ${fail === 0 ? "OK" : "FAILED"} — ${fail === 0 ? "全部通过" : `${fail} 项失败`}`);
if (fail > 0) process.exitCode = 1;
