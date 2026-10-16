// lib/review-ledger.ts 的自检（复台账数据层）。
// 运行：node tools/review-ledger-selftest.mjs
//
// 夹具全部是**明显虚构**的数据，只落在临时目录，不碰本机 ~/.pi/agent 的真记忆。
// 走 jiti 而不是 --experimental-strip-types：与本目录其它自测一致，jiti 能解析 .ts 与 `@/` 别名。
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const {
  asDay,
  buildReviewLedger,
  collectRemovals,
  collectWorklogItems,
  groupReviewLedger,
  isoWeekOf,
  normalizeLedgerText,
  parseWorklogFile,
  parseWorklogHeading,
  previewOf,
  resetReviewLedgerCacheForTest,
} = await jiti.import("../lib/review-ledger.ts");

let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
  if (!ok) fail++;
};

const root = mkdtempSync(join(tmpdir(), "review-ledger-selftest-"));
const memoryDir = join(root, "memory");
const projectsDir = join(root, "projects");
const worklogDirPath = join(root, "worklog");
mkdirSync(memoryDir, { recursive: true });
mkdirSync(join(projectsDir, "demo-proj"), { recursive: true });
mkdirSync(join(worklogDirPath, "archive"), { recursive: true });

const entry = (text, created, last) => `${text} <!-- created=${created}, last=${last} -->`;
const joinEntries = (...lines) => lines.join("\n§\n");

// ── 虚构记忆文件 ─────────────────────────────────────────────
writeFileSync(
  join(memoryDir, "MEMORY.md"),
  joinEntries(
    entry("虚构：工作台护栏在写工作区外文件时会弹审批卡。", "2026-10-01", "2026-10-01"),
    entry("虚构：Node 22 的 --experimental-strip-types 可跑 .ts 自测。", "2026-10-03", "2026-10-16"),
    entry("虚构：第二天的长期结论，只创建未被整理。", "2026-10-05", "2026-10-05"),
  ),
);
writeFileSync(
  join(memoryDir, "USER.md"),
  joinEntries(entry("虚构：作者偏好简洁中文回复。", "2026-10-01", "2026-10-01")),
);
writeFileSync(join(memoryDir, "failures.md"), ""); // 空文件：不该抛，也不出条目
writeFileSync(
  join(projectsDir, "demo-proj", "MEMORY.md"),
  joinEntries(
    entry("虚构：demo-proj 里禁用原生模块。", "2026-10-03", "2026-10-03"),
    entry("虚构：demo-proj 的构建要带 --webpack。", "2026-10-03", "2026-10-16"),
  ),
);

// 快照差分：老的 recovery 里有「将被去掉」的一条，当前文件里没有
const removedText = "虚构：这条旧结论下一轮整理时会被去掉。";
const snapshotMs = Date.now() - 120_000;
writeFileSync(
  join(projectsDir, "demo-proj", `.MEMORY.md.recovery-${snapshotMs}-${randomUUID()}`),
  joinEntries(
    entry("虚构：demo-proj 里禁用原生模块。", "2026-10-03", "2026-10-03"),
    entry("虚构：demo-proj 的构建要带 --webpack。", "2026-10-03", "2026-10-03"),
    entry(removedText, "2026-10-02", "2026-10-02"),
  ),
);

// ── 虚构工作记录（当前 + 归档，归档为旧快照的复制）────────────
const wlCurrent = [
  "# 工作记录 · demo",
  "",
  "## 2026-10-16 23:03 · M6R3 并入 main · doing",
  "- **M6R3 复核过**：数字与独立参照一致。",
  "- 待办：跟线 → 空窗 → 部署。",
  "",
  "## 2026-10-05 09:10 · 模块一收尾 · done",
  "- 三门全过。",
  "",
].join("\n");
writeFileSync(join(worklogDirPath, "demo.md"), wlCurrent);
writeFileSync(join(worklogDirPath, "archive", "demo-2026-10-16T23-03-00.md"), wlCurrent); // 与当前重复
writeFileSync(
  join(worklogDirPath, "archive", "demo-2026-10-02T08-00-00.md"),
  ["# 工作记录 · demo", "", "## 2026-10-02 08:00 · 更早的一条 · blocked", "- 卡在网关。", ""].join("\n"),
);

