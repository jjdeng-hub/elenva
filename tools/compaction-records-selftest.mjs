// 压缩记录收集器（lib/compaction-records.ts）的自检。
// 运行：node tools/compaction-records-selftest.mjs
//
// 纯函数、无 IO，全部用**虚构**条目数据；不读真实会话。
// lib/compaction-records.ts 只有 `import type`（编译期擦除），jiti 可直载 .ts。
import { createJiti } from "jiti";
import assert from "node:assert/strict";

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const { collectCompactionRecords } = await jiti.import("../lib/compaction-records.ts");

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

/** 虚构的 message 条目 */
const msg = (id) => ({ type: "message", id, parentId: null, timestamp: `2026-01-01T00:00:${id.slice(1).padStart(2, "0")}Z`, message: { role: "user", content: id } });
/** 虚构的 compaction 条目；firstKeptEntryId 传 undefined 模拟字段缺失 */
const compact = (id, firstKeptEntryId, extra = {}) => ({
  type: "compaction",
  id,
  parentId: null,
  timestamp: `2026-02-01T00:00:${id.slice(1).padStart(2, "0")}Z`,
  summary: `摘要-${id}`,
  ...(firstKeptEntryId === undefined ? {} : { firstKeptEntryId }),
  tokensBefore: 1234,
  ...extra,
});

check("① 空数组 → []", () => {
  assert.deepEqual(collectCompactionRecords([]), []);
});

check("② 单次压缩：文件头 → firstKept 区间内的 message 计数", () => {
  const entries = [msg("m0"), msg("m1"), msg("m2"), compact("c1", "m2")];
  const records = collectCompactionRecords(entries);
  assert.equal(records.length, 1);
  assert.equal(records[0].entryId, "c1");
  assert.equal(records[0].droppedMessages, 2, "应统计 m0/m1 两条");
  assert.equal(records[0].tokensBefore, 1234);
  assert.equal(records[0].summary, "摘要-c1");
  assert.equal(records[0].timestamp, "2026-02-01T00:00:01Z");
});

check("③ 连续两次压缩：第二次只数自己的区间（从上一条保留起点起）", () => {
  const entries = [
    msg("m0"), msg("m1"), msg("m2"),
    compact("c1", "m2"),
    msg("m3"), msg("m4"),
    compact("c2", "m4"),
  ];
  const records = collectCompactionRecords(entries);
  assert.equal(records.length, 2);
  assert.equal(records[0].droppedMessages, 2, "第一次：m0/m1");
  assert.equal(records[1].droppedMessages, 2, "第二次：m2/m3（c1 不是 message，不计）");
});

check("④ 区间内无 message → 0", () => {
  const entries = [msg("m0"), compact("c1", "m0")];
  const records = collectCompactionRecords(entries);
  assert.equal(records[0].droppedMessages, 0);
});

check("⑤ 缺 / 非法 firstKeptEntryId：以本条 compaction 位置为终点", () => {
  const missing = collectCompactionRecords([msg("m0"), msg("m1"), compact("c1", undefined)]);
  assert.equal(missing[0].droppedMessages, 2, "缺字段：数到 compaction 之前共 2 条");
  const bogus = collectCompactionRecords([msg("m0"), msg("m1"), compact("c1", "不存在")]);
  assert.equal(bogus[0].droppedMessages, 2, "找不到引用：退化为本条位置");
});

check("⑥ tokensBefore 缺失 / 非法 → 0；合法保留", () => {
  const cases = [
    [undefined, 0], [NaN, 0], [Infinity, 0], [Number.NEGATIVE_INFINITY, 0], ["500", 0], [null, 0], [0, 0], [4096, 4096],
  ];
  for (const [raw, expected] of cases) {
    const entry = compact("c1", "m0", { tokensBefore: raw });
    const records = collectCompactionRecords([msg("m0"), entry]);
    assert.equal(records[0].tokensBefore, expected, `tokensBefore=${String(raw)}`);
  }
});

check("⑦ 输出顺序稳定：文件顺序（时间升序）", () => {
  const entries = [
    msg("m0"), compact("c1", "m0"),
    msg("m1"), compact("c2", "m1"),
    msg("m2"), compact("c3", "m2"),
  ];
  const records = collectCompactionRecords(entries);
  assert.deepEqual(records.map((r) => r.entryId), ["c1", "c2", "c3"]);
});

process.exit(fail === 0 ? 0 : 1);
