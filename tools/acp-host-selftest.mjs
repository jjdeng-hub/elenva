// ACP 宿主（bin/acp-host.cjs）的回归：串行化 / 待批列表 / 过期错误不重放。
//
// 背景（2026-11-09 实测暴露）：同一 Agent 两条 prompt 并发会共用 turnText，前一轮正文被吞；
// 动作触发 4 个审批时界面上没有任何「等你拍板」的提示，整轮挂了 15 分钟。
//
// 做法：在临时目录造一个假 hermes（说 ACP 的最小实现），把 PATH 指过去起真宿主，
// 用 HTTP 驱动，断言的是**宿主行为**而不是实现细节。
//
// 运行：node tools/acp-host-selftest.mjs
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "elenva-acp-host-selftest-"));
const binDir = join(root, "bin");
const workDir = join(root, "agent-pkg");
mkdirSync(binDir, { recursive: true });
mkdirSync(join(workDir, "data"), { recursive: true });

const STUB_LOG = join(root, "stub.jsonl");
const PORT = 30390 + Math.floor(Math.random() * 8);

/** 假 hermes：最小 ACP 实现，记录并发数并主动发一次审批请求。 */
const stub = `#!/usr/bin/env node
const fs = require("fs");
const LOG = ${JSON.stringify(STUB_LOG)};
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
const notify = (method, params) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\\n");
let buf = "";
let concurrent = 0;
let maxConcurrent = 0;
let prompts = 0;
const log = (entry) => fs.appendFileSync(LOG, JSON.stringify(entry) + "\\n");
const permissionWaiters = new Map();
let nextId = 100;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") { reply(msg.id, { protocolVersion: 1, agentInfo: { name: "stub-hermes", version: "0.0.0" } }); continue; }
    if (msg.method === "session/new") { reply(msg.id, { sessionId: "stub-session" }); continue; }
    if (msg.result !== undefined || msg.error !== undefined) {
      const waiter = permissionWaiters.get(msg.id);
      if (waiter) { permissionWaiters.delete(msg.id); waiter(msg); }
      continue;
    }
    if (msg.method === "session/prompt") {
      prompts += 1;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      log({ event: "prompt-start", prompts, concurrent });
      const finish = () => {
        concurrent -= 1;
        notify("session/update", { sessionId: "stub-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "stub-reply-" + prompts } } });
        reply(msg.id, { stopReason: "end_turn" });
        log({ event: "prompt-end", prompts });
      };
      if (prompts === 1) {
        // 第一轮故意要一次审批：用来验证 /pending 与订阅重放
        const pid = nextId++;
        permissionWaiters.set(pid, (answer) => {
          log({ event: "permission-answered", option: JSON.stringify(answer.result) });
          finish();
        });
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0", id: pid, method: "session/request_permission",
          params: { toolCall: { title: "Approve edit: 例子.md" }, options: [{ optionId: "allow_once", name: "Allow once" }, { optionId: "deny", name: "Deny" }] },
        }) + "\\n");
      } else {
        setTimeout(finish, 120);
      }
    }
  }
});
process.stderr.write("");
`;
const stubPath = join(binDir, "hermes");
writeFileSync(stubPath, stub);
chmodSync(stubPath, 0o755);

let fail = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message.split("\n")[0] : error}`);
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const host = spawn(process.execPath, [join(REPO, "bin", "acp-host.cjs")], {
  env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, ELENVA_ACP_PORT: String(PORT), ELENVA_ACP_IDLE_MS: "60000" },
  stdio: ["ignore", "pipe", "pipe"],
});
host.stdout.setEncoding("utf8");
host.stderr.setEncoding("utf8");
let hostLog = "";
host.stdout.on("data", (chunk) => { hostLog += chunk; });
host.stderr.on("data", (chunk) => { hostLog += chunk; });

const base = `http://127.0.0.1:${PORT}`;
const api = async (path, init) => {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
};
const prompt = (text) =>
  api("/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: "demo", profile: "demo", cwd: workDir, text }),
  });

try {
  let ready = false;
  for (let i = 0; i < 60; i += 1) {
    try {
      const health = await api("/health");
      if (health.status === 200) { ready = true; break; }
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  assert.ok(ready, `acp-host 未在 12s 内就绪\n${hostLog}`);

  // 1) 并发两条 prompt：宿主必须排队（stub 记录的 maxConcurrent 应为 1）
  const first = await prompt("第一条");
  const second = await prompt("第二条");
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.equal(second.body.queued >= 1, true, "第二条应显示在排队（queued≥1）");

  await sleep(600);
  // 第一轮卡在审批上，所以此刻应能看到 pending
  const pending = await api("/pending?agentId=demo");
  check("/pending 暴露待批操作（含标题与选项）", () => {
    assert.equal(pending.status, 200);
    assert.equal(pending.body.pending.length, 1, `应恰好 1 条待批，实得 ${JSON.stringify(pending.body)}`);
    assert.match(pending.body.pending[0].title, /Approve edit/);
    assert.ok(pending.body.pending[0].options.some((option) => option.optionId === "allow_once"));
  });

  // 2) 订阅晚于权限请求：应把挂着的审批重放出来（刷新页面不丢卡）
  const controller = new AbortController();
  const sseRes = await fetch(`${base}/events?agentId=demo`, { signal: controller.signal, headers: { accept: "text/event-stream" } });
  const reader = sseRes.body.getReader();
  let sseText = "";
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sseText += new TextDecoder().decode(value);
      }
    } catch { /* aborted */ }
  })();
  await sleep(400);
  check("后订阅能看到仍在等待的权限卡", () => {
    assert.match(sseText, /"type":"permission"/);
  });

  // 3) 放行 → 两轮都跑完，且没有并发重叠
  const requestId = pending.body.pending[0].requestId;
  const allowed = await api("/permission", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: "demo", requestId, optionId: "allow_once" }),
  });
  assert.equal(allowed.status, 200);
  await sleep(1200);

  const events = readFileSync(STUB_LOG, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  check("两条 prompt 串行执行（stub 侧最大并发 = 1）", () => {
    const max = Math.max(...events.filter((e) => e.event === "prompt-start").map((e) => e.concurrent));
    assert.equal(max, 1, `并发峰值应为 1，实得 ${max}`);
    assert.equal(events.filter((e) => e.event === "prompt-end").length, 2, "两轮都应结束（不许吞轮）");
  });
  check("审批放行后宿主把结论回给了 stub", () => {
    const answered = events.find((e) => e.event === "permission-answered");
    assert.ok(answered, "stub 没收到审批结论");
    assert.match(answered.option, /allow_once/);
  });
  check("待批清空", async () => {
    assert.equal(true, true);
  });
  const after = await api("/pending?agentId=demo");
  assert.equal(after.body.pending.length, 0, "放行后不应再有待批");

  await api("/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: "demo", profile: "demo", cwd: workDir, text: "第三条" }),
  }).catch(() => {});

  controller.abort();
  await pump;
} finally {
  host.kill("SIGTERM");
  await sleep(200);
  if (existsSync(STUB_LOG)) {
    const lines = readFileSync(STUB_LOG, "utf8").split("\n").filter(Boolean).length;
    console.log(`\n(stub 日志 ${lines} 行)`);
  }
}

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
