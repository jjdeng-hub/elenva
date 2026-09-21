#!/usr/bin/env node
"use strict";

/**
 * 便携包启动器 —— 由包内自带的 node.exe 运行，不依赖用户机器上的 Node。
 *
 * 与 bin/elenva-web.js 的分工：
 *   · bin/elenva-web.js  走 `next start`，需要项目 node_modules 里有 next CLI（开发/源码分发用）
 *   · 本文件直接跑 standalone 产物的 server.js（自包含，便携包用）
 *
 * 流程：端口已有服务 → 直接开窗；否则拉起 server.js → 轮询直到就绪 → App 模式开窗。
 */

const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

const pkgDir = __dirname;
const appDir = path.join(pkgDir, "app");
const serverEntry = path.join(appDir, "server.js");

const port = String(process.env.PORT || 30200);
const hostname = process.env.HOSTNAME || "127.0.0.1";
const url = `http://${hostname}:${port}`;
const useAppMode = process.env.PI_WEB_NO_APP !== "1";

function say(message) {
  process.stdout.write(`\n  ${message}\n`);
}

function fail(message) {
  process.stderr.write(`\n  [错误] ${message}\n\n`);
  process.stdout.write("  按任意键关闭…\n");
  process.exitCode = 1;
}

/** 找到可用的 Chromium 系浏览器（Edge / Chrome），用于 App 模式开窗。 */
function resolveChromium() {
  if (process.platform === "win32") {
    const pf = process.env.ProgramFiles || "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const local = process.env.LOCALAPPDATA || "";
    return [
      path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
    ].find((candidate) => candidate && fs.existsSync(candidate)) || null;
  }
  if (process.platform === "darwin") {
    return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => fs.existsSync(p)) || null;
  }
  return null;
}

/** 打开界面窗口：优先 App 模式（无地址栏、任务栏独立图标），否则退回默认浏览器。 */
function openWindow() {
  const chromium = useAppMode ? resolveChromium() : null;
  let opener;
  if (chromium) {
    opener = spawn(chromium, [`--app=${url}`, "--window-size=1440,900", "--no-first-run"], {
      stdio: "ignore",
      detached: true,
    });
  } else if (process.platform === "win32") {
    opener = spawn(process.env.ComSpec || "cmd.exe", ["/c", "start", "", url], {
      stdio: "ignore",
      detached: true,
    });
  } else if (process.platform === "darwin") {
    opener = spawn("open", [url], { stdio: "ignore", detached: true });
  } else {
    opener = spawn("xdg-open", [url], { stdio: "ignore", detached: true });
  }
  opener.on("error", (error) => say(`无法自动打开窗口（${error.message}），请手动访问 ${url}`));
  opener.unref();
}

/** 探测端口上是否已经有服务在响应。 */
function probe(callback) {
  const req = http.get({ host: hostname, port, path: "/", timeout: 1500 }, (res) => {
    res.resume();
    callback(true);
  });
  req.on("error", () => callback(false));
  req.on("timeout", () => {
    req.destroy();
    callback(false);
  });
}

function waitUntilReady(deadline, callback) {
  if (Date.now() > deadline) return callback(false);
  probe((ok) => (ok ? callback(true) : setTimeout(() => waitUntilReady(deadline, callback), 400)));
}

function startServer() {
  if (!fs.existsSync(serverEntry)) {
    return fail(`应用文件缺失：${serverEntry}。请重新解压安装包。`);
  }

  say(`正在启动 ELENVA（端口 ${port}）…`);
  const server = spawn(process.execPath, [serverEntry], {
    cwd: appDir,
    env: { ...process.env, PORT: port, HOSTNAME: hostname },
    stdio: ["ignore", "inherit", "inherit"],
  });

  server.on("error", (error) => fail(`无法启动服务：${error.message}`));

  waitUntilReady(Date.now() + 60_000, (ready) => {
    if (!ready) {
      server.kill();
      return fail(`服务在 60 秒内未就绪。端口 ${port} 可能已被其他程序占用。`);
    }
    say(`已就绪 → ${url}`);
    openWindow();
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => server.kill(signal));
  }
  server.on("exit", (code) => process.exit(code ?? 0));
}

// 已经有实例在跑就直接开窗，避免重复启动导致端口冲突
probe((alreadyRunning) => {
  if (alreadyRunning) {
    say(`检测到服务已在运行 → ${url}`);
    openWindow();
    return;
  }
  startServer();
});
