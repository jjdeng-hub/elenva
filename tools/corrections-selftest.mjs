// 「纠正 → 规则」流水线的自检（lib/corrections.ts + lib/corrections-state.ts + app/api/corrections）。
// 运行：node tools/corrections-selftest.mjs
//
// 覆盖四层：
//   A. 纯函数：纠正识别 / 标签与理由剥离 / 草稿生成 / 复发相似度（阈值、排除自身、时间先后）
//   B. sidecar 状态：合并写 / 校验 / 删除 / 0600 / 损坏容错（隔离 agentDir）
//   C. 磁盘读取：只读扫描记忆文件里的 [correction] 条目
//   D. 路由链路：GET 汇总 / 升格写记忆（重读磁盘）/ 状态流转 / 复发对照 / 配额拒绝 / AGENTS.md 安全
//
// 隔离：PI_CODING_AGENT_DIR 指向 mkdtemp 出来的临时目录，全用**虚构**数据（ASCII 词 + 自造中文句），
// 不碰真实 ~/.pi/agent，也不写任何真实记忆。lib/*.ts 是纯 TS（无 JSX），jiti 可直载（见记忆 F1）。
import { createJiti } from "jiti";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "elenva-corrections-selftest-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const corr = await jiti.import("../lib/corrections.ts");
const state = await jiti.import("../lib/corrections-state.ts");

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
const eq = (actual, expected, message) =>
  assert.equal(actual, expected, `${message}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
const ok = (cond, message) => assert.ok(cond, message);

const memoryDir = join(agentDir, "pi-hermes-memory");
const failuresPath = join(memoryDir, "failures.md");
const globalMemoryPath = join(memoryDir, "MEMORY.md");
const statePath = join(agentDir, "elenva-corrections-state.json");

const C1 = "alpha beta gamma delta";
const C2 = "alpha beta gamma delta epsilon";
const FIXTURE = [
  `[correction] ${C1} — Failed: 虚构原因：先用了 npm。 <!-- created=2026-10-01, last=2026-10-01 -->`,
  "[insight] 这条不是纠正，不该进收件箱。 <!-- created=2026-10-02, last=2026-10-02 -->",
  `[correction] ${C2} <!-- created=2099-01-01, last=2099-01-01 -->`,
].join("\n§\n");

function seedFailures() {
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(failuresPath, `${FIXTURE}\n`, "utf8");
}

/* ============================ A. 纯函数 ============================ */

check("① 常量：纠正标签与复发阈值取 0.33（沿用记忆冲突刻度）", () => {
  eq(corr.CORRECTION_TAG, "[correction]", "标签");
  eq(corr.CORRECTION_RECURRENCE_THRESHOLD, 0.33, "复发阈值");
  eq(state.CORRECTIONS_STATE_LIMIT, 500, "状态上限");
});

check("② 纠正识别与标签剥离：支持重复标签", () => {
  ok(corr.isCorrectionText("[correction] 不要这样"), "带标签应识别");
  ok(corr.isCorrectionText("  [correction] 前面有空格"), "前导空格应识别");
  ok(!corr.isCorrectionText("[insight] 只是教训"), "其它分类不算纠正");
  eq(corr.stripCorrectionTag("[correction] [correction] 正文"), "正文", "重复标签应全部剥掉");
});

check("③ 理由剥离：`— Failed:` / `– Failed:` 都收，没有则 null", () => {
  const [a, ra] = corr.splitFailureReason(`正文 A — Failed: 原因 A`);
  eq(a, "正文 A", "陈述");
  eq(ra, "原因 A", "原因");
  const [b, rb] = corr.splitFailureReason("正文 B – Failed: 原因 B");
  eq(b, "正文 B", "en dash 陈述");
  eq(rb, "原因 B", "en dash 原因");
  eq(corr.splitFailureReason("就一段话")[1], null, "没有理由段");
});

check("④ id 稳定：带不带尾部元数据注释同 id（归一化口径）", () => {
  const id1 = corr.correctionIdOf("同一条纠正");
  const id2 = corr.correctionIdOf("同一条纠正 <!-- created=2026-10-01, last=2026-10-01 -->");
  eq(id1, id2, "元数据不应影响 id");
  ok(/^[0-9a-f]{16}$/.test(id1), `id 应是 16 位 hex，实得 ${id1}`);
});

check("⑤ 规则草稿：统一「今后：」开头 + 来源标注；已有前缀不重复", () => {
  eq(corr.ruleHead("不要这样"), "今后：不要这样", "加前缀");
  eq(corr.ruleHead("今后：不要这样"), "今后：不要这样", "不重复加");
  const item = {
    core: C1,
    label: "failures.md",
    createdAt: "2026-10-01",
    origin: { via: "agent", at: "2026-10-01T00:00:00.000Z", sessionId: "abcdefgh12345678", cwd: "/tmp/demo" },
  };
  const draft = corr.buildRuleDraft(item);
  eq(draft, `今后：${C1}（纠正升格 · 来源：failures.md · 2026-10-01 · 会话 abcdefgh）`, "升格草稿");
  eq(corr.ruleCoreOf(draft), `今后：${C1}`, "规则本体应剥掉来源标注");
});

check("⑥ AGENTS.md 草稿：注释提示不自动写 + bullet + 由来 + 来源", () => {
  const draft = corr.buildAgentsDraft({
    core: C1,
    failureReason: "虚构原因：先用了 npm。",
    label: "failures.md",
    createdAt: "2026-10-01",
    origin: null,
  });
  ok(draft.includes("不会自动写入"), "应含「不自动写」提示");
  ok(draft.includes(`- 今后：${C1}`), "应是可粘贴的 bullet");
  ok(draft.includes("由来：虚构原因：先用了 npm。"), "应带由来");
  ok(draft.includes("来源：failures.md · 2026-10-01"), "应带来源");
});

check("⑦ 解析：只挑 [correction]，抽日期/理由/核心，origin 可注入", () => {
  const items = corr.parseCorrectionItems("failures", "failures.md", FIXTURE, {
    get: (text) => (text.includes(C1) ? { via: "agent", at: "2026-10-01T00:00:00.000Z", cwd: "/tmp/demo" } : undefined),
  });
  eq(items.length, 2, "两条纠正");
  const a = items.find((i) => i.core === C1);
  eq(a.failureReason, "虚构原因：先用了 npm。", "理由");
  eq(a.createdAt, "2026-10-01", "创建日期");
  eq(a.origin?.cwd, "/tmp/demo", "来源可注入");
  const b = items.find((i) => i.core === C2);
  eq(b.createdAt, "2099-01-01", "第二条日期");
  eq(b.failureReason, null, "第二条无理由");
});

check("⑧ 复发相似度：阈值两侧 / 排除规则自身 / 只算升格之后", () => {
  const rule = (sourceCorrectionId, ruleCore, at = "2026-01-01T00:00:00.000Z", ruleHash = "h1") => ({
    sourceCorrectionId,
    ruleHash,
    ruleCore,
    at,
  });
  const c = (id, core, createdAt = null) => ({ id, core, createdAt });

  // 命中：4/5 = 0.8；不命中：1/5 = 0.2（都在 0.33 两侧）
  const r1 = corr.matchRecurrences(
    [c("c1", `${C1} epsilon`, "2026-02-01"), c("c2", "alpha zeta", "2026-02-01")],
    [rule("r-src", C1)],
  );
  ok(r1.byCorrection.c1, "相似 0.8 应命中");
  eq(r1.byCorrection.c1.ruleHash, "h1", "命中规则 hash");
  eq(r1.byCorrection.c2, undefined, "相似 0.2 不应命中");
  eq(r1.byRule.h1.length, 1, "规则命中计数");

  // 排除规则自身来源的那条纠正
  const r2 = corr.matchRecurrences([c("c1", C1, "2026-02-01")], [rule("c1", C1)]);
  eq(r2.byCorrection.c1, undefined, "不应把自己来源的纠正算作复发");

  // 只算规则升格「之后」的纠正；日期缺失时不过滤
  const r3 = corr.matchRecurrences([c("old", C1, "2025-01-01")], [rule("r-src", C1)]);
  eq(r3.byCorrection.old, undefined, "升格之前的纠正不算复发");
  const r4 = corr.matchRecurrences([c("nodate", C1, null)], [rule("r-src", C1)]);
  ok(r4.byCorrection.nodate, "日期缺失不过滤");

  // 没有已升格规则 → 空表（也顺带验证不抛）
  const r5 = corr.matchRecurrences([c("c1", C1, "2026-02-01")], []);
  eq(Object.keys(r5.byCorrection).length, 0, "无规则应返回空");
});

/* ============================ B. sidecar 状态 ============================ */

check("⑨ sidecar：创建 / 合并 / 校验 / 删除 + 0600 原子写", () => {
  rmSync(statePath, { force: true });
  eq(state.getCorrectionsStatePath(), statePath, "落在隔离 agentDir 内");

  const created = state.updateCorrectionState("x1", {
    status: "promoted",
    ruleHash: "hash-1",
    ruleCore: "今后：不要用 npm。",
    ruleText: "今后：不要用 npm。（纠正升格 · 来源：failures.md · 2026-10-01）",
    memoryFile: "memory",
  });
  eq(created.status, "promoted", "创建状态");
  eq(state.getCorrectionState("x1").memoryFile, "memory", "重读一致");
  eq(statSync(statePath).mode & 0o777, 0o600, "文件权限 0600");

  // 只改 status：其余字段保留（合并语义，不是整条替换）
  const resolved = state.updateCorrectionState("x1", { status: "resolved" });
  eq(resolved.status, "resolved", "改状态");
  eq(resolved.ruleHash, "hash-1", "改状态不应丢规则标识");
  eq(state.getCorrectionState("x1").ruleText?.includes("纠正升格"), true, "规则正文保留");

  // 非法 / 缺 status 且原本没有 → null（不落盘）
  eq(state.updateCorrectionState("x2", { status: "bogus" }), null, "非法状态应拒");
  eq(state.updateCorrectionState("x3", {}), null, "新条目缺状态应拒");
  eq(state.getCorrectionState("x2"), undefined, "被拒的条目不应落盘");

  eq(state.removeCorrectionState("x1"), true, "删除已有");
  eq(state.removeCorrectionState("x1"), false, "再次删除应为 false");
});

check("⑩ sidecar：损坏文件按空表处理；非法条目被丢弃", () => {
  writeFileSync(statePath, "not json at all", "utf8");
  eq(Object.keys(state.readCorrectionStates()).length, 0, "坏文件 → 空表");
  writeFileSync(
    statePath,
    JSON.stringify({ version: 1, items: { a: { status: "promoted", at: "2026-10-01T00:00:00.000Z" }, b: { status: "nope", at: "x" } } }),
    "utf8",
  );
  const all = state.readCorrectionStates();
  eq(Object.keys(all).length, 1, "只留合法条目");
  ok("a" in all, "合法条目保留");
});

/* ============================ C + D. 磁盘读取与路由链路 ============================ */

seedFailures();
const route = await jiti.import("../app/api/corrections/route.ts");
const getCorrections = async () => {
  const res = await route.GET();
  return { status: res.status, data: await res.json() };
};
const postCorrections = async (body) => {
  const res = await route.POST(
    new Request("http://localhost/api/corrections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, data: await res.json() };
};

await checkAsync("⑪ GET：只读扫描出纠正 + 统计 + 目标文件配额", async () => {
  const { status, data } = await getCorrections();
  eq(status, 200, "状态码");
  eq(data.items.length, 2, "两条纠正");
  eq(data.stats.pending, 2, "待处理 2");
  eq(data.rules.length, 0, "尚无已升格规则");
  eq(data.threshold, 0.33, "阈值透出");
  const failures = data.memoryFiles.find((f) => f.id === "failures");
  ok(failures, "应带 failures 目标与配额");
  ok(failures.limit > 0, "配额上限");
  ok(data.items.every((i) => i.ruleDraft.startsWith("今后：")), "每条都有规则草稿");
  ok(data.items.every((i) => i.agentsDraft.includes("不会自动写入")), "每条都有 AGENTS.md 草稿");
});

await checkAsync("⑫ 升格：写进目标记忆文件 + sidecar 状态 + 规则清单 + 复发对照", async () => {
  let { data } = await getCorrections();
  const first = data.items.find((i) => i.core === C1);
  const second = data.items.find((i) => i.core === C2);

  const promoted = await postCorrections({ action: "promote", id: first.id, file: "memory" });
  eq(promoted.status, 200, "升格状态码");
  eq(promoted.data.ok, true, "升格成功");
  const written = readFileSync(globalMemoryPath, "utf8");
  ok(written.includes(`今后：${C1}`), "规则正文应写入 MEMORY.md");
  ok(written.includes("纠正升格"), "应带来源标注");

  ({ data } = await getCorrections());
  const afterFirst = data.items.find((i) => i.id === first.id);
  eq(afterFirst.state.status, "promoted", "sidecar 记为已升格");
  eq(afterFirst.state.memoryFile, "memory", "记录去向");
  eq(data.stats.pending, 1, "待处理少一条");
  eq(data.rules.length, 1, "规则清单一条");
  ok(data.rules[0].ruleCore.startsWith("今后："), "规则本体去掉了来源标注");

  const afterSecond = data.items.find((i) => i.id === second.id);
  ok(afterSecond.recurrence, "第二条（时间在后、内容相似）应标可能复发");
  ok(afterSecond.recurrence.score >= 0.33, `相似度应 ≥0.33，实得 ${afterSecond.recurrence.score}`);
  eq(data.stats.recurrences, 1, "复发计数");
  eq(data.rules[0].hits.length, 1, "规则侧的命中计数");
});

await checkAsync("⑬ 状态流转：已处理 → 恢复待处理（sidecar 增删）", async () => {
  let { data } = await getCorrections();
  const second = data.items.find((i) => i.core === C2);

  const resolved = await postCorrections({ action: "resolve", id: second.id });
  eq(resolved.status, 200, "已处理状态码");
  ({ data } = await getCorrections());
  eq(data.items.find((i) => i.id === second.id).state.status, "resolved", "记为已处理");
  eq(data.stats.pending, 0, "无待处理");

  const reopened = await postCorrections({ action: "reopen", id: second.id });
  eq(reopened.status, 200, "恢复状态码");
  ({ data } = await getCorrections());
  eq(data.items.find((i) => i.id === second.id).state, null, "恢复后无状态");
  eq(data.stats.pending, 1, "待处理回来 1");

  // 对已不在记忆文件里的 id 做状态流转 → 409（不落状态）
  const ghost = await postCorrections({ action: "shelve", id: "deadbeefdeadbeef" });
  eq(ghost.status, 409, "找不到的纠正应 409");
});

await checkAsync("⑭ 配额硬拒：目标文件超限 → 400 over-limit，且不写 sidecar", async () => {
  // 把全局 MEMORY.md 写成超限单条（默认上限 4000）
  writeFileSync(globalMemoryPath, `${"填".repeat(5000)} <!-- created=2026-10-01, last=2026-10-01 -->\n`, "utf8");
  const { data } = await getCorrections();
  const second = data.items.find((i) => i.core === C2);
  const before = second.state;

  const res = await postCorrections({ action: "promote", id: second.id, file: "memory" });
  eq(res.status, 400, "超限应 400");
  eq(res.data.code, "over-limit", "错误码");
  ok(res.data.error.includes("超出配额"), "错误文案应说明配额");

  const after = (await getCorrections()).data.items.find((i) => i.id === second.id);
  eq(JSON.stringify(after.state), JSON.stringify(before), "写入失败不应改 sidecar");
});

await checkAsync("⑮ 安全：AGENTS.md 只出草稿，任何路径都没被写", async () => {
  const routeSource = readFileSync(new URL("../app/api/corrections/route.ts", import.meta.url), "utf8");
  ok(
    !routeSource.includes("context-files") && !routeSource.includes("appendContextInstruction"),
    "路由不应引入 AGENTS.md 写入链路（约定文件的写入函数）",
  );
  ok(!existsSync(join(agentDir, "AGENTS.md")), "隔离 agentDir 内不应出现 AGENTS.md");
  const { data } = await getCorrections();
  ok(data.items.every((i) => i.agentsDraft.includes("不会自动写入")), "草稿自带人工确认提示");
});

rmSync(root, { recursive: true, force: true });
console.log(fail === 0 ? "\n全部通过。" : `\n${fail} 项失败。`);
process.exit(fail === 0 ? 0 : 1);
