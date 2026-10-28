#!/usr/bin/env node
/**
 * ACP 运行时宿主 —— 把 Hermes 作为「子进程 Agent」接进 ELENVA。
 *
 * 为什么单独起一个进程，而不是在 Next 的 lib/ 里 spawn：
 * 仓库硬约束「lib/app/components/hooks 内零 spawn」（AGENTS.md · 架构要点）。
 * 于是把子进程边界放在 bin/，对上层暴露一个小 HTTP + SSE 接口；
 * Next 侧只用 fetch 说话，不碰进程。
 *
 * 协议：ACL 子进程说 ACP（JSON-RPC over stdio，一行一帧），宿主把它翻译成
 * 浏览器友好的 SSE 事件：
 *   {type:"update", update:{...}}           —— agent 的消息/思考/工具/用量
 *   {type:"permission", requestId, ...}      —— 需要用户拍板
 *   {type:"turn_end", stopReason, usage}     —— 一轮结束
 *   {type:"error", message}                  —— 起来失败或进程挂了
 *
 * 安全边界：只绑 127.0.0.1，不对外；profile 名只允许 [a-z0-9-]，避免参数注入。
 */
"use strict";

const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

const PORT = Number(process.env.ELENVA_ACP_PORT || 30201);
const HOST = "127.0.0.1";
const IDLE_MS = Number(process.env.ELENVA_ACP_IDLE_MS || 20 * 60 * 1000);
const MAX_AGENTS = Number(process.env.ELENVA_ACP_MAX_AGENTS || 4);
const PROFILE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** @type {Map<string, AgentProc>} */
const agents = new Map();
/** agentId → SSE 连接集合（agent 进程还没起来时也要能收到 ready） */
const subscribers = new Map();

function emitEvent(agentId, event) {
  const set = subscribers.get(agentId);
  if (!set) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of set) {
    try {
      res.write(payload);
    } catch {
      set.delete(res);
    }
  }
}

function log(...args) {
  process.stdout.write(`[acp-host] ${args.join(" ")}\n`);
}

class AgentProc {
  constructor(agentId, profile, cwd) {
    this.agentId = agentId;
    this.profile = profile;
    this.cwd = cwd;
    this.proc = null;
    this.sessionId = null;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map(); // rpc id -> {resolve, reject}
    this.permissions = new Map(); // rpc id -> resolve
    this.subscribers = new Set(); // res
    this.lastActivity = Date.now();
    this.state = "starting"; // starting | ready | dead
    this.error = null;
    this.usage = null;
  }

  emit(event) {
    emitEvent(this.agentId, event);
  }

  request(method, params) {
    const id = this.nextId++;
    const line = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.proc.stdin.write(line);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  reply(id, result) {
    try {
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
    } catch (error) {
      log(this.agentId, "reply failed", String(error));
    }
  }

  async start() {
    this.proc = spawn("hermes", ["-p", this.profile, "acp"], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => this.onData(chunk));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk) => {
      const text = String(chunk);
      // Hermes 启动时会刷一串插件注册日志；只在出错时留一行上下文
      if (/\b(ERROR|Traceback|CRITICAL)\b/.test(text)) this.error = text.slice(-500);
    });
    this.proc.on("exit", (code, signal) => {
      this.state = "dead";
      this.error = this.error || `ACP 进程退出（${signal || code}）`;
      for (const { reject } of this.pending.values()) reject(new Error(this.error));
      this.pending.clear();
      this.emit({ type: "error", message: this.error });
      log(this.agentId, "exit", signal || code);
    });

    const init = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "elenva-acp-host", version: "0.1.0" },
    });
    log(this.agentId, "initialized", init?.agentInfo?.name, init?.agentInfo?.version);

    const session = await this.request("session/new", { cwd: this.cwd, mcpServers: [] });
    this.sessionId = session?.sessionId ?? session?.session_id ?? null;
    if (!this.sessionId) throw new Error("session/new 没返回 sessionId");
    this.state = "ready";
    this.emit({ type: "ready", sessionId: this.sessionId, cwd: this.cwd, profile: this.profile });
  }

  onData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this.onFrame(msg);
    }
  }

  onFrame(msg) {
    this.lastActivity = Date.now();

    // agent → 客户端请求（权限等）
    if (msg.method && msg.id !== undefined) {
      if (msg.method === "session/request_permission") {
        this.permissions.set(msg.id, msg.id);
        this.emit({
          type: "permission",
          requestId: msg.id,
          toolCall: msg.params?.toolCall ?? null,
          options: msg.params?.options ?? [],
        });
        return;
      }
      // 没声明 fs/terminal 能力，理论上不会来；来了就明确拒绝
      this.reply(msg.id, {});
      return;
    }

    if (msg.method) {
      if (msg.method === "session/update") {
        const update = msg.params?.update ?? {};
        if (update.sessionUpdate === "usage_update") this.usage = update;
        this.emit({ type: "update", update });
      }
      return;
    }

    // 响应
    const waiter = this.pending.get(msg.id);
    if (waiter) {
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else waiter.resolve(msg.result);
      return;
    }
    // 没有 pending 的响应 = session/prompt 的收尾
    if (msg.error) {
      this.emit({ type: "error", message: msg.error.message || JSON.stringify(msg.error) });
    } else if (msg.result && typeof msg.result.stopReason === "string") {
      this.emit({ type: "turn_end", stopReason: msg.result.stopReason, usage: msg.result.usage ?? null });
    }
  }

  async prompt(text) {
    if (!this.sessionId) throw new Error("会话尚未建立");
    this.lastActivity = Date.now();
    const result = await this.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
    });
    // session/prompt 的响应带着 stopReason，是这一轮的真正收尾：
    // 从线程池/等待队列里回来时也要让前端把「运行中」放掉。
    this.emit({
      type: "turn_end",
      stopReason: result?.stopReason ?? "end_turn",
      usage: result?.usage ?? null,
    });
    return result;
  }

  resolvePermission(requestId, optionId) {
    if (!this.permissions.has(requestId)) return false;
    this.permissions.delete(requestId);
    this.reply(requestId, { outcome: { outcome: "selected", optionId } });
    return true;
  }

  stop() {
    try {
      this.proc?.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    this.state = "dead";
  }
}

