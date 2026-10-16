// MCP 连接探针（lib/mcp-probe.ts）的自检：
//   ① 真 stdio MCP 夹具 → connected + 工具数；② 拉不起的服务器 → failed；
//   ③ 不回包的服务器 → 超时且不留僵尸；④ disabled 跳过；⑤ 60s 缓存命中；
//   ⑥ 内部 runtime 导出形态断言（内核升级时能红）+ 错误截断纯函数。
// 运行：node tools/mcp-probe-selftest.mjs
//
// 隔离：PI_CODING_AGENT_DIR 指向 mkdtemp；MCP 夹具是本地临时脚本，全用虚构数据。
import { createJiti } from "jiti";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(join(tmpdir(), "elenva-mcp-probe-selftest-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";

const fixture = join(root, "mcp-fixture-server.mjs");
writeFileSync(fixture, `
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
const TOOLS = [
  { name: "read_thing", description: "read only", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "delete_thing", description: "delete by name", inputSchema: { type: "object", properties: {} } },
  { name: "purge_everything", description: "purge", inputSchema: { type: "object", properties: {} }, annotations: { destructiveHint: true } },
  { name: "list_things", description: "plain read", inputSchema: { type: "object", properties: {} } },
];
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize" && msg.id !== undefined) {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "probe-fixture", version: "0.1.0" } } });
    } else if (msg.method === "tools/list" && msg.id !== undefined) {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
    } else if (msg.method === "tools/call" && msg.id !== undefined) {
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok" }] } });
    } else if (msg.id !== undefined && msg.method !== "notifications/initialized") {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`);

// 「永不回包」的服务器：读 stdin 但不响应 initialize（触发探针超时）
const hangServer = join(root, "hang-server.mjs");
writeFileSync(hangServer, "process.stdin.on('data', () => {}); setInterval(() => {}, 1000);\n");

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const {
  probeMcpServers,
  resetMcpProbeState,
  truncateProbeError,
  MCP_PROBE_TIMEOUT_MS,
  MCP_PROBE_ERROR_CHARS,
} = await jiti.import("../lib/mcp-probe.ts");

let fail = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS  ${name}`); }
  catch (error) { fail += 1; console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`); }
};
const assert = (cond, message) => { if (!cond) throw new Error(message); };

const entry = (name, config, enabled = true) => ({ name, enabled, config });

// ── ① 真夹具：connected + 工具数 ─────────────────────────────────────
resetMcpProbeState();
await check("真 stdio 夹具 → connected（工具数 4）", async () => {
  const t0 = Date.now();
  const results = await probeMcpServers([entry("fixture", { command: process.execPath, args: [fixture] })], root);
  const r = results.get("fixture");
  assert(r?.state === "connected", `state=${r?.state} error=${r?.error}`);
  assert(r?.toolCount === 4, `toolCount=${r?.toolCount}`);
  assert(Date.now() - t0 < MCP_PROBE_TIMEOUT_MS, `应在超时内完成，用了 ${Date.now() - t0}ms`);
});

// ── ② 拉不起的服务器 → failed + 原因 ────────────────────────────────
resetMcpProbeState();
await check("拉不起的服务器 → failed（带原因）", async () => {
  const results = await probeMcpServers(
    [entry("broken", { command: "/nonexistent/mcp-server-xyz", args: [] })],
    root,
  );
  const r = results.get("broken");
  assert(r?.state === "failed", `state=${r?.state} error=${r?.error}`);
  assert(typeof r?.error === "string" && r.error.length > 0, "failed 应带原因");
});

// ── ③ 不回包 → 超时（≤5s+缓冲）且不留僵尸 ──────────────────────────
resetMcpProbeState();
await check("不回包的服务器 → 超时（卡在 5s 内）", async () => {
  const t0 = Date.now();
  const results = await probeMcpServers([entry("hang", { command: process.execPath, args: [hangServer] })], root);
  const r = results.get("hang");
  const elapsed = Date.now() - t0;
  assert(r?.state === "failed", `state=${r?.state}`);
  assert(elapsed < MCP_PROBE_TIMEOUT_MS + 2500, `应卡在超时附近，实际 ${elapsed}ms`);
  // 等连接收尾后再查僵尸
  await new Promise((resolve) => setTimeout(resolve, 800));
  const ps = execSync("ps -eo pid,args | grep '[h]ang-server.mjs' || true").toString().trim();
  assert(ps === "", `应无僵尸进程，实际：${ps}`);
});

// ── ④ disabled 服务器不探测 ─────────────────────────────────────────
resetMcpProbeState();
await check("disabled 服务器不进结果（不拉起进程）", async () => {
  const results = await probeMcpServers(
    [
      entry("on", { command: process.execPath, args: [fixture] }, true),
      entry("off", { command: "/nonexistent/should-not-run" }, false),
    ],
    root,
  );
  assert(results.get("on")?.state === "connected", JSON.stringify([...results]));
  assert(!results.has("off"), "disabled 不应出现在结果里");
});

// ── ⑤ 60s 缓存 ──────────────────────────────────────────────────────
resetMcpProbeState();
await check("60s 内命中缓存（不重复建连）", async () => {
  const entries = [entry("fixture", { command: process.execPath, args: [fixture] })];
  await probeMcpServers(entries, root);
  const t0 = Date.now();
  await probeMcpServers(entries, root);
  assert(Date.now() - t0 < 50, `命中缓存应很快，实际 ${Date.now() - t0}ms`);
});

// ── ⑥ 内部 runtime 导出形态（升级内核的回归闸门）+ 截断 ─────────────
await check("内核 MCP runtime 导出形态仍可用（McpServerConnection / createDefaultTransport）", async () => {
  const { getPackageDir } = await import("@earendil-works/pi-coding-agent");
  const url = pathToFileURL(join(getPackageDir(), "dist/extensions/mcp/runtime.js")).href;
  const mod = await import(url);
  assert(typeof mod.McpServerConnection === "function", "缺 McpServerConnection");
  assert(typeof mod.createDefaultTransport === "function", "缺 createDefaultTransport");
});

await check("truncateProbeError 截断到上限并加省略号", () => {
  const long = "x".repeat(MCP_PROBE_ERROR_CHARS + 50);
  const out = truncateProbeError(long);
  assert(out.length === MCP_PROBE_ERROR_CHARS, `长度=${out.length}`);
  assert(out.endsWith("…"), "应以省略号结尾");
  assert(truncateProbeError("short") === "short", "短错误原样保留");
  assert(truncateProbeError(undefined) === "", "undefined → 空串");
});

rmSync(root, { recursive: true, force: true });
console.log(fail === 0 ? "\n全部通过" : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
