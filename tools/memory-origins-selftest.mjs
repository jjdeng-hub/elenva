// 记忆来源账本（lib/memory-origins.ts）的自检。
// 运行：node tools/memory-origins-selftest.mjs
//
// 隔离：PI_CODING_AGENT_DIR 指向 mkdtemp 出来的临时目录，全用**虚构**数据
//（不碰真实 ~/.pi/agent，也不写任何记忆文件）。lib/*.ts 是纯 TS（无 JSX），jiti 可直载。
//
// 另有一项跨实现一致性检查：扩展侧另有一份写入实现（extensions/elenva-memory/origins.ts，
// 复制式安装读不到仓库代码），两边**只共享磁盘格式**——这里用同一份账本文件交叉验证键与结构一致。
import { createJiti } from "jiti";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "elenva-memory-origins-selftest-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const origins = await jiti.import("../lib/memory-origins.ts");

let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try {
    fn();
    pass += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
};

const ledgerPath = () => origins.getMemoryOriginsPath();
const readLedger = () => JSON.parse(readFileSync(ledgerPath(), "utf8"));
const writeLedger = (items) => writeFileSync(ledgerPath(), JSON.stringify({ version: 1, items }), "utf8");
const resetLedger = () => rmSync(ledgerPath(), { force: true });
const sha1 = (text) => createHash("sha1").update(text, "utf8").digest("hex");

/* ============================ 隔离自证 ============================ */

check("① 临时目录隔离生效（账本落在临时 agentDir 内）", () => {
  resetLedger();
  assert.equal(origins.getMemoryOriginsPath(), resolve(agentDir, "elenva-memory-origins.json"));
  assert.ok(origins.getMemoryOriginsPath().startsWith(agentDir));
});

/* ============================ 记录 / 查询往返 ============================ */

check("② 记录 → 查询往返：via/at/sessionId/cwd 齐全", () => {
  const ok = origins.recordMemoryOrigin({
    file: "memory",
    text: "条目甲：虚构的长期记忆。",
    via: "agent",
    sessionId: "sess-abcdef123456",
    cwd: "/tmp/demo-project",
  });
  assert.equal(ok, true);
  const origin = origins.getMemoryOrigin("memory", "条目甲：虚构的长期记忆。");
  assert.equal(origin.via, "agent");
  assert.equal(origin.sessionId, "sess-abcdef123456");
  assert.equal(origin.cwd, "/tmp/demo-project");
  assert.ok(!Number.isNaN(Date.parse(origin.at)), "at 应是可解析的 ISO 时间");
});

check("③ 不带 sessionId/cwd 时这两个字段缺省（不写空串）", () => {
  origins.recordMemoryOrigin({ file: "user", text: "条目乙：虚构偏好。", via: "web-edit" });
  const origin = origins.getMemoryOrigin("user", "条目乙：虚构偏好。");
  assert.equal(origin.via, "web-edit");
  assert.equal("sessionId" in origin, false);
  assert.equal("cwd" in origin, false);
});

/* ============================ 键口径 ============================ */

check("④ 键 = fileId + NUL + sha1(正文)；与手算一致", () => {
  assert.equal(origins.memoryOriginKey("user", "某条正文"), `user\u0000${sha1("某条正文")}`);
});

check("⑤ trim 归一：带/不带首尾空格命中同一 key", () => {
  assert.equal(origins.memoryOriginKey("memory", "  条目丙  "), origins.memoryOriginKey("memory", "条目丙"));
  origins.recordMemoryOrigin({ file: "memory", text: "  条目丙  ", via: "remember" });
  assert.equal(origins.getMemoryOrigin("memory", "条目丙").via, "remember", "带空格的写入应能被无空格的查询命中");
});

check("⑥ 剥掉尾部 <!-- created=… --> 注释后命中同一 key", () => {
  const withMeta = "条目丁：虚构事实。 <!-- created=2020-01-01, last=2020-01-01 -->";
  assert.equal(origins.memoryOriginKey("memory", withMeta), origins.memoryOriginKey("memory", "条目丁：虚构事实。"));
  origins.recordMemoryOrigin({ file: "memory", text: withMeta, via: "agent" });
  assert.equal(origins.getMemoryOrigin("memory", "条目丁：虚构事实。").via, "agent");
});

check("⑦ 不同 file 同文本不串", () => {
  resetLedger();
  origins.recordMemoryOrigin({ file: "memory", text: "同一段正文", via: "agent" });
  assert.equal(origins.getMemoryOrigin("memory", "同一段正文").via, "agent");
  assert.equal(origins.getMemoryOrigin("user", "同一段正文"), undefined, "换文件不应命中");
  assert.equal(origins.getMemoryOrigin("project/demo", "同一段正文"), undefined);
});

/* ============================ 容错 / 值域 ============================ */

check("⑧ get 未命中 = undefined", () => {
  resetLedger();
  assert.equal(origins.getMemoryOrigin("memory", "从来没记过的正文"), undefined);
});