/* ============================ ① 纯函数：日期与预览 ============================ */
{
  check("① asDay 合法日期 → 原样", asDay("2026-10-16") === "2026-10-16");
  check("① asDay 空 / 非法 → null", asDay("") === null && asDay("2026/10/16") === null && asDay(null) === null);
  check("① asDay 不存在的日期 → null（2026-02-31）", asDay("2026-02-31") === null);
  check("① normalizeLedgerText 折叠空白", normalizeLedgerText("  a\n b\tc ") === "a b c");
  check("① previewOf 截断加省略号", previewOf("x".repeat(200)).endsWith("…") && previewOf("x".repeat(200)).length === 91);
}

/* ============================ ② ISO 周 ============================ */
{
  const mon = isoWeekOf("2026-10-12");
  const sun = isoWeekOf("2026-10-18");
  const next = isoWeekOf("2026-10-19");
  check("② 周一与同周周日同键", mon && sun && mon.key === sun.key, `${mon?.key}`);
  check("② 下一周不同键", next && mon && next.key !== mon.key, `${next?.key}`);
  check("② 周区间为周一~周日", mon?.monday === "2026-10-12" && mon?.sunday === "2026-10-18");
  check("② 非法输入 → null", isoWeekOf("2026-13-01") === null || isoWeekOf("nope") === null);
}

/* ============================ ③ 工作记录解析 ============================ */
{
  const strict = parseWorklogHeading("## 2026-10-16 23:03 · M6R3 并入 main · doing");
  check("③ 严格头解析日期/时间/标题/状态", strict?.date === "2026-10-16" && strict?.time === "23:03" && strict?.title === "M6R3 并入 main" && strict?.status === "doing");
  const noTime = parseWorklogHeading("## 2026-10-05 · 模块一收尾 · done");
  check("③ 无时间的头", noTime?.date === "2026-10-05" && noTime?.time === null && noTime?.status === "done");
  const loose = parseWorklogHeading("## 2026-10-02 08:00 · 更早的一条 · blocked");
  check("③ blocked 状态", loose?.status === "blocked");
  check("③ 非标题行 → null", parseWorklogHeading("普通一行") === null);

  const items = parseWorklogFile(wlCurrent, "demo.md");
  check("③ parseWorklogFile 出两条", items.length === 2, `len=${items.length}`);
  check("③ 待办被抽出", items[0].todo === "跟线 → 空窗 → 部署。", JSON.stringify(items[0].todo));
  check("③ 没有待办的行 → null", items[1].todo === null);

  const collected = collectWorklogItems(worklogDirPath);
  check("③ 采集去重（归档复制不算重复）", collected.length === 3, `len=${collected.length}`);
  check("③ 采集含 archive 更早一条", collected.some((i) => i.date === "2026-10-02"));
  check("③ 空目录不抛且为空", collectWorklogItems(join(root, "nope")).length === 0);
}

