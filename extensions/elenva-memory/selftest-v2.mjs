/**
 * elenva-memory v2 骨架自检（收编后）：不调模型、不起会话，只验合体后的关键面。
 *
 * 覆盖（对应任务书 §3 的「新写的 v2 骨架自测」）：
 *   1) 工具注册面不重复，且含底座 + 本层的全部工具名；
 *   2) 记忆内容注入只此一家（底座 policy-only 只注入策略，不注入全文；本层 context 注入索引）；
 *   3) node:sqlite 建库 + FTS5 trigram 中文检索；
 *   4) MemoryStore 写入产生 `.recovery-` 快照（命名契约）；
 *   5) hermes-memory-config.json 读写（键名契约）。
 *
 * 跑法：node extensions/elenva-memory/selftest-v2.mjs
 * 全绿输出 SELFTEST-V2: OK；有失败输出 SELFTEST-V2: FAILED 并以退出码 1 结束。
 *
 * 注意：必须在 import 任何 vendor 模块**之前**设好 PI_CODING_AGENT_DIR——
 * vendor 的 `paths.ts` 在模块加载期就把 AGENT_ROOT 定死了。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "elenva-memory-v2-"));
const agentRoot = path.join(tmpRoot, "agent");
fs.mkdirSync(agentRoot, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentRoot;

// 让本层 / 底座的索引注入都指向同一份临时记忆目录
const memoryDir = path.join(agentRoot, "pi-hermes-memory");
fs.mkdirSync(memoryDir, { recursive: true });
const entryText = "面板的默认端口是 30200，改了端口要同步改启动脚本。";
fs.writeFileSync(
  path.join(memoryDir, "MEMORY.md"),
  `${entryText} <!-- created=2026-01-01, last=2026-01-01 -->\n`,
  "utf8",
);

const jiti = createJiti(import.meta.url, { moduleCache: false, interopDefault: true });

let pass = 0;
let fail = 0;
const check = (name, condition, extra = "") => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
  condition ? (pass += 1) : (fail += 1);
};

// ── 合体入口：用假 pi 记录注册面 ─────────────────────────────────────────────
const handlers = new Map();
const toolDefs = [];
const commandNames = [];
const fakePi = {
  on(name, handler) {
    const list = handlers.get(name) ?? [];
    list.push(handler);
    handlers.set(name, list);
  },
  registerTool(def) {
    toolDefs.push(def);
  },
  registerCommand(name) {
    commandNames.push(name);
  },
  exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
  sendUserMessage: () => {},
};

const merged = await jiti.import("./index.ts");
check("合并入口可加载并导出 default 函数", typeof merged.default === "function");
merged.default(fakePi);

// ── 1. 工具注册面 ────────────────────────────────────────────────────────────
const toolNames = toolDefs.map((def) => def.name);
const expectedTools = [
  "memory_add",
  "memory_replace",
  "memory_remove",
  "memory_status",
  "memory_search",
  "session_search",
  "skill_manage",
  "memory_find",
];
const missingTools = expectedTools.filter((name) => !toolNames.includes(name));
check("工具面齐全（底座 7 + memory_find）", missingTools.length === 0, `missing=${missingTools.join(",") || "none"}`);
const dupTools = toolNames.filter((name, index) => toolNames.indexOf(name) !== index);
check("工具无重复注册", dupTools.length === 0, `dups=${[...new Set(dupTools)].join(",") || "none"}`);
check(
  "工具名总数符合预期",
  new Set(toolNames).size === expectedTools.length,
  `(${new Set(toolNames).size})`,
);

const dupCommands = commandNames.filter((name, index) => commandNames.indexOf(name) !== index);
check("命令无重复注册", dupCommands.length === 0, `dups=${[...new Set(dupCommands)].join(",") || "none"}`);
check("tidy 命令已注册", commandNames.includes("memory-tidy"));
check("底座命令已注册（memory-skills）", commandNames.includes("memory-skills"));

// ── 2. 注入面只此一家 ────────────────────────────────────────────────────────
const contextHandlers = handlers.get("context") ?? [];
const beforeAgentStart = handlers.get("before_agent_start") ?? [];
check("context 注入钩子恰好 1 个（只此一家）", contextHandlers.length === 1, `(${contextHandlers.length})`);
check("底座 before_agent_start 恰好 1 个", beforeAgentStart.length === 1, `(${beforeAgentStart.length})`);

const injectCtx = {
  cwd: tmpRoot,
  sessionManager: { getSessionId: () => "selftest-session" },
};
const injectResult = await contextHandlers[0](
  { messages: [{ role: "user", content: "你好" }] },
  injectCtx,
);
const injectedText = (injectResult?.messages ?? [])
  .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
  .join("\n");
check("本层 context 注入了 <memory_index>", injectedText.includes("<memory_index>"));
check("索引块带上了记忆条目摘要", injectedText.includes("30200"));
check("注入只追加一条（真实消息保留）", (injectResult?.messages ?? []).length === 2);

const policyResult = await beforeAgentStart[0]({ systemPrompt: "BASE_PROMPT" }, { cwd: tmpRoot });
const policyText = policyResult?.systemPrompt ?? "";
check("底座仍注入策略提示词（语义未丢）", policyText.length > "BASE_PROMPT".length && policyText.includes("BASE_PROMPT"));
check("policy-only 下底座不注入记忆全文", !policyText.includes("30200"));
check("policy-only 下底座不注入索引块", !policyText.includes("<memory_index>"));

// ── 3. node:sqlite + FTS5 trigram ────────────────────────────────────────────
const { DatabaseManager } = await jiti.import("./vendor/pi-hermes-memory/src/store/db.ts");
const dbDir = path.join(tmpRoot, "db");
fs.mkdirSync(dbDir, { recursive: true });
const dbManager = new DatabaseManager(dbDir);
dbManager.setQuickCheckOnOpen(false);
const db = dbManager.getDb();
await dbManager.waitForStartupIntegrityScan();

const ftsRow = db
  .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_fts'")
  .get();
check("sessions.db 建出 memory_fts 虚表", Boolean(ftsRow?.sql));
check("memory_fts 用 trigram 分词器", /trigram/i.test(String(ftsRow?.sql ?? "")));

const now = new Date().toISOString();
db.prepare(
  "INSERT INTO memories (project, target, category, content, created, last_referenced) VALUES (?, ?, ?, ?, ?, ?)",
).run(null, "memory", null, "记忆模块的隔离真机验证用临时 agentDir", now, now);
const ftsHits = db
  .prepare("SELECT content FROM memory_fts WHERE memory_fts MATCH ?")
  .all("真机验证");
check("FTS 写入 + 中文 trigram 检索命中", ftsHits.length === 1, `(hits=${ftsHits.length})`);
const missHits = db
  .prepare("SELECT content FROM memory_fts WHERE memory_fts MATCH ?")
  .all("完全不相关的词");
check("不相干词不命中", missHits.length === 0);

const tx = db.transaction(() => {
  db.prepare(
    "INSERT INTO memories (project, target, category, content, created, last_referenced) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(null, "user", null, "事务里的第二条件", now, now);
});
tx();
const afterTx = db.prepare("SELECT COUNT(*) AS c FROM memories").get();
check("transaction() 包装可提交", Number(afterTx.c) === 2, `(count=${afterTx.c})`);
dbManager.close();

// ── 4. 写入产生 .recovery- 快照 ─────────────────────────────────────────────
const { MemoryStore } = await jiti.import("./vendor/pi-hermes-memory/src/store/memory-store.ts");
const { loadConfig } = await jiti.import("./vendor/pi-hermes-memory/src/config.ts");
const storeDir = path.join(tmpRoot, "store-check");
fs.mkdirSync(storeDir, { recursive: true });
const store = new MemoryStore({ ...loadConfig(), memoryDir: storeDir });
await store.loadFromDisk();
await store.add("memory", "第一条：写快照前的内容");
await store.add("memory", "第二条：触发前一条被搬进快照");
const snapshotNames = fs
  .readdirSync(storeDir)
  .filter((name) => /^\.MEMORY\.md\.recovery-\d+-[0-9a-f-]{36}$/i.test(name));
check("写入产生 .MEMORY.md.recovery-<ts>-<uuid> 快照", snapshotNames.length >= 1, `(${snapshotNames.length})`);
const savedEntries = fs.readFileSync(path.join(storeDir, "MEMORY.md"), "utf8");
check("快照后主文件保留两条（§ 分隔）", savedEntries.includes("第一条") && savedEntries.includes("第二条") && savedEntries.includes("\n§\n"));

// ── 5. config 读写 ──────────────────────────────────────────────────────────
const configPath = path.join(agentRoot, "hermes-memory-config.json");
const defaultCfg = loadConfig();
check("默认 memoryMode = policy-only", defaultCfg.memoryMode === "policy-only");
fs.writeFileSync(
  configPath,
  JSON.stringify({ memoryMode: "legacy-inject", userCharLimit: 1234, memoryDir: "pi-hermes-memory" }, null, 2),
  "utf8",
);
const overridden = loadConfig();
check("config 覆盖生效（memoryMode）", overridden.memoryMode === "legacy-inject");
check("config 覆盖生效（userCharLimit）", overridden.userCharLimit === 1234);
check("未覆盖键回落默认（memoryCharLimit）", overridden.memoryCharLimit === defaultCfg.memoryCharLimit);

// ── 收尾 ────────────────────────────────────────────────────────────────────
try {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch {
  /* 临时目录清理失败不影响结论 */
}

console.log(`\nSELFTEST-V2: ${fail === 0 ? "OK" : "FAILED"} — ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exitCode = 1;