async function ensureAgent(agentId, profile, cwd) {
  if (!PROFILE_RE.test(profile)) throw new Error(`profile 名不合法：${profile}`);
  const existing = agents.get(agentId);
  if (existing && existing.state !== "dead") return existing;
  if (agents.size >= MAX_AGENTS) {
    // 先回收最久没动静的
    const oldest = [...agents.values()].sort((a, b) => a.lastActivity - b.lastActivity)[0];
    oldest?.stop();
    agents.delete(oldest.agentId);
  }
  const agent = new AgentProc(agentId, profile, cwd || process.cwd());
  agents.set(agentId, agent);
  await agent.start();
  return agent;
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, {
      ok: true,
      agents: [...agents.values()].map((agent) => ({
        agentId: agent.agentId,
        profile: agent.profile,
        state: agent.state,
        sessionId: agent.sessionId,
        idleMs: Date.now() - agent.lastActivity,
        error: agent.error,
      })),
    });
  }

  if (req.method === "GET" && url.pathname === "/events") {
    const agentId = url.searchParams.get("agentId") || "";
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    res.write(`data: ${JSON.stringify({ type: "hello", agentId })}\n\n`);
    const set = subscribers.get(agentId) ?? new Set();
    subscribers.set(agentId, set);
    set.add(res);
    const agent = agents.get(agentId);
    if (agent?.state === "ready") {
      res.write(`data: ${JSON.stringify({ type: "ready", sessionId: agent.sessionId, cwd: agent.cwd, profile: agent.profile })}\n\n`);
    }
    if (agent?.error) res.write(`data: ${JSON.stringify({ type: "error", message: agent.error })}\n\n`);
    const heartbeat = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        clearInterval(heartbeat);
      }
    }, 15_000);
    req.on("close", () => {
      clearInterval(heartbeat);
      set.delete(res);
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/prompt") {
    try {
      const body = await readBody(req);
      const agent = await ensureAgent(body.agentId, body.profile, body.cwd);
      const text = String(body.text || "").trim();
      if (!text) return json(res, 400, { error: "text required" });
      agent.prompt(text).catch((error) => agent.emit({ type: "error", message: String(error) }));
      return json(res, 202, { ok: true, sessionId: agent.sessionId });
    } catch (error) {
      return json(res, 500, { error: String(error) });
    }
  }

  if (req.method === "POST" && url.pathname === "/permission") {
    try {
      const body = await readBody(req);
      const agent = agents.get(body.agentId);
      if (!agent) return json(res, 404, { error: "agent not running" });
      const ok = agent.resolvePermission(Number(body.requestId), String(body.optionId || "deny"));
      return json(res, ok ? 200 : 409, { ok });
    } catch (error) {
      return json(res, 500, { error: String(error) });
    }
  }

  if (req.method === "POST" && url.pathname === "/reset") {
    const body = await readBody(req).catch(() => ({}));
    const agent = agents.get(body.agentId);
    agent?.stop();
    if (agent) agents.delete(body.agentId);
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: "not found" });
});

server.listen(PORT, HOST, () => log(`listening http://${HOST}:${PORT}`));

setInterval(() => {
  for (const agent of agents.values()) {
    if (agent.state !== "dead" && Date.now() - agent.lastActivity > IDLE_MS) {
      log(agent.agentId, "idle timeout, stopping");
      agent.stop();
      agents.delete(agent.agentId);
    }
  }
}, 60_000).unref();

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    for (const agent of agents.values()) agent.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}

process.on("uncaughtException", (error) => log("uncaught", String(error)));
