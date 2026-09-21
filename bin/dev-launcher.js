#!/usr/bin/env node
"use strict";

/**
 * 开发模式启动器 —— 由项目根目录的「开发模式.cmd」双击调用。
 *
 * 与 bin/elenva-web-portable.js 的分工：
 *   · elenva-web-portable.js → 跑 standalone 的 server.js（生产产物，无热更新，App 模式窗口）
 *   · 本文件                 → 跑 next dev（Turbopack，改代码秒级生效，普通浏览器窗口）
 *
 * 刻意使用系统默认浏览器（保留地址栏），以便与便携包的 App 模式窗口一眼区分。
 *
 * 流程：端口已有服务 → 直接开浏览器；否则拉起 next dev → 轮询直到就绪 → 开浏览器。
 */

const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

const projectDir = path.resolve(__dirname, "..");
const nextBin = path.join(projectDir, "node_modules", "next", "dist", "bin", "next");
const port = String(process.env.PORT || 30200);
const hostname = "127.0.0.1";
const url = `http://${hostname}:${port}`;

function say(message) {
  process.stdout.write(`\n  ${message}\n`);
}

/** 用系统默认浏览器打开（保留地址栏，便于识别"这是开发版"）。 */
function openBrowser() {
  let opener;
  if (process.platform === "win32") {
    opener = spawn(process.env.ComSpec || "cmd.exe", ["/c", "start", "", url], {
      stdio: "ignore",
      detached: true,
    });
  } else if (process.platform === "darwin") {
    opener = spawn("open", [url], { stdio: "ignore", detached: true });
  } else {
    opener = spawn("xdg-open", [url], { stdio: "ignore", detached: true });
  }
  opener.on("error", () => say(`无法自动打开浏览器，请手动访问 ${url}`));
  opener.unref();
}

/**
 * 请求首页。timeout 放宽到 90s —— 首次访问会触发 Turbopack 编译整条路由，
 * 实测约 6s，慢的时候更久，不能按普通探活用 1.5s。
 */
function probe(callback) {
  const req = http.get({ host: hostname, port, path: "/", timeout: 90_000 }, (res) => {
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
  probe((ok) => (ok ? callback(true) : setTimeout(() => waitUntilReady(deadline, callback), 300)));
}

function startDev() {
  if (!fs.existsSync(nextBin)) {
    say("找不到 next —— 请先在项目目录运行：npm install");
    process.exitCode = 1;
    return;
  }

  say(`正在启动开发服务（端口 ${port}）…`);
  const child = spawn(process.execPath, [nextBin, "dev", "-H", hostname, "-p", port], {
    cwd: projectDir,
    stdio: ["ignore", "inherit", "inherit"],
    env: process.env,
  });

  child.on("error", (error) => say(`无法启动服务：${error.message}`));

  waitUntilReady(Date.now() + 180_000, (ready) => {
    if (!ready) {
      say("开发服务在 3 分钟内未就绪，请查看上方日志。");
      return;
    }
    // 探测请求本身已经触发过首页编译，此刻开窗即可直接看到内容。
    say(`已就绪 → ${url}`);
    say("改代码保存后会自动更新，无需重启。");
    say("要停止服务，在这个窗口按 Ctrl+C。");
    openBrowser();
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code) => process.exit(code ?? 0));
}

// 已有实例在跑就直接开浏览器，避免重复启动撞端口
probe((alreadyRunning) => {
  if (alreadyRunning) {
    say(`开发服务已在运行 → ${url}`);
    // 这个窗口只负责开浏览器；服务跑在另一个窗口里，别让人误以为关掉它就能停服务
    say("这个窗口只用来打开浏览器，关闭它不会停止服务。");
    openBrowser();
    return;
  }
  startDev();
});
