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
const fs = require("fs");
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

/**
 * 运行时预检（P0）：Hermes 不在 npm 依赖里，是 PATH 上的外部命令。
 * 没装时 spawn 会抛 ENOENT —— 在启动前先探一次，明确拒绝而不是等子进程崩。
 * 结果按 PATH 缓存（路径变了才重探）；探测失败视为未安装。
 */
const PREFLIGHT_TIMEOUT_MS = Number(process.env.ELENVA_ACP_PREFLIGHT_MS || 5000);
// 初始 path 用哨兵值，绝不与真实 PATH 相等 —— 否则首次调用会直接命中「未探测」的 false 缓存
let preflightCache = { path: "__unprobed__", installed: false };

function probeHermes() {
  return new Promise((resolve) => {
    const proc = spawn("hermes", ["--version"], { stdio: "ignore" });
    let settled = false;
    const done = (installed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { proc.kill(); } catch { /* ignore */ }
      resolve(installed);
    };
    const timer = setTimeout(() => done(false), PREFLIGHT_TIMEOUT_MS);
    proc.on("error", () => done(false)); // ENOENT / EACCES 等
    proc.on("exit", (code) => done(code === 0));
  });
}

async function hermesInstalled() {
  if (preflightCache.path === (process.env.PATH ?? "")) return preflightCache.installed;
  const installed = await probeHermes();
  preflightCache = { path: process.env.PATH ?? "", installed };
  return installed;
}

const HERMES_NOT_INSTALLED = "HERMES_NOT_INSTALLED";