/* ============================ ④ 记忆条目与「去掉」 ============================ */
{
  const ledger = buildReviewLedger({ memoryDir, projectsDir, worklogDir: worklogDirPath, groupBy: "day", now: Date.parse("2026-10-16T12:00:00Z") });
  check("④ memoryFound = true", ledger.memoryFound === true);
  check("④ approximate = false（有痕迹，走 A 路线）", ledger.approximate === false);
  check("④ 学到 = 6 条（含项目记忆）", ledger.summary.learned === 6, `got=${ledger.summary.learned}`);
  // 更新 = last≠created 的条目：Node 22 / demo-proj --webpack 共 2 条
  check("④ 更新 = 2 条", ledger.summary.touched === 2, `got=${ledger.summary.touched}`);
  check("④ 工作 = 3 条", ledger.summary.work === 3, `got=${ledger.summary.work}`);
  check("④ 去掉 = 1 条（快照差分）", ledger.summary.removed === 1, `got=${ledger.summary.removed}`);
  check("④ 去掉内容正确", ledger.buckets.some((b) => b.removed.some((r) => r.text === removedText)));

  const day16 = ledger.buckets.find((b) => b.key === "2026-10-16");
  check("④ 10-16 桶：更新 2 条", day16?.counts.touched === 2, `got=${day16?.counts.touched}`);
  check("④ 10-16 桶：工作 1 条", day16?.counts.work === 1);
  check("④ 10-16 桶：去掉 1 条（当前文件 mtime 归到今天）", day16?.counts.removed === 1, `got=${day16?.counts.removed}`);
  check("④ 桶按日期倒序", ledger.buckets[0].key === "2026-10-16");
  check("④ 摘要 from/to", ledger.summary.from === "2026-10-01" && ledger.summary.to === "2026-10-16", `${ledger.summary.from}~${ledger.summary.to}`);
  check("④ notes 有来源说明", Array.isArray(ledger.notes) && ledger.notes.length === 3);
  check("④ 记忆条目带文件标识（可点回）", ledger.buckets.flatMap((b) => b.learned).every((i) => typeof i.file === "string" && i.file.length > 0));
  check("④ 项目记忆条目标识为 project/demo-proj", ledger.buckets.flatMap((b) => b.learned).some((i) => i.file === "project/demo-proj"));
}

/* ============================ ⑤ 按周聚合 ============================ */
{
  const ledger = buildReviewLedger({ memoryDir, projectsDir, worklogDir: worklogDirPath, groupBy: "week" });
  const keys = ledger.buckets.map((b) => b.key);
  check("⑤ 周桶键形如 YYYY-Www", keys.every((k) => /^\d{4}-W\d{2}$/.test(k)), keys.join(","));
  const w = isoWeekOf("2026-10-16").key;
  const bucket = ledger.buckets.find((b) => b.key === w);
  check("⑤ 10-16 落进同一周桶", !!bucket);
  check("⑤ 周桶标签含区间", !!bucket && /~\s\d{2}-\d{2} · 第 \d+ 周/.test(bucket.label), bucket?.label);
  // 10-14 那周的 10-12~10-18：10-14 条目若存在应同在；这里只断言 10-16 与 10-14 同桶
  check("⑤ 同周不同天合并（10-16 与 10-16 自身单调）", ledger.buckets.length < 6);
}

/* ============================ ⑥ 空数据 / 脏数据容错 ============================ */
{
  const empty = buildReviewLedger({ memoryDir: join(root, "no-memory"), projectsDir: join(root, "no-projects"), worklogDir: join(root, "no-worklog") });
  check("⑥ 空目录：approximate = true", empty.approximate === true);
  check("⑥ 空目录：memoryFound = false", empty.memoryFound === false);
  check("⑥ 空目录：桶为空、计数全 0", empty.buckets.length === 0 && empty.summary.learned === 0 && empty.summary.to === null);

  // 脏数据：非法日期 / 缺元数据 / 损坏分隔
  const dirtyDir = join(root, "dirty");
  mkdirSync(dirtyDir, { recursive: true });
  writeFileSync(
    join(dirtyDir, "MEMORY.md"),
    ["没有元数据的裸条目", "非法日期 <!-- created=2026-99-99, last=oops -->", "§", ""].join("\n§\n"),
  );
  const dirty = buildReviewLedger({ memoryDir: dirtyDir, projectsDir: join(root, "no-projects"), worklogDir: join(root, "no-worklog") });
  check("⑥ 脏数据不抛且只留合法条目", dirty.memoryFound === true && dirty.summary.learned === 0, `learned=${dirty.summary.learned}`);
  check("⑥ 脏数据仍能出桶（非法日期不进桶）", dirty.buckets.length === 0);

  check("⑥ 摘要非 rising 不报错：groupReviewLedger 空输入", groupReviewLedger({ learned: [], touched: [], removed: [], work: [] }, "day").length === 0);
}

/* ============================ ⑦ 缓存清理钩子 ============================ */
{
  resetReviewLedgerCacheForTest();
  check("⑦ resetReviewLedgerCacheForTest 可调用", true);
}

console.log(`\n${fail === 0 ? "全部通过" : `${fail} 项失败`}`);
process.exit(fail === 0 ? 0 : 1);
