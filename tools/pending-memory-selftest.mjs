// 待审队列（lib/pending-memory.ts）与记忆追加（lib/agent-memory.ts 的 appendAgentMemoryEntry）的自检。
// 运行：node tools/pending-memory-selftest.mjs
//
// 隔离：PI_CODING_AGENT_DIR / PI_HERMES_MEMORY_DIR 都指向 mkdtemp 出来的临时目录，
// 全用**虚构**数据，不碰真实 ~/.pi/agent。lib/*.ts 都是纯 TS（无 JSX），jiti 可直载。
import { createJiti } from "jiti";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "elenva-pending-selftest-"));
const agentDir = join(root, "agent");
const memoryDir = join(agentDir, "pi-hermes-memory");
mkdirSync(memoryDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_HERMES_MEMORY_DIR = memoryDir;

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const pending = await jiti.import("../lib/pending-memory.ts");
const memory = await jiti.import("../lib/agent-memory.ts");

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

const queuePath = () => pending.getPendingMemoryPath();
const resetQueue = () => rmSync(queuePath(), { force: true });
const memoryPath = (id) => memory.resolveAgentMemoryFilePath(id);
const resetMemory = (id) => rmSync(memoryPath(id), { force: true });

/* ============================ 隔离自证 ============================ */

check("① 临时目录隔离生效（不碰真实 agentDir / 记忆目录）", () => {
  assert.equal(memory.getHermesMemoryDir(), resolve(memoryDir));
  assert.equal(queuePath(), join(agentDir, "elenva-pending-memory.json"));
  assert.ok(queuePath().startsWith(agentDir), "待审文件必须落在临时 agentDir 内");
});

/* ============================ 待审队列 ============================ */

check("② 待审：新增 / 列表（新→旧）/ trim", () => {
  resetQueue();
  const a = pending.addPendingMemory({ text: "  第一条待审  " });
  assert.ok(a.ok, a.error);
  assert.match(a.item.id, /^pm-\d+-[0-9a-f]{6}$/);
  assert.equal(a.item.text, "第一条待审", "存盘前应 trim");
  assert.equal(a.count, 1);
  const b = pending.addPendingMemory({ text: "第二条待审" });
  assert.ok(b.ok, b.error);
  assert.deepEqual(
    pending.listPendingMemory().map((i) => i.text),
    ["第二条待审", "第一条待审"],
  );
});

check("③ 待审：删除（含不存在的 id）", () => {
  resetQueue();
  const a = pending.addPendingMemory({ text: "删我" });
  assert.ok(a.ok);
  const removed = pending.removePendingMemory(a.item.id);
  assert.equal(removed && removed.text, "删我");
  assert.equal(pending.listPendingMemory().length, 0);
  assert.equal(pending.removePendingMemory("pm-不存在"), null);
});

check("④ 待审：损坏文件 / 结构非法 → 空表，且之后还能正常写", () => {
  writeFileSync(queuePath(), "{ 这不是 JSON", "utf8");
  assert.deepEqual(pending.listPendingMemory(), [], "损坏文件按空表处理");
  writeFileSync(queuePath(), JSON.stringify({ version: 1, items: "oops" }), "utf8");
  assert.deepEqual(pending.listPendingMemory(), [], "items 非数组按空表处理");
  writeFileSync(
    queuePath(),
    JSON.stringify({ version: 1, items: [null, {}, { id: "x" }, { id: "y", text: "  " }, { id: "z", text: "有效" }] }),
    "utf8",
  );
  assert.deepEqual(pending.listPendingMemory().map((i) => i.text), ["有效"], "非法条目应被过滤");
  const ok = pending.addPendingMemory({ text: "坏文件之后还能写" });
  assert.ok(ok.ok, ok.error);
  assert.equal(pending.listPendingMemory().length, 2);
});

check("⑤ 待审：空文本 / 超长拒绝，上限 50", () => {
  resetQueue();
  assert.equal(pending.addPendingMemory({ text: "   " }).ok, false, "空白文本应拒绝");
  assert.equal(pending.addPendingMemory({ text: "" }).ok, false);
  assert.equal(pending.addPendingMemory({ text: "x".repeat(20001) }).ok, false, "超 20000 应拒绝");
  assert.ok(pending.addPendingMemory({ text: "x".repeat(20000) }).ok, "恰好 20000 应接受");

  resetQueue();
  for (let i = 0; i < 50; i += 1) {
    const r = pending.addPendingMemory({ text: `第 ${i} 条` });
    assert.ok(r.ok, `第 ${i} 条应写入成功：${r.error}`);
  }
  const over = pending.addPendingMemory({ text: "第 51 条" });
  assert.equal(over.ok, false);
  assert.match(over.error, /待审已满/);
  assert.equal(pending.listPendingMemory().length, 50);
});

check("⑥ 待审：source 只保留 sessionId / cwd", () => {
  resetQueue();
  const r = pending.addPendingMemory({
    text: "带来源",
    source: { sessionId: "s-1", cwd: "/home/demo/proj", junk: 1 },
  });
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.item.source, { sessionId: "s-1", cwd: "/home/demo/proj" });
  assert.deepEqual(pending.findPendingMemory(r.item.id).source, { sessionId: "s-1", cwd: "/home/demo/proj" });
});

