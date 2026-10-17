// 记忆条目「标失效 / 恢复」（单条原子，lib/agent-memory.ts 的 setAgentMemoryEntryStatus +
// app/api/memory/status 路由）的自检。
//
// 运行：node tools/memory-status-selftest.mjs
//
// 隔离：PI_CODING_AGENT_DIR / PI_HERMES_MEMORY_DIR 指向 mkdtemp 临时目录，全用**虚构**数据；
// 配额也用临时目录里的 hermes-memory-config.json 压到 240 字符，便于验证「满额时失效仍可写」
// （失效是满额逃生口）。lib/*.ts 是纯 TS（无 JSX），jiti 可直载。
import { createJiti } from "jiti";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "elenva-memory-status-selftest-"));
const agentDir = join(root, "agent");
const memoryDir = join(agentDir, "pi-hermes-memory");
mkdirSync(memoryDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_HERMES_MEMORY_DIR = memoryDir;
// 把 MEMORY 配额压到 240 字符（夹具条目很短，能精确控水位）
writeFileSync(
  join(agentDir, "hermes-memory-config.json"),
  JSON.stringify({ memoryCharLimit: 240, userCharLimit: 240, projectCharLimit: 240 }),
  "utf8",
);

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const memory = await jiti.import("../lib/agent-memory.ts");
const statusRoute = await jiti.import("../app/api/memory/status/route.ts");

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

const MEMORY_PATH = join(memoryDir, "MEMORY.md");
const today = new Date().toISOString().slice(0, 10);
const entry = (text, created = "2020-01-01", extra = "") => `${text} <!-- created=${created}, last=${created}${extra} -->`;
const writeRaw = (raw) => writeFileSync(MEMORY_PATH, raw, "utf8");
const readRaw = () => readFileSync(MEMORY_PATH, "utf8");
const status = (text, action, opts = {}) => memory.setAgentMemoryEntryStatus("memory", { text, action, ...opts });

/** 一次性把三份文件重置成夹具基线；A/C 是不能被误伤的旁观条目。 */
const A = "偏好：回复尽量简洁（虚构）。";
const B = "事实：dev 端口是 30299（虚构，将被推翻）。";
const C = "规则：提交前跑三道门（虚构）。";
let revisionOfBaseline = "";
const resetBaseline = () => {
  const raw = [entry(A, "2021-01-01"), entry(B, "2021-02-02"), entry(C, "2021-03-03")].join("\n§\n");
  writeRaw(raw);
  const snap = memory.readAgentMemorySnapshot("memory");
  revisionOfBaseline = snap.revision;
  return snap;
};

/* ============================ 隔离自证 ============================ */

check("① 隔离生效（临时目录 / 临时配额）", () => {
  assert.equal(memory.getHermesMemoryDir(), resolve(memoryDir));
  assert.equal(memory.getHermesMemoryLimits().memory, 240, "应为夹具配额（隔离配置未生效？）");
});

/* ============================ 标失效 ============================ */

check("② 标失效：只翻转目标条目，旁观条目逐字节不变", () => {
  resetBaseline();
  const result = status(B, "invalidate", { reason: "端口已改，旧值不可信" });
  assert.equal(result.ok, true, `应成功：${result.ok ? "" : result.error}`);
  assert.ok(result.backup && existsSync(result.backup), "应留下写前备份");
  assert.equal(readFileSync(result.backup, "utf8"), [entry(A, "2021-01-01"), entry(B, "2021-02-02"), entry(C, "2021-03-03")].join("\n§\n"));
  const raw = readRaw();
  // A / C 的完整元数据注释必须原样还在（没有整份重写把它们刷新）
  assert.ok(raw.includes(entry(A, "2021-01-01")), "A 的元数据被动过");
  assert.ok(raw.includes(entry(C, "2021-03-03")), "C 的元数据被动过");
  const snap = memory.readAgentMemorySnapshot("memory");
  const b = snap.entries.find((e) => e.text === B);
  assert.equal(b.invalidated, today, "失效日期应为今天");
  assert.equal(b.reason, "端口已改，旧值不可信");
  const a = snap.entries.find((e) => e.text === A);
  assert.equal(a.invalidated, null, "A 不应被标失效");
});

check("③ 已失效条目再标一次：保留原失效日期，原因可更新", () => {
  resetBaseline();
  const first = status(B, "invalidate", { reason: "第一版原因" });
  assert.equal(first.ok, true);
  const later = status(B, "invalidate", { reason: "第二版原因" });
  assert.equal(later.ok, true);
  const b = memory.readAgentMemorySnapshot("memory").entries.find((e) => e.text === B);
  assert.equal(b.invalidated, today);
  assert.equal(b.reason, "第二版原因");
});

check("④ 恢复：清空日期与原因，只动目标条目", () => {
  resetBaseline();
  status(B, "invalidate", { reason: "临时标掉" });
  const restored = status(B, "restore");
  assert.equal(restored.ok, true, `应成功：${restored.ok ? "" : restored.error}`);
  const snap = memory.readAgentMemorySnapshot("memory");
  const b = snap.entries.find((e) => e.text === B);
  assert.equal(b.invalidated, null);
  assert.equal(b.reason, null);
  assert.ok(readRaw().includes(entry(A, "2021-01-01")) && readRaw().includes(entry(C, "2021-03-03")), "旁观条目被改动");
});

/* ============================ 失败路径 ============================ */

check("⑤ 找不到条目：not-found，且文件逐字节不变", () => {
  resetBaseline();
  const before = readRaw();
  const result = status("这条根本不存在（虚构）", "invalidate");
  assert.equal(result.ok, false);
  assert.equal(result.code, "not-found");
  assert.equal(readRaw(), before, "失败路径不应改动文件");
});

check("⑥ 并发冲突：revision 不符 → conflict，且文件逐字节不变", () => {
  resetBaseline();
  const before = readRaw();
  const result = status(B, "invalidate", { revision: "deadbeef0000" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "conflict");
  assert.equal(readRaw(), before, "冲突路径不应改动文件");
});

check("⑦ 非法 action / 空正文：invalid，且文件逐字节不变", () => {
  resetBaseline();
  const before = readRaw();
  const badAction = memory.setAgentMemoryEntryStatus("memory", { text: B, action: "delete" });
  assert.equal(badAction.ok, false);
  assert.equal(badAction.code, "invalid");
  const empty = status("   ", "invalidate");
  assert.equal(empty.ok, false);
  assert.equal(empty.code, "invalid");
  assert.equal(readRaw(), before);
});

/* ============================ reason 归一 ============================ */

check("⑧ reason 归一：逗号换全角、`-->` 变箭头、空白压缩、超 120 截断", () => {
  resetBaseline();
  status(B, "invalidate", { reason: "端口改了, 旧值--> 作废\n\n  再想想" });
  let b = memory.readAgentMemorySnapshot("memory").entries.find((e) => e.text === B);
  assert.equal(b.reason, "端口改了， 旧值→ 作废 再想想");

  resetBaseline();
  status(B, "invalidate", { reason: "很长的原因".repeat(40) });
  b = memory.readAgentMemorySnapshot("memory").entries.find((e) => e.text === B);
  assert.equal(b.reason.length, 120, "超长应截到 120（含省略号）");
  assert.ok(b.reason.endsWith("…"), "截断应以省略号收尾");
});

check("⑨ 留空原因：只记日期，不写 reason", () => {
  resetBaseline();
  status(B, "invalidate", { reason: "   " });
  const b = memory.readAgentMemorySnapshot("memory").entries.find((e) => e.text === B);
  assert.equal(b.invalidated, today);
  assert.equal(b.reason, null);
  assert.ok(!readRaw().includes("reason="), "空原因不应写出 reason 字段");
});

/* ============================ 满额逃生口 ============================ */

check("⑩ 满额（≥上限）时失效仍可写；普通整份保存仍被配额拦下", () => {
  // 造一份恰好压线（serialized 长度 ≥ 240）的记忆（虚构）
  let raw = [entry(A, "2021-01-01"), entry(B, "2021-02-02")].join("\n§\n");
  for (let n = 10; raw.length < 240 && n < 2000; n += 10) {
    raw = [entry(A, "2021-01-01"), entry(B, "2021-02-02"), entry(`填充 ${"x".repeat(n)}`, "2021-04-04")].join("\n§\n");
  }
  writeRaw(raw);
  const atLimit = memory.readAgentMemorySnapshot("memory");
  assert.ok(atLimit.chars >= 240, `夹具应压到上限之上（当前 ${atLimit.chars}/${atLimit.limit}）`);

  // 普通 PUT 会被配额拦下
  const normal = memory.writeAgentMemoryFile("memory", { entries: atLimit.entries, revision: atLimit.revision });
  assert.equal(normal.ok, false);
  assert.equal(normal.code, "over-limit");

  // 标失效走 enforceLimit:false，仍能落盘（元数据级逃生口）
  const result = status(B, "invalidate", { reason: "满额也要能标" });
  assert.equal(result.ok, true, `满额时失效应成功：${result.ok ? "" : result.error}`);
  const b = memory.readAgentMemorySnapshot("memory").entries.find((e) => e.text === B);
  assert.equal(b.invalidated, today);
});

/* ============================ API 层（路由） ============================ */

async function routeChecks() {
  const call = async (body) => {
    const res = await statusRoute.POST(
      new Request("http://local/api/memory/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return { at: res.status, body: await res.json() };
  };

  resetBaseline();
  const ok = await call({ file: "memory", text: B, action: "invalidate", reason: "经路由标失效，" });
  assert.equal(ok.at, 200);
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.entries.find((e) => e.text === B).reason, "经路由标失效，");

  const restored = await call({ file: "memory", text: B, action: "restore" });
  assert.equal(restored.at, 200);
  assert.equal(restored.body.entries.find((e) => e.text === B).invalidated, null);

  const badFile = await call({ file: "../etc/passwd", text: B, action: "invalidate" });
  assert.equal(badFile.at, 400);
  assert.equal(badFile.body.code, "unknown-file");

  const badAction = await call({ file: "memory", text: B, action: "delete" });
  assert.equal(badAction.at, 400);
  assert.match(badAction.body.error, /action/);

  const missing = await call({ file: "memory", text: "不存在（虚构）", action: "invalidate" });
  assert.equal(missing.at, 400);
  assert.equal(missing.body.code, "not-found");

  const conflict = await call({ file: "memory", text: B, action: "invalidate", revision: "0000deadbeef" });
  assert.equal(conflict.at, 409);
  assert.equal(conflict.body.code, "conflict");
}

try {
  await routeChecks();
  console.log("PASS  ⑪ API 路由：成功 / 恢复 / 未知文件 / 非法 action / not-found / 冲突（状态码齐）");
} catch (error) {
  fail += 1;
  console.log(`FAIL  ⑪ API 路由\n      ${error instanceof Error ? error.message : String(error)}`);
}

console.log(fail === 0 ? "\n全部通过" : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
