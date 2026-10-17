/**
 * elenva-memory R3 自检：检索三层渐进披露 + 索引可重建。
 *
 * 六块（对应任务书 §验证）：
 *   1) 三模式输出：list（行式清单）/ ids（按 id 取详情卡）/ full（旧行为）断言；
 *   2) 预算截断：小预算 → 行数变少 + 显式「还有 N 条未展开」；
 *   3) 清单层标注：失效 / 冲突在**一行内**可见（精简不丢警示）；
 *   4) ids × 失效组合：按 id 取恒含失效条目并标注；未命中 id 有回执；6 位短 id 前缀可匹配；
 *   5) token 对比：≥10 命中场景 list 字符数 ≤ full 的 30%（本轮核心指标）；
 *   6) reindex：幂等（第二次增量为 0）+ 对账一致 + 备份落盘 + 「FTS 被清空 → 重建 → 检索恢复」。
 *
 * 跑法：node extensions/elenva-memory/selftest-r3.mjs
 * 全绿输出 SELFTEST-R3: OK；有失败输出 SELFTEST-R3: FAILED 并以退出码 1 结束。
 *
 * 注意：必须在 import 任何 vendor 模块**之前**设好 PI_CODING_AGENT_DIR——
 * vendor 的 `paths.ts` 在模块加载期就把 AGENT_ROOT 定死了。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const repoRoot = new URL("../..", import.meta.url).pathname;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "elenva-memory-r3-"));
const agentRoot = path.join(tmpRoot, "agent");
const memoryDir = path.join(agentRoot, "pi-hermes-memory");
const sessionsDir = path.join(agentRoot, "sessions");
fs.mkdirSync(memoryDir, { recursive: true });
fs.mkdirSync(sessionsDir, { recursive: true });
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

const storesMod = await jiti.import("./stores.ts");
const searchMod = await jiti.import("./search.ts");
const reindexMod = await jiti.import("./reindex.ts");
const { entryId } = storesMod;
const { searchEntries, renderSearchList, renderSearchDetails, renderSearchResults, findEntriesByIds, summarizeForList } =
  searchMod;
const { reindexIndexes } = reindexMod;
const { DatabaseManager } = await jiti.import("./vendor/pi-hermes-memory/src/store/db.ts");
const { searchSessions } = await jiti.import("./vendor/pi-hermes-memory/src/store/session-search.ts");

const emptyState = () => ({ version: 1, access: {}, conflicts: [], evidence: {}, toolCalls: {} });

// ── 0. 夹具：12 条有效（长正文，供 token 对比）+ 1 条失效 + 1 对冲突 ─────────
const LONG = "缓存策略的取舍：先用 LRU 挡住热数据，冷数据落磁盘；命中率低于 0.6 时改回直读，避免缓存反而拖慢。";
function longText(tag) {
  return `${tag}｜${LONG.repeat(8)}（虚构夹具）`;
}

const entries = [];
for (let i = 1; i <= 12; i += 1) {
  const text = longText(`缓存条目-${String(i).padStart(2, "0")}`);
  entries.push({ scope: "memory", text, created: "2026-01-01", last: "2026-10-16", invalidated: null, reason: null, id: entryId(text) });
}
const invalidText = `已废弃的缓存策略：端口 39999（虚构夹具）。`;
entries.push({ scope: "user", text: invalidText, created: "2026-01-01", last: "2026-10-16", invalidated: "2026-03-03", reason: "被新方案取代", id: entryId(invalidText) });
const conflictA = longText("缓存冲突-A：缓存过期时间设 60 秒");
const conflictB = longText("缓存冲突-B：缓存过期时间设 600 秒");
entries.push({ scope: "project", text: conflictA, created: "2026-01-01", last: "2026-10-16", invalidated: null, reason: null, id: entryId(conflictA) });
entries.push({ scope: "project", text: conflictB, created: "2026-01-01", last: "2026-10-16", invalidated: null, reason: null, id: entryId(conflictB) });

const storeSet = {
  agentRoot,
  projectName: null,
  stores: [{ scope: "memory", file: path.join(memoryDir, "MEMORY.md"), entries, rawChars: 0, limit: 5000 }],
};

const state = emptyState();
state.access[entries[0].id] = { count: 7, last: "2026-10-16" };
state.evidence[entries[0].id] = { tool: "memory_add", at: "2026-10-16T09:00:00.000Z" };
state.conflicts = [{ a: entryId(conflictA), b: entryId(conflictB), sim: 0.82, reason: "数字不一致", at: "2026-10-16" }];

const query = "缓存";
const hits = searchEntries(storeSet, state, query, 20);
check("夹具：默认检索命中 ≥10 条（不含失效）", hits.length >= 12, `hits=${hits.length}`);
check("夹具：默认检索不含失效条目", !hits.some((hit) => hit.entry.invalidated));

// ── 1. 三模式输出 ──────────────────────────────────────────────────────────
{
  const list = renderSearchList(hits, query, { budgetChars: 100000 });
  const lines = list.split("\n").filter((line) => line.startsWith("- ["));
  check("list：每条命中一行（行式清单）", lines.length === hits.length, `lines=${lines.length}/${hits.length}`);
  check("list：行格式 [SCOPE #id] 日期 · 摘要", /^- \[[A-Z]+ #[0-9a-f]{6}\] \d{4}-\d{2}-\d{2} · /.test(lines[0]), lines[0]?.slice(0, 80));
  check("list：头显式指引 ids / full", list.includes("ids") && list.includes("full: true"));
  check("list：不含全文（正文被摘要替代）", !list.includes(longText("缓存条目-01")), `fullText=${longText("缓存条目-01").length}chars`);
  const summary = summarizeForList(entries[0].text);
  check("list：摘要 ≤90 字符", summary.length <= 91, `len=${summary.length}`);
  check("list：清单行含来源 scope + 短 id", list.includes("[MEMORY #") && list.includes(entries[0].id.slice(0, 6)));

  const id = hits[0].entry.id.slice(0, 6);
  const byId = findEntriesByIds(storeSet, state, [id]);
  check("ids：6 位短 id 前缀可精确命中", byId.hits.length === 1 && byId.hits[0].entry.id === hits[0].entry.id);
  const detail = renderSearchDetails(byId.hits, [id], byId.missing);
  check("ids：详情卡含完整正文", detail.includes(entries.find((e) => e.id === hits[0].entry.id).text));
  check("ids：详情卡标「按 id 取详情」而非相关度", detail.includes("按 id 取详情") && !detail.includes("**相关度"));
  check("ids：详情卡含元数据（日期 / 引用次数）", /引用过 7 次/.test(detail) && /写入于 2026-10-16/.test(detail));

  const full = renderSearchResults(hits, query);
  check("full：回到旧行为（含相关度行）", full.includes("**相关度") && full.includes("词面"));
  check("full：含完整正文", full.includes(entries[0].text));
}

// ── 2. 预算截断 ────────────────────────────────────────────────────────────
{
  const small = renderSearchList(hits, query, { budgetChars: 500 });
  const smallLines = small.split("\n").filter((line) => line.startsWith("- ["));
  check("预算：小预算渲染行数变少", smallLines.length < hits.length, `lines=${smallLines.length}/${hits.length}`);
  check("预算：显式说明还有多少条未展开", /还有 \d+ 条未展开/.test(small));
  check("预算：字符数不超预算太多（头 + 行）", small.length < 500 + 260, `len=${small.length}`);
  const big = renderSearchList(hits, query, { budgetChars: 100000 });
  check("预算：大预算不截断（无未展开提示）", !big.includes("未展开"));
  const zero = renderSearchList(hits, query, { budgetChars: 0 });
  check("预算：非法预算回落到默认值（不崩）", zero.includes("记忆检索") && zero.includes("- ["));
}

// ── 3. 清单层标注可见（精简不丢警示）────────────────────────────────────────
{
  const withInvalid = searchEntries(storeSet, state, query, 20, { includeInvalidated: true });
  const list = renderSearchList(withInvalid, query, { budgetChars: 100000 });
  check("标注：失效在清单一行内可见", list.includes("⚠️ 已失效（2026-03-03：被新方案取代）"));
  check("标注：冲突在清单一行内可见", list.includes("疑似冲突"));
  const invalidLine = list.split("\n").find((line) => line.includes(entries.find((e) => e.invalidated).id.slice(0, 6)));
  check("标注：失效/冲突与摘要同处一行", Boolean(invalidLine) && !invalidLine.includes("\n"));
}

// ── 4. ids × 失效组合语义 ──────────────────────────────────────────────────
{
  const invalidEntry = entries.find((entry) => entry.invalidated);
  const byId = findEntriesByIds(storeSet, state, [invalidEntry.id.slice(0, 6)]);
  check("ids×失效：按 id 恒返回失效条目（显式召回）", byId.hits.length === 1 && byId.hits[0].entry.invalidated === "2026-03-03");
  const detail = renderSearchDetails(byId.hits, [invalidEntry.id.slice(0, 6)], byId.missing);
  check("ids×失效：详情卡标注已失效 + 恢复指引", detail.includes("已失效") && detail.includes("memory_status restore"));
  check("ids×失效：include_invalidated 不参与（函数签名里没有它）", findEntriesByIds.length === 3);

  const missing = findEntriesByIds(storeSet, state, ["deadbeef"]);
  check("ids：未命中 id 进 missing 回执", missing.hits.length === 0 && missing.missing[0] === "deadbeef");
  const missingText = renderSearchDetails(missing.hits, ["deadbeef"], missing.missing);
  check("ids：未命中时输出可读回执", missingText.includes("未找到") && missingText.includes("#deadbeef"));

  const mixed = findEntriesByIds(storeSet, state, [entries[0].id.slice(0, 6), "deadbeef", `#${entries[1].id.slice(0, 6)}`]);
  check("ids：混合命中/未命中各自归位", mixed.hits.length === 2 && mixed.missing.length === 1);
  check("ids：去重（同一 id 重复请求只回一条）", findEntriesByIds(storeSet, state, [entries[0].id.slice(0, 6), entries[0].id.slice(0, 8)]).hits.length === 1);
}

// ── 5. token 对比（本轮核心指标）────────────────────────────────────────────
{
  const all = searchEntries(storeSet, state, query, 20);
  const listChars = renderSearchList(all, query, { budgetChars: 100000 }).length;
  const fullChars = renderSearchResults(all, query).length;
  const ratio = listChars / fullChars;
  check("token：≥10 命中场景", all.length >= 10, `hits=${all.length}`);
  check("token：list ≤ full 的 30%", ratio <= 0.3, `list=${listChars} full=${fullChars} ratio=${(ratio * 100).toFixed(1)}%`);
  console.log(`      → token 对比：list ${listChars} 字符 vs full ${fullChars} 字符（${(ratio * 100).toFixed(1)}%，省 ${(100 - ratio * 100).toFixed(1)}%）`);
}

// ── 6. reindex：幂等 + 对账 + 备份 + 损坏恢复 ────────────────────────────────
{
  // 记忆文件（供镜像重扫）
  const memoryFile = path.join(memoryDir, "MEMORY.md");
  const userFile = path.join(memoryDir, "USER.md");
  const failuresFile = path.join(memoryDir, "failures.md");
  fs.writeFileSync(memoryFile, [
    `reindex 夹具条目一：缓存策略 alpha-7788（虚构）。 <!-- created=2026-01-01, last=2026-10-16 -->`,
    `reindex 夹具条目二：端口 30200（虚构）。 <!-- created=2026-01-02, last=2026-10-16 -->`,
  ].join("\n§\n"), "utf8");
  fs.writeFileSync(userFile, `reindex 用户画像夹具（虚构）。 <!-- created=2026-01-01, last=2026-10-16 -->`, "utf8");
  fs.writeFileSync(failuresFile, `reindex 失败夹具 beta-9911（虚构）。 <!-- created=2026-01-01, last=2026-10-16 -->`, "utf8");

  // 会话 JSONL（2 个会话）
  const sessionLines = (id, cwd, stamp, secret) => [
    JSON.stringify({ type: "session", id, cwd, timestamp: stamp }),
    JSON.stringify({ type: "message", id: `${id}-m1`, timestamp: stamp, message: { role: "user", content: [{ type: "text", text: `会话里提到 ${secret}（虚构）` }] } }),
    JSON.stringify({ type: "message", id: `${id}-m2`, timestamp: stamp, message: { role: "assistant", content: [{ type: "text", text: `已记录 ${secret} 的结论（虚构）` }] } }),
  ].join("\n");
  fs.writeFileSync(path.join(sessionsDir, "sess-r3-a.jsonl"), sessionLines("sess-r3-a", "/home/demo/pi-workspace", "2026-10-16T10:00:00.000Z", "gamma-5566"), "utf8");
  fs.writeFileSync(path.join(sessionsDir, "sess-r3-b.jsonl"), sessionLines("sess-r3-b", "/home/demo/pi-workspace", "2026-10-16T11:00:00.000Z", "delta-6677"), "utf8");

  const first = await reindexIndexes({ agentRoot, memoryDir, sessionsDir, cwd: agentRoot });
  check("reindex①：会话文件全量入库", first.sessions.files === 2 && first.sessions.indexed === 2, `files=${first.sessions.files} indexed=${first.sessions.indexed}`);
  check("reindex①：消息入库", first.totals.messages >= 4, `messages=${first.totals.messages}`);
  check("reindex①：记忆镜像重扫", first.markdown.entries >= 4 && first.markdown.imported >= 4, `entries=${first.markdown.entries} imported=${first.markdown.imported}`);
  check("reindex①：首次建库无库可备（不伪造快照）", first.backups.length === 0);
  check("reindex①：FTS 两个索引都重建", first.ftsRebuilt.includes("message_fts") && first.ftsRebuilt.includes("memory_fts"));
  check("reindex①：对账一致", first.reconcile.ok, first.reconcile.mismatches.join("；"));

  const second = await reindexIndexes({ agentRoot, memoryDir, sessionsDir, cwd: agentRoot });
  check("reindex②（幂等）：第二次零增量", second.sessions.indexed === 0 && second.sessions.messagesIndexed === 0 && second.markdown.imported === 0, `indexed=${second.sessions.indexed} msgs=${second.sessions.messagesIndexed} imported=${second.markdown.imported}`);
  check("reindex②（幂等）：计数与第一次一致", second.totals.sessions === first.totals.sessions && second.totals.messages === first.totals.messages);
  check("reindex②（幂等）：对账仍一致", second.reconcile.ok, second.reconcile.mismatches.join("；"));
  check("reindex②：库已存在时先备份后动作（快照落盘）", second.backups.length >= 1 && fs.existsSync(second.backups[0]), second.backups[0] ?? "（无备份）");

  // 场景：人为清空 FTS 索引 → integrity-check 失败 → reindex → 完整性恢复 + 检索恢复
  {
    const db = new DatabaseManager(memoryDir);
    const ftsOk = (table) => {
      try {
        db.getDb().exec(`INSERT INTO ${table}(${table}, rank) VALUES('integrity-check', 1)`);
        return true;
      } catch {
        return false;
      }
    };
    check("损坏前：FTS 完整性 ok（message_fts / memory_fts）", ftsOk("message_fts") && ftsOk("memory_fts"));
    check("损坏前：session_search 可检索", searchSessions(db, "gamma-5566", { limit: 5 }).length > 0);

    db.getDb().exec("INSERT INTO message_fts(message_fts) VALUES('delete-all')");
    check("损坏：FTS 索引与内容表不一致（integrity-check 失败）", !ftsOk("message_fts"));

    const rebuilt = await reindexIndexes({ agentRoot, memoryDir, sessionsDir, cwd: agentRoot });
    check(
      "重建：FTS 完整性恢复且对账一致",
      rebuilt.reconcile.ok && rebuilt.fts.messageIndexOk && rebuilt.fts.memoryIndexOk,
      `message=${rebuilt.fts.messageIndexOk} memory=${rebuilt.fts.memoryIndexOk} mismatches=${rebuilt.reconcile.mismatches.join("；")}`,
    );
    const db2 = new DatabaseManager(memoryDir);
    check("重建后：session_search 检索恢复", searchSessions(db2, "gamma-5566", { limit: 5 }).length > 0);
    db.close();
    db2.close();
  }

  // 场景：镜像行被删 → 对账能发现 → 重建修复
  {
    const db = new DatabaseManager(memoryDir);
    db.getDb().prepare("DELETE FROM memories WHERE content LIKE ?").run("%reindex 夹具条目二%");
    const drifted = await reindexIndexes({ agentRoot, memoryDir, sessionsDir, cwd: agentRoot });
    check("对账：镜像少行时 imported>0 且对账一致", drifted.markdown.imported >= 1 && drifted.reconcile.ok, `imported=${drifted.markdown.imported}`);
    db.close();
  }
}

// ── 收尾 ─────────────────────────────────────────────────────────────────────
try {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch {
  /* 临时目录清理失败不影响结论 */
}

console.log(`\nSELFTEST-R3: ${fail === 0 ? "OK" : "FAILED"} — ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exitCode = 1;