/* ============================ 记忆追加 ============================ */

check("⑦ 记忆追加：首条（文件不存在时创建）/ 多条 / trim / 空拒绝", () => {
  resetMemory("memory");
  assert.equal(memory.appendAgentMemoryEntry("memory", "   ").ok, false, "空文本应拒绝");
  assert.equal(memory.appendAgentMemoryEntry("memory", "   ").code, "invalid");
  const first = memory.appendAgentMemoryEntry("memory", "  有空白  ");
  assert.ok(first.ok, first.error);
  assert.equal(first.entries.length, 1);
  assert.equal(first.entries[0].text, "有空白", "写入前应 trim");
  assert.ok(existsSync(memoryPath("memory")), "文件不存在时应创建");
  const second = memory.appendAgentMemoryEntry("memory", "第二条");
  assert.ok(second.ok, second.error);
  assert.deepEqual(second.entries.map((e) => e.text), ["有空白", "第二条"]);
});

check("⑧ 记忆追加：未改动条目的 created / last 保留（不被刷成今天）", () => {
  resetMemory("memory");
  writeFileSync(memoryPath("memory"), "旧条目 <!-- created=2020-01-01, last=2020-02-02 -->", "utf8");
  const r = memory.appendAgentMemoryEntry("memory", "新条目");
  assert.ok(r.ok, r.error);
  const snap = memory.readAgentMemorySnapshot("memory");
  const old = snap.entries.find((e) => e.text === "旧条目");
  assert.equal(old.created, "2020-01-01");
  assert.equal(old.last, "2020-02-02", "追加不应把未改动条目的 last 刷新");
  assert.ok(snap.entries.find((e) => e.text === "新条目").last, "新条目应有元数据");
  assert.deepEqual(snap.entries.map((e) => e.text), ["旧条目", "新条目"]);
});

check("⑨ 记忆追加：配额满 → over-limit", () => {
  resetMemory("memory");
  const cfgPath = join(agentDir, "hermes-memory-config.json");
  writeFileSync(cfgPath, JSON.stringify({ memoryCharLimit: 80 }), "utf8");
  try {
    const r = memory.appendAgentMemoryEntry("memory", "x".repeat(200));
    assert.equal(r.ok, false);
    assert.equal(r.code, "over-limit");
    assert.ok(r.chars > r.limit, `应报超出配额：${r.chars} / ${r.limit}`);
  } finally {
    rmSync(cfgPath, { force: true });
  }
});

check("⑩ 记忆追加：读→写间被并发改动 → 重读重试一次，不丢对方条目", () => {
  resetMemory("memory");
  memory.appendAgentMemoryEntry("memory", "底稿");
  let hookCalls = 0;
  const r = memory.appendAgentMemoryEntry("memory", "本轮追加", () => {
    hookCalls += 1;
    if (hookCalls === 1) memory.appendAgentMemoryEntry("memory", "并发的另一条");
  });
  assert.ok(r.ok, r.error);
  assert.equal(hookCalls, 2, "第一次冲突后应重读并再写一次");
  const texts = memory.readAgentMemorySnapshot("memory").entries.map((e) => e.text);
  assert.ok(texts.includes("本轮追加"));
  assert.ok(texts.includes("并发的另一条"), "重试不能覆盖对方刚写的条目");
  assert.ok(texts.includes("底稿"));
});

check("⑪ 记忆追加：连续两次都被改动 → 返回 conflict", () => {
  resetMemory("memory");
  memory.appendAgentMemoryEntry("memory", "底稿");
  let n = 0;
  const r = memory.appendAgentMemoryEntry("memory", "永远追不上", () => {
    n += 1;
    memory.appendAgentMemoryEntry("memory", `外部-${n}`);
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "conflict");
});

check("⑫ 记忆追加：写前备份产生（首次无原文件时不备份）", () => {
  resetMemory("memory");
  const first = memory.appendAgentMemoryEntry("memory", "会被备份的内容");
  assert.ok(first.ok, first.error);
  assert.equal(first.backup, null, "没有原文件时不产生备份");
  const second = memory.appendAgentMemoryEntry("memory", "第二条");
  assert.ok(second.ok, second.error);
  assert.ok(second.backup, "已有文件时应产生备份");
  assert.ok(existsSync(second.backup));
  assert.match(readFileSync(second.backup, "utf8"), /会被备份的内容/);
});

check("⑬ 记忆追加：项目记忆标识 project/<名>；非法标识拒绝", () => {
  const r = memory.appendAgentMemoryEntry("project/demo-proj", "项目里的一条");
  assert.ok(r.ok, r.error);
  assert.ok(memoryPath("project/demo-proj").includes("projects-memory"));
  assert.equal(memory.appendAgentMemoryEntry("nope", "x").code, "unknown-file");
  assert.equal(memory.appendAgentMemoryEntry("project/../坏", "x").code, "unknown-file");
});

rmSync(root, { recursive: true, force: true });
console.log(fail === 0 ? "\n全部通过" : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