check("⑨ via 值域拒绝：非法值不落盘，值域列表正确", () => {
  assert.deepEqual(origins.MEMORY_ORIGIN_VIAS, ["agent", "web-edit", "remember", "pending"]);
  assert.equal(origins.isMemoryOriginVia("agent"), true);
  assert.equal(origins.isMemoryOriginVia("telepathy"), false);
  resetLedger();
  assert.equal(origins.recordMemoryOrigin({ file: "memory", text: "非法来源", via: "telepathy" }), false);
  assert.equal(origins.getMemoryOrigin("memory", "非法来源"), undefined);
});

check("⑩ 损坏账本容错：读返回空表不抛，写能重建干净账本", () => {
  writeFileSync(ledgerPath(), "{ 这不是 JSON", "utf8");
  assert.equal(origins.getMemoryOrigin("memory", "任意"), undefined, "损坏文件不应抛");
  assert.equal(origins.recordMemoryOrigin({ file: "memory", text: "重建后的条目", via: "agent" }), true);
  assert.equal(origins.getMemoryOrigin("memory", "重建后的条目").via, "agent", "写后应能正常读回");

  // 结构合法但单条非法：读取层丢弃非法条目，且下次写入把它从磁盘上清掉
  const goodKey = origins.memoryOriginKey("memory", "合法条目");
  const badKey = origins.memoryOriginKey("memory", "非法条目");
  writeLedger({ [goodKey]: { via: "agent", at: "2020-01-01" }, [badKey]: { via: "nope", at: "2020-01-01" } });
  assert.equal(origins.getMemoryOrigin("memory", "合法条目").via, "agent");
  assert.equal(origins.getMemoryOrigin("memory", "非法条目"), undefined, "via 非法的条目应被丢弃");
  origins.recordMemoryOrigin({ file: "memory", text: "再写一条", via: "agent" });
  assert.equal(badKey in readLedger().items, false, "非法条目应在下次写入时被清洗");
});

/* ============================ 上限淘汰 ============================ */

check("⑪ 上限 800：超出按 at 淘汰最旧", () => {
  const items = {};
  for (let i = 0; i < origins.MEMORY_ORIGINS_LIMIT; i += 1) {
    // at 按 i 递增：i=0 最旧
    items[`memory\u0000${sha1(`旧条目-${i}`)}`] = {
      via: "agent",
      at: new Date(Date.UTC(2020, 0, 1) + i * 1000).toISOString(),
    };
  }
  writeLedger(items);
  assert.equal(Object.keys(readLedger().items).length, origins.MEMORY_ORIGINS_LIMIT);

  origins.recordMemoryOrigin({ file: "memory", text: "最新条目", via: "pending" });
  assert.equal(Object.keys(readLedger().items).length, origins.MEMORY_ORIGINS_LIMIT, "写后条目数不超过上限");
  assert.equal(origins.getMemoryOrigin("memory", "旧条目-0"), undefined, "最旧的一条应被淘汰");
  assert.ok(origins.getMemoryOrigin("memory", "旧条目-1"), "次旧的应保留");
  assert.equal(origins.getMemoryOrigin("memory", "最新条目").via, "pending", "新条目应可读回");
});

/* ============================ 文件结构 / 权限 ============================ */

check("⑫ 文件结构 {version:1, items}；权限 0600", () => {
  resetLedger();
  origins.recordMemoryOrigin({ file: "memory", text: "结构检查", via: "web-edit" });
  const parsed = readLedger();
  assert.deepEqual(Object.keys(parsed), ["version", "items"]);
  assert.equal(parsed.version, 1);
  assert.equal(typeof parsed.items, "object");
  const mode = statSync(ledgerPath()).mode & 0o777;
  assert.equal(mode, 0o600, `账本权限应为 0600，实际 ${mode.toString(8)}`);
});

/* ============================ 跨实现（扩展侧）一致性 ============================ */

let extOriginsError = null;
let extOrigins = null;
try {
  extOrigins = await jiti.import("../extensions/elenva-memory/origins.ts");
} catch (error) {
  extOriginsError = error;
}

check("⑬ 扩展侧写入 → 仓库侧可读（同一账本格式，键口径一致）", () => {
  assert.equal(extOriginsError, null, `扩展实现导入失败：${extOriginsError instanceof Error ? extOriginsError.message : ""}`);
  resetLedger();
  assert.equal(
    extOrigins.memoryOriginKey("memory", "跨实现正文"),
    origins.memoryOriginKey("memory", "跨实现正文"),
    "两边的键口径必须一致",
  );
  const ok = extOrigins.recordMemoryOrigin({
    file: "project/demo",
    text: "跨实现正文 <!-- created=2020-01-01, last=2020-01-01 -->",
    via: "agent",
    sessionId: "sess-ext",
  });
  assert.equal(ok, true);
  const viaLib = origins.getMemoryOrigin("project/demo", "跨实现正文");
  assert.equal(viaLib?.via, "agent");
  assert.equal(viaLib?.sessionId, "sess-ext");
  const mode = statSync(ledgerPath()).mode & 0o777;
  assert.equal(mode, 0o600, "扩展侧写出的账本也应是 0600");
});

rmSync(root, { recursive: true, force: true });

console.log(`\nSELFTEST: ${fail === 0 ? "OK" : "FAILED"} — ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exitCode = 1;
