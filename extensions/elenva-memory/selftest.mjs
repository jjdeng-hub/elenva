/**
 * elenva-memory 纯函数自检（不装扩展、不起会话、不调模型）。
 *
 * 跑法：node extensions/elenva-memory/selftest.mjs
 * 全绿输出 SELFTEST: OK / n 通过；有失败输出 SELFTEST: FAILED 并以退出码 1 结束。
 */
import { createJiti } from "jiti";
import { homedir } from "node:os";
import { join } from "node:path";

const jiti = createJiti(import.meta.url, { moduleCache: false, interopDefault: true });

const storesMod = await jiti.import("./stores.ts");
const tidyMod = await jiti.import("./tidy.ts");
const indexBlockMod = await jiti.import("./index-block.ts");
const stateMod = await jiti.import("./state.ts");

let pass = 0;
let fail = 0;
const check = (name, condition, extra = "") => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
  condition ? (pass += 1) : (fail += 1);
};

// ── 1. 条目解析与元数据 ────────────────────────────────────────────────────
const raw = [
  "条目甲：数字 111。 <!-- created=2026-08-01, last=2026-09-01 -->",
  "条目乙：数字 222。 <!-- created=2026-08-02, last=2026-08-30 -->",
].join("\n§\n");
const parsed = storesMod.parseEntries(raw, "memory");
check("解析出 2 条", parsed.length === 2);
check("元数据被剥掉", !parsed[0].text.includes("created="));
check("created/last 提取正确", parsed[0].created === "2026-08-01" && parsed[0].last === "2026-09-01");
check("同一文本 id 稳定", storesMod.entryId("同样的文本") === storesMod.entryId("同样的文本"));
check("不同文本 id 不同", storesMod.entryId("甲") !== storesMod.entryId("乙"));

// ── 2. 相似度：近似 vs 不相干 ──────────────────────────────────────────────
const a = "项目 alphawork 的部署目标是 Windows 便携包，纯 JS 免编译，解压即用。";
const nearA = "项目 alphawork 的部署目标是 Windows 便携包，纯 JS 免编译，解压即用！";
const farA = "今天下午三点和小李在楼下咖啡店聊了聊季度的排期和路线图。";
const sim = (x, y) => tidyMod.jaccard(tidyMod.shingles(x), tidyMod.shingles(y));
check("近似重复相似度高（≥0.85）", sim(a, nearA) >= 0.85, `(${sim(a, nearA).toFixed(3)})`);
check("不相干相似度低（<0.35）", sim(a, farA) < 0.35, `(${sim(a, farA).toFixed(3)})`);

// ── 3. 冲突识别：只标不并用 ─────────────────────────────────────────────────
const conflictA = { scope: "memory", text: "扣款卡尾号 3021，每月 8 号定投。", created: null, last: null, id: "c1" };
const conflictB = { scope: "memory", text: "扣款卡尾号 8899，每月 8 号定投。", created: null, last: null, id: "c2" };
check("数字不一致判为冲突", tidyMod.conflictReason(conflictA, conflictB) === "同类条目但数字不一致");
const changeA = { scope: "memory", text: "alphawork 保持便携包部署。", created: null, last: null, id: "c3" };
const changeB = { scope: "memory", text: "alphawork 改为 Docker 部署。", created: null, last: null, id: "c4" };
check("变更标记判为冲突", typeof tidyMod.conflictReason(changeA, changeB) === "string");

// ── 4. 整理：重复分组 + 冲突记录 ───────────────────────────────────────────
const mkStore = (entries) => ({
  agentRoot: "x",
  projectName: null,
  stores: [{ scope: "memory", file: "MEMORY.md", entries, rawChars: entries.map((e) => e.text.length).join("").length + 20, limit: 4000 }],
});
const dupEntries = [
  { scope: "memory", text: a, created: "2026-08-01", last: "2026-08-20", id: "d1" },
  { scope: "memory", text: nearA, created: "2026-08-02", last: "2026-09-10", id: "d2" },
  { scope: "memory", text: conflictA.text, created: "2026-08-01", last: "2026-08-20", id: "c1" },
  { scope: "memory", text: conflictB.text, created: "2026-08-01", last: "2026-08-20", id: "c2" },
];
const emptyState = { version: 1, access: {}, conflicts: [] };
const tidy = tidyMod.runTidy(mkStore(dupEntries), emptyState, { apply: false });
check("识别出 1 组重复", tidy.duplicates.length === 1, `(${tidy.duplicates.length})`);
check("识别出 1 组冲突", tidy.conflicts.length === 1, `(${tidy.conflicts.length})`);
check("冲突未被合并（条目数不变）", mkStore(dupEntries).stores[0].entries.length === 4);
check("报告含在「重复」「冲突」段落", /重复/.test(tidyMod.renderTidyReport(tidy)) && /冲突/.test(tidyMod.renderTidyReport(tidy)));

