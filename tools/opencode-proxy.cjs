#!/usr/bin/env node
/**
 * opencode-go 转发代理（本地）。
 *
 * 为什么需要：opencode 的网关要求每个请求带 `x-opencode-session` 才能路由；
 * Pi 的 SDK 只在拿到 sessionId 时才加这个头，某些调用路径没传，网关就挂住直到客户端超时。
 * 这个代理把缺的头补上，并把实际发出的请求记一行，便于定位。
 *
 * 只监听 127.0.0.1，只转发到 opencode.ai。
 */
"use strict";

const http = require("http");
const https = require("https");
const { randomUUID } = require("crypto");
const fs = require("fs");

const PORT = Number(process.env.OPENCODE_PROXY_PORT || 30202);
const LOG = process.env.OPENCODE_PROXY_LOG || "/root/.hermes/cache/scratch/opencode-proxy.log";
/** 复用连接 + 固定 IPv4：opencode.ai 的 AAAA 记录在这台机器上不可达，
 * 不固定 family 时 Node 会先试 IPv6，失败后报 AggregateError，Pi 那边看起来就是超时。 */
const agent = new https.Agent({ keepAlive: true, maxSockets: 64 });

function log(line) {
  try {
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* 日志写不进去不影响转发 */
  }
}

const server = http.createServer((req, res) => {
  const hasSession = Boolean(req.headers["x-opencode-session"]);
  log(`${req.method} ${req.url} session=${hasSession ? "yes" : "MISSING"} ua=${req.headers["user-agent"] || "-"}`);

  const headers = { ...req.headers, host: "opencode.ai" };
  if (!hasSession) headers["x-opencode-session"] = randomUUID();
  if (!headers["x-opencode-client"]) headers["x-opencode-client"] = "pi";

  // 先把请求体收齐：连接失败要重试，流式 body 重试时读不到第二遍
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    if (body.length > 0) headers["content-length"] = String(body.length);

    let finished = false;
    const forward = (attempt) => {
      const upstream = https.request(
        {
          hostname: "opencode.ai",
          port: 443,
          path: req.url,
          method: req.method,
          headers,
          agent,
          family: 4,
        },
        (up) => {
          finished = true;
          log(`  -> ${up.statusCode} ${up.headers["content-type"] || ""} (attempt ${attempt})`);
          res.writeHead(up.statusCode || 502, up.headers);
          up.pipe(res);
        },
      );

      upstream.on("error", (error) => {
        log(`  !! upstream error ${error && error.code ? error.code : error} (attempt ${attempt})`);
        // 连不上就重试一次：这类错误多为瞬时 DNS/TCP 失败
        if (!finished && attempt < 3 && !res.headersSent) {
          setTimeout(() => forward(attempt + 1), 120 * attempt);
          return;
        }
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: String(error) } }));
      });

      if (body.length > 0) upstream.write(body);
      upstream.end();
    };

    forward(1);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  log(`listening on 127.0.0.1:${PORT}`);
  console.log(`opencode proxy on 127.0.0.1:${PORT}`);
});
