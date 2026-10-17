#!/usr/bin/env node
/**
 * elenva-memory R3 隔离 E2E：装扩展 → 真实 agentDir 全链跑「清单 → 按 id 取详情 → full 对比」
 * + 「索引损坏 → /memory-reindex 重建 → 检索恢复」。
 *
 * 为什么用 install.mjs 装到临时 agentDir：E2E 要覆盖**真实注册面**（工具参数、命令 handler、
 * 环境变量驱动的 agentRoot），而不是直接调纯函数。临时目录放在仓库内（`tools/rev/`，已 gitignore），
 * 否则 jiti 从扩展文件向上找不到 node_modules（typebox / @earendil-works/*）。
 *
 * 跑法：node extensions/elenva-memory/e2e-r3.mjs
 * 全绿输出 E2E-R3: OK；有失败输出 E2E-R3: FAILED 并以退出码 1 结束。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";

const repo = new URL("../../", import.meta.url).pathname;
const revDir = path.join(repo, "tools", "rev");
fs.mkdirSync(revDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(revDir, ".r3-e2e-"));
const agentRoot = path.join(tmp, "agent");
// 必须在 import 任何 vendor / 扩展模块**之前**设好（paths.ts 在加载期定死 AGENT_ROOT）。
process.env.PI_CODING_AGENT_DIR = agentRoot;
const memoryDir = path.join(agentRoot, "pi-hermes-memory");
const sessionsDir = path.join(agentRoot, "sessions");
fs.mkdirSync(memoryDir, { recursive: true });
fs.mkdirSync(sessionsDir, { recursive: true });

const env = { ...process.env, PI_CODING_AGENT_DIR: agentRoot };
execFileSync("node", [path.join(repo, "extensions/elenva-memory/install.mjs")], { env, stdio: "inherit" });

const installedDir = path.join(agentRoot, "extensions", "elenva-memory");
const installed = path.join(installedDir, "index.ts");
console.log(`installed: ${installed}`);

// ── 夹具：记忆文件 + 会话 JSONL（明显虚构数据）──────────────────────────────
const LONG = "缓存策略：热数据走内存、冷数据落盘，命中率低于 0.6 就直读。";
// 12 条命中：与 selftest 同一口径（token 对比的 ≥10 命中场景）
const entries = Array.from({ length: 12 }, (_, index) => {
  const n = String(index + 1).padStart(2, "0");
  return `缓存夹具-${n}｜${LONG.repeat(14)}（虚构） <!-- created=2026-01-01, last=2026-10-16 -->`;
});
fs.writeFileSync(path.join(memoryDir, "MEMORY.md"), entries.join("\n§\n"), "utf8");
fs.writeFileSync(path.join(memoryDir, "USER.md"), `用户画像夹具（虚构）。 <!-- created=2026-01-01, last=2026-10-16 -->`, "utf8");
fs.writeFileSync(path.join(memoryDir, "failures.md"), `失败夹具（虚构）。 <!-- created=2026-01-01, last=2026-10-16 -->`, "utf8");
fs.writeFileSync(
  path.join(sessionsDir, "sess-r3-e2e.jsonl"),
  [
    JSON.stringify({ type: "session", id: "sess-r3-e2e", cwd: "/home/demo/pi-workspace", timestamp: "2026-10-16T10:00:00.000Z" }),
    JSON.stringify({ type: "message", id: "m1", timestamp: "2026-10-16T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "会话里的口令是 omega-8899（虚构）" }] } }),
    JSON.stringify({ type: "message", id: "m2", timestamp: "2026-10-16T10:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "已记录 omega-8899（虚构）" }] } }),
  ].join("\n"),
  "utf8",
);

const jiti = createJiti(import.meta.url, { moduleCache: false, interopDefault: true });
const merged = await jiti.import(installed);
const { DatabaseManager } = await jiti.import(path.join(installedDir, "vendor/pi-hermes-memory/src/store/db.ts"));
const { searchSessions } = await jiti.import(path.join(installedDir, "vendor/pi-hermes-memory/src/store/session-search.ts"));

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
  ok ? (pass += 1) : (fail += 1);
};

// ── 真实注册面 ─────────────────────────────────────────────────────────────
const toolDefs = [];
const commands = [];
const fakePi = {
  on() {},
  registerTool(def) { toolDefs.push(def); },
  registerCommand(name, def) { commands.push({ name, ...def }); },
  exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
  sendUserMessage() {},
};
merged.default(fakePi);

check("扩展注册了 memory_find", toolDefs.some((d) => d.name === "memory_find"), toolDefs.map((d) => d.name).join(","));
check("扩展注册了 /memory-reindex", commands.some((c) => c.name === "memory-reindex"), commands.map((c) => c.name).join(","));

const findTool = toolDefs.find((d) => d.name === "memory_find");
const reindexCmd = commands.find((c) => c.name === "memory-reindex");
const ctx = { cwd: tmp, ui: { notify: () => {} } };
const invoke = (params) => findTool.execute("call", params, undefined, undefined, ctx);

// ── ① 清单模式 ─────────────────────────────────────────────────────────────
const listResult = await invoke({ query: "缓存" });
const listText = listResult.content[0].text;
check("① list：默认模式（details.mode=list）", listResult.details.mode === "list", listResult.details.mode);
check("① list：行式清单格式", /^- \[MEMORY #[0-9a-f]{6}\] \d{4}-\d{2}-\d{2} · /m.test(listText));
check("① list：每条命中一行（≥10 命中场景）", (listText.match(/^- \[MEMORY #/gm) ?? []).length >= 10, `lines=${(listText.match(/^- \[MEMORY #/gm) ?? []).length}`);
check("① list：不含全文", !listText.includes(LONG.repeat(14)));
const idMatch = listText.match(/\[MEMORY #([0-9a-f]{6})\]/);
check("① list：能拿到短 id 供下一步", Boolean(idMatch), idMatch?.[1]);

// ── ② 按 id 取详情 ─────────────────────────────────────────────────────────
const detailResult = await invoke({ ids: [idMatch[1]] });
const detailText = detailResult.content[0].text;
check("② ids：details.mode=ids 且命中 1 条", detailResult.details.mode === "ids" && detailResult.details.hits === 1, JSON.stringify(detailResult.details));
check("② ids：返回完整正文", detailText.includes(LONG.repeat(14)));
check("② ids：标注「按 id 取详情」", detailText.includes("按 id 取详情"));

// ── ③ full 对比（token）────────────────────────────────────────────────────
const fullResult = await invoke({ query: "缓存", full: true, limit: 10 });
const fullText = fullResult.content[0].text;
check("③ full：回到旧详情卡行为", fullResult.details.mode === "full" && fullText.includes("**相关度"));
const ratio = listText.length / fullText.length;
check("③ token：list ≤ full 的 30%", ratio <= 0.3, `list=${listText.length} full=${fullText.length} ratio=${(ratio * 100).toFixed(1)}%`);

// ── ④ /memory-reindex 全链 ─────────────────────────────────────────────────
await reindexCmd.handler("", ctx);
{
  const db = new DatabaseManager(memoryDir);
  const sessions = Number(db.getDb().prepare("SELECT COUNT(*) as count FROM sessions").get().count);
  const messages = Number(db.getDb().prepare("SELECT COUNT(*) as count FROM messages").get().count);
  check("④ reindex：会话已入库", sessions === 1 && messages === 2, `sessions=${sessions} messages=${messages}`);
  check("④ reindex：session_search 可检索", searchSessions(db, "omega-8899", { limit: 5 }).length > 0);
  db.close();
}
// 再跑一次：库已存在 → 先备份后动作
await reindexCmd.handler("", ctx);
const backups = fs.readdirSync(path.join(memoryDir, "backups")).filter((name) => name.startsWith("sessions.db.reindex-"));
check("④ reindex：第二次先备份后动作", backups.length >= 1, backups.join(","));

// ── ⑤ 索引损坏 → 重建 → 检索恢复 ───────────────────────────────────────────
{
  const db = new DatabaseManager(memoryDir);
  const ftsOk = () => {
    try {
      db.getDb().exec("INSERT INTO message_fts(message_fts, rank) VALUES('integrity-check', 1)");
      return true;
    } catch {
      return false;
    }
  };
  check("⑤ 损坏前：FTS 完整性 ok", ftsOk());
  db.getDb().exec("INSERT INTO message_fts(message_fts) VALUES('delete-all')");
  check("⑤ 损坏：FTS integrity-check 失败", !ftsOk());
  db.close();

  await reindexCmd.handler("", ctx);

  const db2 = new DatabaseManager(memoryDir);
  let integrityOk = true;
  try {
    db2.getDb().exec("INSERT INTO message_fts(message_fts, rank) VALUES('integrity-check', 1)");
  } catch {
    integrityOk = false;
  }
  check("⑤ 重建：FTS 完整性恢复", integrityOk);
  check("⑤ 重建后：session_search 检索恢复", searchSessions(db2, "omega-8899", { limit: 5 }).length > 0);
  db2.close();
}

// ── 收尾 ─────────────────────────────────────────────────────────────────────
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nE2E-R3: ${fail === 0 ? "OK" : "FAILED"} — ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