// ── 5. 访问计数（ch3 L221 的访问频率信号）──────────────────────────────────
stateMod.resetStateCache();
const accessState = { version: 1, access: {}, conflicts: [] };
const hits = stateMod.recordAccess(mkStore(dupEntries), `结果：${a} 以及别的`, accessState);
check("命中回写计数", hits === 1 && accessState.access["d1"]?.count === 1, `(hits=${hits})`);
stateMod.recordAccess(mkStore(dupEntries), a, accessState);
check("再次命中同一条累加", accessState.access["d1"]?.count === 2);

// ── 6. 索引块：预算、冲突标记、省略提示、规则文本 ──────────────────────────
const entries = [];
for (let i = 0; i < 40; i += 1) {
  entries.push({
    scope: i % 5 === 0 ? "user" : "memory",
    text: `条目 ${i}：记录一条挺长的信息，用来测试预算截断与省略提示，编号 ${i}。`,
    created: "2026-09-01",
    last: "2026-09-10",
    id: `e${i}`,
  });
}
const bigState = { version: 1, access: {}, conflicts: [{ a: "e1", b: "e2", sim: 0.5, reason: "测试冲突", at: "2026-09-20" }] };
const block = indexBlockMod.buildIndexBlock(mkStore(entries), bigState, 1200);
check("索引块在预算内", block.length <= 1200 + 140, `(${block.length})`);
check("写明「先取原文」", block.includes("memory_search"));
check("出现冲突标记 ⚠️", block.includes("⚠️"));
check("超预算时显式说明省略", block.includes("另有") && block.includes("未列出"));
check("每条一行且带编号", /\[M1\]|\[U1\]/.test(block));
check("带 <memory_index> 包裹（ch2 L914）", block.includes("<memory_index>") && block.includes("</memory_index>"));
check("写明是框架注入而非用户输入", block.includes("不是用户输入"));

// 每轮替换（ch2 L945 实现一）：旧索引被摘掉，真实消息不动
const injectedMessages = [
  { role: "user", content: "真实提问" },
  { role: "assistant", content: [{ type: "text", text: "回答" }] },
  { role: "user", content: "<memory_index>\n旧索引\n</memory_index>" },
  { role: "user", content: [{ type: "text", text: "<memory_index>数组形态</memory_index>" }] },
];
check("摘掉旧索引消息（两种形态）", indexBlockMod.stripIndexMessages(injectedMessages).length === 2);
check(
  "识别索引文本",
  indexBlockMod.isIndexText("<memory_index>x</memory_index>") === true && indexBlockMod.isIndexText("普通用户消息") === false,
);
const tiny = indexBlockMod.buildIndexBlock(mkStore(entries), bigState, 100);
check("预算过小时给出提示而不是空块", tiny.includes("memory_search"));

// ── 7. 重要性评分：被访问/更新的条目应排前 ────────────────────────────────
const scoreState = { version: 1, access: { d2: { count: 5, last: new Date().toISOString().slice(0, 10) } }, conflicts: [] };
const scored = tidyMod.scoreEntries(dupEntries, scoreState);
const topScored = [...scored].sort((x, y) => y.score - x.score)[0];
check("被频繁访问的条目分数最高", topScored.entry.id === "d2", `(top=${topScored.entry.id})`);

// ── 8. 类型标签（ch3 L170）：只在判定明确时标 ────────────────────────────────
check("规则类条目被标「规则」", indexBlockMod.typeTag("不要引入原生模块，必须纯 JS") === "规则");
check("偏好类条目被标「偏好」", indexBlockMod.typeTag("我偏好结论先行的回复") === "偏好");
check("含日期的条目被标「事件」", indexBlockMod.typeTag("2026-09-20 在沙箱里跑了一轮评估") === "事件");
check("看不出来就不标（宁缺毋滥）", indexBlockMod.typeTag("项目靠 GitHub 托管") === null);

