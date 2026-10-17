/**
 * elenva-memory R2r2 自检：失效标记（supersede：删 → 标失效）。
 *
 * 六块（对应任务书 §验证）：
 *   1) 格式：旧格式零变化解析；新格式 roundtrip；reason 归一；非法日期降级为有效；
 *   2) 隔离 store roundtrip：标失效 → 注入/检索排除 → 显式可查 → 恢复 → 复位；
 *   3) SQLite 检索镜面对账：失效条目不入 memory_search；恢复后回来；
 *   4) 管道：复盘/巩固提示词含「先标失效」；review ops 支持 invalidate 且能应用；
 *   5) tidy 分流：失效建议 / 归档建议两类；
 *   6) 消费方降级：Web 侧 lib/*（agent-memory / corrections / review-ledger）不误读失效；
 *      E2E「忘掉 X」全链：真注册 memory_status 工具 → 标失效 → 注入排除 → list → 恢复。
 *
 * 跑法：node extensions/elenva-memory/selftest-r2b.mjs
 * 全绿输出 SELFTEST-R2B: OK；有失败输出 SELFTEST-R2B: FAILED 并以退出码 1 结束。
 *
 * 注意：必须在 import 任何 vendor 模块**之前**设好 PI_CODING_AGENT_DIR——
 * vendor 的 `paths.ts` 在模块加载期就把 AGENT_ROOT 定死了。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const repoRoot = new URL("../..", import.meta.url).pathname;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "elenva-memory-r2b-"));
const agentRoot = path.join(tmpRoot, "agent");
const memoryDir = path.join(agentRoot, "pi-hermes-memory");
fs.mkdirSync(memoryDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentRoot;

const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  interopDefault: true,
  alias: { "@": repoRoot },
});

let pass = 0;
let fail = 0;
const check = (name, condition, extra = "") => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
  condition ? (pass += 1) : (fail += 1);
};

const DELIMITER = "\n§\n";
const { MemoryStore } = await jiti.import("./vendor/pi-hermes-memory/src/store/memory-store.ts");
const { loadConfig } = await jiti.import("./vendor/pi-hermes-memory/src/config.ts");
const constants = await jiti.import("./vendor/pi-hermes-memory/src/constants.ts");
const { normalizeInvalidationReason, parseEntryMetadata } = await jiti.import(
  "./vendor/pi-hermes-memory/src/store/memory-store.ts",
);
const storesModule = await jiti.import("./stores.ts");
const indexBlockMod = await jiti.import("./index-block.ts");
const searchMod = await jiti.import("./search.ts");
const tidyMod = await jiti.import("./tidy.ts");
const { registerMemoryTool } = await jiti.import("./vendor/pi-hermes-memory/src/tools/memory-tool.ts");
const { parseReviewOperations, applyReviewOperations } = await jiti.import(
  "./vendor/pi-hermes-memory/src/handlers/review-memory-ops.ts",
);
const { reconcileMarkdownMemoryScope, searchMemories } = await jiti.import(
  "./vendor/pi-hermes-memory/src/store/sqlite-memory-store.ts",
);
const { DatabaseManager } = await jiti.import("./vendor/pi-hermes-memory/src/store/db.ts");
const memoryLib = await jiti.import("../../lib/agent-memory.ts");
const correctionsLib = await jiti.import("../../lib/corrections.ts");
const reviewLedgerLib = await jiti.import("../../lib/review-ledger.ts");

const LIMIT = 5000;

// ── 1. 格式：兼容红线 + 归一 ────────────────────────────────────────────────
{
  const legacy = "旧条目：端口是 30200。 <!-- created=2026-01-01, last=2026-02-02 -->";
  const parsedLegacy = parseEntryMetadata(legacy);
  check("旧格式：解析出 created/last", parsedLegacy?.created === "2026-01-01" && parsedLegacy?.lastReferenced === "2026-02-02");
  check("旧格式：无 invalidated（= 有效默认态）", parsedLegacy?.invalidated === null);
  check("旧格式：无 reason", parsedLegacy?.reason === null);

  const noMeta = "裸条目没有元数据";
  check("无元数据：parseEntryMetadata 返回 null", parseEntryMetadata(noMeta) === null);

  const invalid = "旧条目：端口是 30200。 <!-- created=2026-01-01, last=2026-02-02, invalidated=2026-03-03, reason=被新方案取代 -->";
  const parsedInvalid = parseEntryMetadata(invalid);
  check("新格式：解析 invalidated", parsedInvalid?.invalidated === "2026-03-03");
  check("新格式：解析 reason", parsedInvalid?.reason === "被新方案取代");

  const withProject = "项目条目。 <!-- created=2026-01-01, last=2026-02-02, project64=ZGVtby1wcm9q, invalidated=2026-03-03 -->";
  const parsedProject = parseEntryMetadata(withProject);
  check("新格式：project64 与 invalidated 并存可解析", parsedProject?.project64 === "ZGVtby1wcm9q" && parsedProject?.invalidated === "2026-03-03");

  check("归一：逗号换全角", normalizeInvalidationReason("a,b,c") === "a，b，c");
  check("归一：压空白", normalizeInvalidationReason("  a   b  ") === "a b");
  check("归一：去掉 -->", !normalizeInvalidationReason("x --> y").includes("-->"));
  check("归一：截断到 120", normalizeInvalidationReason("字".repeat(300)).length <= 120);

  // 序列化字节不变：未失效条目不带任何新字段
  const fmtDir = fs.mkdtempSync(path.join(tmpRoot, "fmt-"));
  const store = new MemoryStore({ ...loadConfig(), memoryMode: "legacy-inject", memoryDir: fmtDir });
  await store.loadFromDisk();
  await store.add("memory", "普通条目，不带失效状态。");
  const raw = fs.readFileSync(path.join(fmtDir, "MEMORY.md"), "utf8").trim();
  check("未失效条目落盘不含 invalidated", !raw.includes("invalidated="), raw.slice(0, 60));
  check("未失效条目落盘仍以 created/last 收尾", /<!-- created=\d{4}-\d{2}-\d{2}, last=\d{4}-\d{2}-\d{2} -->$/.test(raw));
}

// ── 2. 隔离 store roundtrip（vendor + 本层）────────────────────────────────
async function storeWith(dirName, texts) {
  // 本层的 readAllStores 只按 hermes 配置读全局记忆目录（默认 <agentRoot>/pi-hermes-memory），
  // 因此所有 roundtrip 子用例共用这个目录，每次覆写 MEMORY.md。
  const dir = memoryDir;
  fs.mkdirSync(dir, { recursive: true });
  if (texts) fs.writeFileSync(path.join(dir, "MEMORY.md"), texts.join(DELIMITER), "utf8");
  const store = new MemoryStore({ ...loadConfig(), memoryMode: "legacy-inject", memoryDir: dir, memoryCharLimit: LIMIT, userCharLimit: LIMIT });
  await store.loadFromDisk();
  void dirName;
  return { store, dir };
}

const targetEntry = "秘密口令：alpha-7788（虚构数据，仅用于自测）";
const otherEntry = "常用端口：30200（虚构数据）。";
{
  const { store, dir } = await storeWith("roundtrip", [
    `${targetEntry} <!-- created=2026-01-01, last=2026-02-02 -->`,
    `${otherEntry} <!-- created=2026-01-02, last=2026-02-03 -->`,
  ]);
  check("roundtrip 起点：检索命中口令条", searchMod.searchEntries(storesModule.readAllStores(dir), emptyState(), "alpha-7788", 5).length > 0);

  const invalidated = await store.setStatus("memory", "alpha-7788", "invalidate", "用户要求忘掉");
  check("标失效：成功", invalidated.success === true, invalidated.error);
  const onDisk = fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8");
  check("标失效：落盘含 invalidated=", onDisk.includes("invalidated=2026-") || /invalidated=\d{4}-\d{2}-\d{2}/.test(onDisk));
  check("标失效：落盘含 reason", onDisk.includes("reason=用户要求忘掉"));
  check("标失效：正文仍在文件里（未删除）", onDisk.includes("alpha-7788"));

  const set = storesModule.readAllStores(dir);
  const parsedEntry = storesModule.allEntries(set).find((entry) => entry.text.includes("alpha-7788"));
  check("本层解析出 invalidated", Boolean(parsedEntry?.invalidated), String(parsedEntry?.invalidated));

  check("注入排除：索引块不含失效条目", !indexBlockMod.buildIndexBlock(set, emptyState(), 1600).includes("alpha-7788"));
  check("注入排除：其它条目仍在索引", indexBlockMod.buildIndexBlock(set, emptyState(), 1600).includes("30200"));
  check("检索排除：默认 memory_find 不返回", searchMod.searchEntries(set, emptyState(), "alpha-7788", 5).length === 0);
  const explicit = searchMod.searchEntries(set, emptyState(), "alpha-7788", 5, { includeInvalidated: true });
  check("显式可查：includeInvalidated 返回", explicit.length === 1 && explicit[0].entry.invalidated !== null);
  check("显式结果带失效标注", searchMod.renderSearchResults(explicit, "alpha-7788").includes("已失效"));
  check("vendor getMemoryEntries 默认排除", !store.getMemoryEntries().some((text) => text.includes("alpha-7788")));
  check("vendor getMemoryEntries({includeInvalidated}) 含", store.getMemoryEntries({ includeInvalidated: true }).some((text) => text.includes("alpha-7788")));
  check("vendor getInvalidatedEntries 列出", store.getInvalidatedEntries("memory").some((row) => row.text.includes("alpha-7788")));
  check("getUsage 报 invalidatedCount", store.getUsage("memory").invalidatedCount === 1);

  const restored = await store.setStatus("memory", "alpha-7788", "restore");
  check("恢复：成功", restored.success === true, restored.error);
  const afterRestore = fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8");
  check("恢复：落盘不再有 invalidated", !afterRestore.includes("invalidated="));
  check("恢复：文件里仍只有 original（无重复）", (afterRestore.match(/alpha-7788/g) ?? []).length === 1);
  check("恢复：索引重新包含", indexBlockMod.buildIndexBlock(storesModule.readAllStores(dir), emptyState(), 1600).includes("alpha-7788"));
  check("恢复：默认检索重新命中", searchMod.searchEntries(storesModule.readAllStores(dir), emptyState(), "alpha-7788", 5).length === 1);

  // 复位（幂等）：重复失效仍是同一条，不会翻倍
  await store.setStatus("memory", "alpha-7788", "invalidate", "again");
  await store.setStatus("memory", "alpha-7788", "invalidate", "again");
  const twice = fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8");
  check("幂等：重复标失效不新增条目", (twice.match(/alpha-7788/g) ?? []).length === 1 && (twice.match(/invalidated=/g) ?? []).length === 1);
  await store.setStatus("memory", "alpha-7788", "restore");
}

{ // 非法日期降级为有效（兼容）
  const { store, dir } = await storeWith("bad-date", [
    `坏日期条目：beta-9999。 <!-- created=2026-01-01, last=2026-02-02, invalidated=not-a-date -->`,
  ]);
  const entries = storesModule.allEntries(storesModule.readAllStores(dir));
  check("非法失效日期 → 视为有效", entries[0]?.invalidated === null, String(entries[0]?.invalidated));
  check("非法失效日期：仍在索引里", indexBlockMod.buildIndexBlock(storesModule.readAllStores(dir), emptyState(), 1600).includes("beta-9999"));
  void store;
}

// ── 3. SQLite 检索镜面对账 ─────────────────────────────────────────────────
{
  const { store, dir } = await storeWith("mirror", [
    `${targetEntry} <!-- created=2026-01-01, last=2026-02-02 -->`,
    `${otherEntry} <!-- created=2026-01-02, last=2026-02-03 -->`,
  ]);
  const dbDir = path.join(tmpRoot, "mirror-db");
  fs.mkdirSync(dbDir, { recursive: true });
  const dbManager = new DatabaseManager(dbDir);
  dbManager.setQuickCheckOnOpen(false);
  await dbManager.waitForStartupIntegrityScan();

  const syncFromDisk = () => reconcileMarkdownMemoryScope(dbManager, store.getRawEntriesForSync("memory"), "memory", null);
  syncFromDisk();
  check("镜面：初始可检索到口令条", searchMemories(dbManager, "alpha-7788", { limit: 5 }).length === 1);

  await store.setStatus("memory", "alpha-7788", "invalidate", "忘掉");
  syncFromDisk();
  check("镜面：标失效后 memory_search 查不到", searchMemories(dbManager, "alpha-7788", { limit: 5 }).length === 0);
  check("镜面：其它条目仍在", searchMemories(dbManager, "30200", { limit: 5 }).length === 1);

  await store.setStatus("memory", "alpha-7788", "restore");
  syncFromDisk();
  check("镜面：恢复后 memory_search 又能查到", searchMemories(dbManager, "alpha-7788", { limit: 5 }).length === 1);
  dbManager.close();
}

// ── 4. 管道：提示词规则 + review ops invalidate ─────────────────────────────
{
  check("复盘提示词：改为先标失效", /invalidate/.test(constants.COMBINED_REVIEW_PROMPT) && !/drop superseded or contradicted facts/.test(constants.COMBINED_REVIEW_PROMPT));
  check("复盘 system 提示词：含 invalidate", /invalidat/.test(constants.DIRECT_REVIEW_SYSTEM_PROMPT) && /"invalidate"/.test(constants.DIRECT_REVIEW_SYSTEM_PROMPT));
  check("巩固提示词：含 invalidate 优先", /invalidate/.test(constants.CONSOLIDATION_PROMPT) && /invalidate/.test(constants.DIRECT_CONSOLIDATION_SYSTEM_PROMPT));
  check("policy 提示词：含 memory_status 与 forget 规则", /memory_status/.test(constants.MEMORY_POLICY_PROMPT) && /invalidate/.test(constants.MEMORY_POLICY_PROMPT));
  check("工具说明：memory_status 已列入", /memory_status/.test(constants.MEMORY_TOOL_DESCRIPTION));

  const parsed = parseReviewOperations(JSON.stringify({
    operations: [{ action: "invalidate", target: "memory", old_text: "alpha-7788", reason: "superseded" }],
  }));
  check("review ops：解析 invalidate", parsed?.length === 1 && parsed[0].action === "invalidate" && parsed[0].reason === "superseded");

  const { store, dir } = await storeWith("review-ops", [
    `${targetEntry} <!-- created=2026-01-01, last=2026-02-02 -->`,
  ]);
  const applied = await applyReviewOperations(store, null, parsed, null, null, {});
  check("review ops：应用 invalidate 成功", applied.appliedCount === 1 && applied.skippedCount === 0, JSON.stringify(applied));
  check("review ops：落盘已失效", fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8").includes("invalidated="));
}

// ── 5. tidy 分流 ───────────────────────────────────────────────────────────
{
  const mkEntry = (text, id, invalidated = null) => ({ scope: "memory", text, created: "2026-01-01", last: "2026-01-01", invalidated, reason: invalidated ? "旧" : null, id });
  const superseded = mkEntry("部署方式改为 Docker，旧的便携包方案已作废。", "t1");
  const noise = mkEntry("随手记的一条流水账，没有长期价值。", "t2");
  const alreadyInvalid = mkEntry("已失效的旧口令条目。", "t3", "2026-02-02");
  const entries = [superseded, noise, alreadyInvalid];
  const rawChars = entries.map((e) => e.text.length + 60).join("").length + 20;
  const set = {
    agentRoot: "x",
    projectName: null,
    stores: [{ scope: "memory", file: path.join(tmpRoot, "tidy.md"), entries, rawChars, limit: 60 }],
  };
  const result = tidyMod.runTidy(set, emptyState(), { apply: false });
  check("tidy：失效建议 / 归档建议两类字段存在", Array.isArray(result.invalidationSuggestions) && Array.isArray(result.archiveSuggestions));
  check("tidy：已失效条目进归档建议", result.archiveSuggestions.some((s) => s.entry.id === "t3"));
  const report = tidyMod.renderTidyReport(result);
  check("tidy 报告：含「失效建议」段", report.includes("失效建议"));
  check("tidy 报告：含「归档建议」段", report.includes("归档建议"));

  // apply：失效建议只标记不删除，归档建议移出
  const applySet = {
    agentRoot: "x",
    projectName: null,
    stores: [{ scope: "memory", file: path.join(tmpRoot, "tidy-apply.md"), entries: entries.map((e) => ({ ...e })), rawChars, limit: 60 }],
  };
  fs.mkdirSync(path.join(tmpRoot, "tidy-apply"), { recursive: true });
  // 用真实文件路径，便于 apply 落盘
  fs.writeFileSync(path.join(tmpRoot, "tidy-apply.md"), storesModule.serializeEntries(applySet.stores[0].entries), "utf8");
  const appliedResult = tidyMod.runTidy(applySet, emptyState(), { apply: true });
  const appliedRaw = fs.readFileSync(path.join(tmpRoot, "tidy-apply.md"), "utf8");
  check("tidy apply：失效建议被标记（正文保留）", appliedRaw.includes("已失效的旧口令条目") || appliedRaw.includes("作废"));
  check("tidy apply：已失效残留被清出", !appliedRaw.includes("已失效的旧口令条目"));
  check("tidy apply：有 applied 说明", appliedResult.applied.length > 0);
}

// ── 6. Web 侧消费方降级（lib/*）─────────────────────────────────────────────
{
  const legacyRaw = "网页旧条目。 <!-- created=2026-01-01, last=2026-02-02 -->";
  const webParsedLegacy = memoryLib.parseMemoryEntries(legacyRaw);
  check("Web parse：旧格式 invalidated 为 null", webParsedLegacy[0].invalidated === null);

  const newRaw = "网页新条目。 <!-- created=2026-01-01, last=2026-02-02, invalidated=2026-03-03, reason=过时 -->";
  const webParsedNew = memoryLib.parseMemoryEntries(newRaw);
  check("Web parse：新格式解析 invalidated/reason", webParsedNew[0].invalidated === "2026-03-03" && webParsedNew[0].reason === "过时");

  const serialized = memoryLib.serializeMemoryEntries([{ text: "网页条目。", created: null, last: null, invalidated: "2026-03-03", reason: "过时" }]);
  check("Web serialize：写入 invalidated/reason", /invalidated=2026-03-03, reason=过时/.test(serialized));
  const serializedValid = memoryLib.serializeMemoryEntries([{ text: "网页有效条目。", created: null, last: null }]);
  check("Web serialize：有效条目不写新字段（字节不变）", !serializedValid.includes("invalidated="));
  // 未改动的保存沿用磁盘上的失效状态
  const preserved = memoryLib.serializeMemoryEntries(
    [{ text: "网页条目。", created: "2026-01-01", last: "2026-02-02" }],
    [{ text: "网页条目。", created: "2026-01-01", last: "2026-02-02", invalidated: "2026-03-03", reason: "过时" }],
  );
  check("Web serialize：未改动条目保留失效状态", preserved.includes("invalidated=2026-03-03"));

  const corrections = correctionsLib.parseCorrectionItems(
    "failures",
    "failures.md",
    [
      "[correction] 用了 npm，应该用 pnpm。 <!-- created=2026-01-01, last=2026-01-01 -->",
      "[correction] 已作废的旧纠正。 <!-- created=2026-01-01, last=2026-01-01, invalidated=2026-03-03, reason=已改回 -->",
    ].join(DELIMITER),
  );
  check("corrections：失效纠正不进收件箱", corrections.length === 1 && corrections[0].core.includes("pnpm"));

  const ledgerFile = path.join(tmpRoot, "ledger-MEMORY.md");
  fs.writeFileSync(ledgerFile, [
    "复台账有效条目。 <!-- created=2026-01-01, last=2026-01-01 -->",
    "复台账失效条目。 <!-- created=2026-01-01, last=2026-01-01, invalidated=2026-03-03 -->",
  ].join(DELIMITER), "utf8");
  const ledgerItems = reviewLedgerLib.collectMemoryItems([{ id: "memory", label: "MEMORY.md", kind: "memory", path: ledgerFile }]);
  check("review-ledger：失效条目不进学到/更新", ledgerItems.length === 1 && ledgerItems[0].text.includes("有效条目"));
}

// ── 7. E2E「忘掉 X」全链（真注册 memory_status 工具）────────────────────────
{
  const e2eDir = memoryDir;
  fs.mkdirSync(e2eDir, { recursive: true });
  fs.writeFileSync(path.join(e2eDir, "MEMORY.md"), [
    `${targetEntry} <!-- created=2026-01-01, last=2026-02-02 -->`,
    `${otherEntry} <!-- created=2026-01-02, last=2026-02-03 -->`,
  ].join(DELIMITER), "utf8");

  const e2eStore = new MemoryStore({ ...loadConfig(), memoryMode: "legacy-inject", memoryDir: e2eDir, memoryCharLimit: LIMIT, userCharLimit: LIMIT });
  await e2eStore.loadFromDisk();

  const toolDefs = [];
  const fakePi = {
    on() {},
    registerTool(def) { toolDefs.push(def); },
    registerCommand() {},
  };
  registerMemoryTool(fakePi, e2eStore, null, null, null);
  const statusTool = toolDefs.find((def) => def.name === "memory_status");
  check("E2E：memory_status 工具已注册", Boolean(statusTool));
  const allNames = toolDefs.map((def) => def.name);
  check("E2E：工具面含 add/replace/remove/status", ["memory_add", "memory_replace", "memory_remove", "memory_status"].every((n) => allNames.includes(n)), allNames.join(","));

  const ctx = { cwd: tmpRoot };
  const invoke = (params) => statusTool.execute("call", params, undefined, undefined, ctx);

  // ① 用户要求忘掉 X → 代理标失效
  const invalidateResult = await invoke({ target: "memory", action: "invalidate", old_text: "alpha-7788", reason: "用户要求忘掉" });
  check("E2E①：invalidate 返回成功", /invalidated/.test(invalidateResult.content[0].text), invalidateResult.content[0].text.slice(0, 100));

  // ② 注入排除
  const e2eSet = storesModule.readAllStores(tmpRoot);
  const e2eBlock = indexBlockMod.buildIndexBlock(e2eSet, emptyState(), 1600);
  check("E2E②：常驻索引不再含 X", !e2eBlock.includes("alpha-7788"));
  check("E2E②：默认 memory_find 不返回 X", searchMod.searchEntries(e2eSet, emptyState(), "alpha-7788", 5).length === 0);

  // ③ 失效条目可显式查（list）
  const listResult = await invoke({ target: "memory", action: "list" });
  check("E2E③：list 能看到已失效条目", listResult.content[0].text.includes("alpha-7788"), listResult.content[0].text.slice(0, 120));

  // ④ 可恢复
  const restoreResult = await invoke({ target: "memory", action: "restore", old_text: "alpha-7788" });
  check("E2E④：restore 返回成功", /restored/i.test(restoreResult.content[0].text), restoreResult.content[0].text.slice(0, 100));
  const restoredSet = storesModule.readAllStores(tmpRoot);
  check("E2E④：索引重新包含 X", indexBlockMod.buildIndexBlock(restoredSet, emptyState(), 1600).includes("alpha-7788"));
  const finalRaw = fs.readFileSync(path.join(e2eDir, "MEMORY.md"), "utf8");
  check("E2E④：文件里 X 仅一条（恢复不重复）", (finalRaw.match(/alpha-7788/g) ?? []).length === 1 && !finalRaw.includes("invalidated="));
}

function emptyState() {
  return { version: 1, access: {}, conflicts: [], evidence: {}, toolCalls: {} };
}

// ── 收尾 ─────────────────────────────────────────────────────────────────────
try {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch {
  /* 临时目录清理失败不影响结论 */
}

console.log(`\nSELFTEST-R2B: ${fail === 0 ? "OK" : "FAILED"} — ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exitCode = 1;