function notInstalledError() {
  const error = new Error("这台机器没有安装 Hermes —— Agent 启动被拒绝。安装后重试（需要 hermes 在 PATH 里）。参考：https://github.com/jjdeng-hub/elenva");
  error.code = HERMES_NOT_INSTALLED;
  return error;
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
    /** 待处理的权限请求：id -> {requestId, title, options}（订阅重放与 /pending 都用它） */
    this.permissions = new Map();
    /** 串行化：同一 Agent 的 prompt 排队跑，避免两条并发把 turnText 搅在一起（会吞轮） */
    this.queue = Promise.resolve();
    this.queued = 0;
    this.subscribers = new Set(); // res
    this.lastActivity = Date.now();
    this.state = "starting"; // starting | ready | dead
    this.error = null;
    this.usage = null;
    /** 本轮 agent 的可见文本，收尾时落进历史 */
    this.turnText = "";
    /** Hermes 自动生成的会话标题（session_info_update） */
    this.title = null;
    /**
     * 本轮的流式事件日志：刷新页面 / 断线重连时补放，避免「回来只剩一个空输入框」。
     * 只存事件（update / permission / turn_end），不存状态快照。
     */
    this.turnEvents = [];
    /** ACP 给的可选模型清单（session/new 的 models）与当前选中项 */
    this.models = null;
  }

  // 会话历史不再由宿主落盘：单一真源是 Hermes 的 state.db，
  // 历史读取走资源层（lib/agents/resources.ts，按 cwd 认会话）。

  emit(event) {
    // 记进本轮日志：type=ready 之类的连接级事件不记，免得重放时把状态搅乱
    if (event && event.type !== "ready" && event.type !== "hello" && event.type !== "title") {
      if (event.type === "turn_end") this.turnDone = true;
      this.turnEvents.push(event);
      if (this.turnEvents.length > 400) this.turnEvents.splice(0, this.turnEvents.length - 400);
    }
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

  async start(resumeSessionId = null) {
    this.error = null;
    // 预检失败：明确拒绝，不让 ENOENT 走到子进程层
    if (!(await hermesInstalled())) throw notInstalledError();
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
    // spawn 失败（ENOENT / EACCES）不会触发 exit，只会发 error 事件：不兜住就是 unhandled，把宿主打挂
    this.proc.on("error", (error) => {
      this.state = "dead";
      this.error = error.code === "ENOENT"
        ? "这台机器没有安装 Hermes"
        : `Hermes 启动失败（${error.code || String(error)}）`;
      for (const { reject } of this.pending.values()) reject(new Error(this.error));
      this.pending.clear();
      this.emit({ type: "error", message: this.error });
      log(this.agentId, "spawn error", error.code || String(error));
    });
    this.proc.on("exit", (code, signal) => {
      this.state = "dead";
      if (this.stopping) {
        // 主动停止：只清理待办，不当作错误广播
        for (const { reject } of this.pending.values()) reject(new Error("ACP 进程已停止"));
        this.pending.clear();
        log(this.agentId, "stopped", signal || code);
        return;
      }
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

    // resume：加载历史会话（ACP session/load 会把历史事件重放出来，
    // 订阅者随后收到 user_message_chunk / agent_message_chunk / tool_call，界面即还原）
    if (resumeSessionId) {
      const loaded = await this.request("session/load", { sessionId: resumeSessionId, cwd: this.cwd, mcpServers: [] });
      this.sessionId = resumeSessionId;
      this.models = loaded?.models ?? null;
    } else {
      const session = await this.request("session/new", { cwd: this.cwd, mcpServers: [] });
      this.sessionId = session?.sessionId ?? session?.session_id ?? null;
      this.models = session?.models ?? null;
      if (!this.sessionId) throw new Error("session/new 没返回 sessionId");
    }
    this.state = "ready";
    this.emit({ type: "ready", sessionId: this.sessionId, cwd: this.cwd, profile: this.profile });
    if (this.models) this.emit({ type: "models", models: this.models });
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
        const entry = {
          requestId: msg.id,
          title: msg.params?.toolCall?.title ?? "（未命名操作）",
          toolCall: msg.params?.toolCall ?? null,
          options: msg.params?.options ?? [],
        };
        this.permissions.set(msg.id, entry);
        this.emit({ type: "permission", ...entry });
        return;
      }
      // 没声明 fs/terminal 能力，理论上不会来；来了就明确拒绝
      this.reply(msg.id, {});
      return;
    }

    if (msg.method) {
      if (msg.method === "session/update") {
        const update = msg.params?.update ?? {};
        const kind = update.sessionUpdate;
        if (kind === "usage_update") this.usage = update;
        if (kind === "session_info_update" && typeof update.title === "string" && update.title.trim()) {
          this.title = update.title.trim();
          this.emit({ type: "title", title: this.title });
        }
        if (kind === "agent_message_chunk" && typeof update.content?.text === "string") {
          this.turnText += update.content.text;
        }
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
    this.turnText = "";
    this.turnEvents = [];
    this.turnDone = false;
    this.lastPrompt = text;
    const result = await this.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
    });
    // 会话记录由 Hermes 自己写 state.db，宿主不再复制一份
    // session/prompt 的响应带着 stopReason，是这一轮的真正收尾：
    // 从线程池/等待队列里回来时也要让前端把「运行中」放掉。
    this.emit({
      type: "turn_end",
      stopReason: result?.stopReason ?? "end_turn",
      usage: result?.usage ?? null,
    });
    return result;
  }

  /** 发通知（无 id）—— ACP 里 cancel 是 notification，带 id 会 -32601 Method not found */
  notify(method, params) {
    try {
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    } catch (error) {
      log(this.agentId, "notify failed", String(error));
    }
  }

  async cancel() {
    if (!this.sessionId) return;
    this.lastActivity = Date.now();
    this.notify("session/cancel", { sessionId: this.sessionId });
  }

  /** 换模型：ACP 的 session/set_model，只影响这条会话，不改 profile 配置 */
  async setModel(modelId) {
    if (!this.sessionId) throw new Error("会话尚未建立");
    const result = await this.request("session/set_model", { sessionId: this.sessionId, modelId });
    if (result?.models) this.models = result.models;
    else if (this.models) this.models = { ...this.models, currentModelId: modelId };
    if (this.models) this.emit({ type: "models", models: this.models });
    return this.models;
  }

  /**
   * 排队跑一轮：上一轮没结束就等它（而不是并发插入）。
   * 并发会共用一个 turnText，前一轮的正文会丢——这就是之前「用户发了两条、只回了一条」的成因。
   */
  enqueuePrompt(text) {
    this.queued += 1;
    const run = this.queue.then(() => {
      this.queued = Math.max(0, this.queued - 1);
      return this.prompt(text);
    });
    this.queue = run.catch(() => {});
    return run;
  }

  resolvePermission(requestId, optionId) {
    if (!this.permissions.has(requestId)) return false;
    this.permissions.delete(requestId);
    this.reply(requestId, { outcome: { outcome: "selected", optionId } });
    return true;
  }

  stop() {
    // 主动停（重置会话 / 空闲回收）不是故障：退出回调里别再喊「ACP 进程退出」
    this.stopping = true;
    try {
      this.proc?.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    this.state = "dead";
  }
}

async function ensureAgent(agentId, profile, cwd, resumeSessionId = null) {
  if (!PROFILE_RE.test(profile)) throw new Error(`profile 名不合法：${profile}`);
  const existing = agents.get(agentId);
  // 同一个会话才复用；换会话必须重启进程（ACP 一个进程只挂一个 session）
  if (existing && existing.state !== "dead" && (!resumeSessionId || existing.sessionId === resumeSessionId)) return existing;
  if (existing) existing.stop();
  if (agents.size >= MAX_AGENTS) {
    // 先回收最久没动静的
    const oldest = [...agents.values()].sort((a, b) => a.lastActivity - b.lastActivity)[0];
    oldest?.stop();
    agents.delete(oldest.agentId);
  }
  const agent = new AgentProc(agentId, profile, cwd || process.cwd());
  agents.set(agentId, agent);
  try {
    await agent.start(resumeSessionId);
  } catch (error) {
    // 预检拒绝/初始化失败：进程没起来也把状态落成 dead + error ——
    // health 不再卡在 starting，SSE 晚订阅者也能补到这条错误
    agent.state = "dead";
    agent.error = agent.error || String(error.message || error);
    throw error;
  }
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

  if (req.method === "GET" && url.pathname === "/pending") {
    const agentId = url.searchParams.get("agentId") || "";
    const agent = agents.get(agentId);
    const pending = [...(agent?.permissions?.values() ?? [])].map((entry) => ({
      requestId: entry.requestId,
      title: entry.title,
      options: entry.options,
      // 带上 toolCall：审批卡要显示「改哪个文件、改了什么」（diff 在 content 里），
      // 刷新页面后也靠它把卡片补回来
      toolCall: entry.toolCall,
    }));
    return json(res, 200, { agentId, pending, queued: agent?.queued ?? 0, state: agent?.state ?? "idle" });
  }

  // /history 端点已移除：会话历史从 Hermes state.db 读（资源层），不再经宿主。

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
    // 补放本轮（还没收尾的）事件：刷新页面回来时，过程与审批卡都还在
    const current = agents.get(agentId);
    if (current && !current.turnDone && Array.isArray(current.turnEvents) && current.turnEvents.length > 0) {
      // 先把他刚才说的那句话补上，再补过程（流式事件里没有用户回显）
      if (current.lastPrompt) res.write(`data: ${JSON.stringify({ type: "user_message", text: current.lastPrompt })}\n\n`);
      for (const event of current.turnEvents) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    }
    const agent = agents.get(agentId);
    if (agent?.state === "ready") {
      res.write(`data: ${JSON.stringify({ type: "ready", sessionId: agent.sessionId, cwd: agent.cwd, profile: agent.profile })}\n\n`);
    }
    // 只在进程真的死了（且没被新进程替换）时把错误补发一次；
    // 之前是「只要有 error 就发」，于是回收进程后新订阅会先看到一条过期错误，像又崩了。
    if (agent?.error && agent.state === "dead") {
      res.write(`data: ${JSON.stringify({ type: "error", message: agent.error })}\n\n`);
    }
    // 订阅晚于权限请求时，把还挂着的审批重放一遍 —— 否则刷新页面就再也看不到那张卡。
    for (const entry of agent?.permissions?.values() ?? []) {
      res.write(`data: ${JSON.stringify({ type: "permission", ...entry })}\n\n`);
    }
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

  if (req.method === "POST" && url.pathname === "/resume") {
    try {
      const body = await readBody(req);
      if (!body.sessionId) return json(res, 400, { error: "sessionId required" });
      const old = agents.get(body.agentId);
      if (old) { old.stop(); agents.delete(body.agentId); }
      const agent = await ensureAgent(body.agentId, body.profile, body.cwd, String(body.sessionId));
      return json(res, 200, { ok: true, sessionId: agent.sessionId });
    } catch (error) {
      return json(res, 500, { error: String(error) });
    }
  }

  if (req.method === "POST" && url.pathname === "/prompt") {
    try {
      const body = await readBody(req);
      const agent = await ensureAgent(body.agentId, body.profile, body.cwd);
      const text = String(body.text || "").trim();
      if (!text) return json(res, 400, { error: "text required" });
      // 排队而不是并发：同一 Agent 两条 prompt 并发会共用 turnText，前一轮的正文会丢
      agent.enqueuePrompt(text).catch((error) => agent.emit({ type: "error", message: String(error) }));
      return json(res, 202, { ok: true, sessionId: agent.sessionId, queued: agent.queued });
    } catch (error) {
      return json(res, 500, { error: String(error) });
    }
  }

  if (req.method === "GET" && url.pathname === "/models") {
    try {
      const agentId = url.searchParams.get("agentId") || "";
      const start = url.searchParams.get("start") === "1";
      const existing = agents.get(agentId);
      if (!existing && !start) return json(res, 200, { models: null, state: "idle", sessionId: null });
      const agent =
        existing ??
        (await ensureAgent(
          agentId,
          url.searchParams.get("profile") || agentId,
          url.searchParams.get("cwd") || undefined,
        ));
      return json(res, 200, { models: agent.models, state: agent.state, sessionId: agent.sessionId });
    } catch (error) {
      return json(res, 500, { error: String(error) });
    }
  }

  if (req.method === "POST" && url.pathname === "/model") {
    try {
      const body = await readBody(req);
      const agent = agents.get(body.agentId);
      if (!agent || agent.state !== "ready") return json(res, 409, { error: "会话尚未就绪" });
      const models = await agent.setModel(String(body.modelId || ""));
      return json(res, 200, { models });
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

  if (req.method === "POST" && url.pathname === "/cancel") {
    try {
      const body = await readBody(req);
      const agent = agents.get(body.agentId);
      if (!agent) return json(res, 404, { error: "agent not running" });
      await agent.cancel();
      return json(res, 202, { ok: true });
    } catch (error) {
      return json(res, 500, { error: String(error) });
    }
  }

  if (req.method === "POST" && url.pathname === "/reset") {
    const body = await readBody(req).catch(() => ({}));
    const agent = agents.get(body.agentId);
    agent?.stop();
    if (agent) agents.delete(body.agentId);
    // 重置会话 = 停掉进程、下次重开新会话；历史记录归 Hermes state.db 管，宿主不清盘
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