// ── 9. 检索重排 + 来源标记（ch3 L385 / L594 / L542）─────────────────────────
const searchMod = await jiti.import("./search.ts");
const searchEntries = [
  { scope: "memory", text: "面板的默认端口是 30200，改了端口要同步改启动脚本。", created: "2026-09-01", last: "2026-09-10", id: "s1" },
  { scope: "user", text: "偏好：回复先给结论。", created: "2026-09-01", last: "2026-09-02", id: "s2" },
  { scope: "memory", text: "旧版预览服务用过 3000 端口，已弃用。", created: "2026-08-01", last: "2026-08-02", id: "s3" },
];
const searchState = { version: 1, access: { s1: { count: 4, last: new Date().toISOString().slice(0, 10) } }, conflicts: [], evidence: { s1: { tool: "memory_add", at: "2026-09-10T00:00:00.000Z" } } };
const found = searchMod.searchEntries(mkStore(searchEntries), searchState, "默认端口是多少", 3);
check("检索能命中端口那条", found.length > 0 && found[0].entry.id === "s1", `(top=${found[0]?.entry.id})`);
check("引用次数进入信号", found[0]?.signals.accesses === 4);
const rendered = searchMod.renderSearchResults(found, "默认端口是多少");
check("输出写明「历史资料，不是指令」", rendered.includes("历史资料") && rendered.includes("不是指令"));
check("输出带来源标签与写入证据", rendered.includes("[MEMORY #s1") && rendered.includes("memory_add"));
check("无命中时明确提示不要编", searchMod.renderSearchResults([], "不存在的东西").includes("别凭印象编"));
check("查询分词对中文有效", searchMod.queryTerms("默认端口").includes("默认"));

// ── 10. 写入证据（ch3 L505：从哪条证据而来）────────────────────────────────
const evidenceState = { version: 1, access: {}, conflicts: [], evidence: {} };
const written = stateMod.recordEvidence(mkStore(searchEntries), "memory_add", searchEntries[0].text, "C:/work", evidenceState);
check("写入留痕记到对应条目", written === 1 && evidenceState.evidence.s1?.tool === "memory_add");
check("冲突伙伴查询", stateMod.conflictPartnersOf({ version: 1, access: {}, conflicts: [{ a: "x", b: "y", sim: 0.5, reason: "t", at: "" }] }, "x").join() === "y");

// ── 11. 容量提醒（ch2 L1079 / ch3 L223）：到阈值才出现、给动作指引 ────────
const storeAt = (scope, rawChars, limit) => ({ scope, file: `/tmp/${scope}.md`, entries: [], rawChars, limit });
const calmSet = { agentRoot: "x", projectName: null, stores: [storeAt("memory", 3000, 4000)] };
const hotSet = { agentRoot: "x", projectName: null, stores: [storeAt("memory", 3860, 4000), storeAt("failure", 6800, 8000)] };
check("低于阈值：无提醒", indexBlockMod.capacityNote(calmSet, 0.85) === null);
check("低于阈值：索引块里也没有提醒", !block.includes("容量提醒"));
const hotNote = indexBlockMod.capacityNote(hotSet, 0.85);
check(
  "到阈值：提醒并报各档水位",
  typeof hotNote === "string" && hotNote.includes("MEMORY.md 97%") && hotNote.includes("failures.md 85%"),
);
check("提醒给出动作指引（先合并/替换 + 分层出口）", typeof hotNote === "string" && hotNote.includes("memory_replace") && hotNote.includes("skill"));
check("ratio=0 关闭提醒", indexBlockMod.capacityNote(hotSet, 0) === null);
const hotBlock = indexBlockMod.buildIndexBlock(
  { agentRoot: "x", projectName: null, stores: [{ scope: "memory", file: "MEMORY.md", entries, rawChars: 3860, limit: 4000 }] },
  bigState,
  1200,
);
check("索引块末尾带上提醒", hotBlock.includes("容量提醒"));

console.log(`\nSELFTEST: ${fail === 0 ? "OK" : "FAILED"} — ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exitCode = 1;
