#!/usr/bin/env node
"use strict";

/**
 * 开发模式启动器 —— 由根目录的 dev.cmd 调用（也可 node bin/dev-launcher.js 手动跑）。
 *
 * 流程：Node 版本检查 → 依赖检查/安装 → 启动 next dev（Turbopack，热更新）
 * → 轮询就绪 → 打开系统默认浏览器。已有开发服务时只打开浏览器，不重复启动。
 *
 * 与生产模式（start-launcher.js）的区别：不做生产构建，源码改动即时生效；
 * 代价是页面首次打开需要现场编译。开发服务默认端口 30299，与生产（30200）
 * 可以同时运行。
 */

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { getUnsupportedNodeVersionMessage, isNodeVersionSupported } = require("./node-version");

if (!isNodeVersionSupported(process.versions.node)) {
  process.stderr.write(`${getUnsupportedNodeVersionMessage(process.versions.node)}\n`);
  process.exit(1);
}

const projectDir = path.resolve(__dirname, "..");
const nextBin = path.join(projectDir, "node_modules", "next", "dist", "bin", "next");
const port = String(process.env.PORT || 30299);
const hostname = "127.0.0.1";
const url = `http://${hostname}:${port}`;

function say(message) {
  process.stdout.write(`\n  ${message}\n`);
}

/** npm 在 Windows 上必须经 cmd 调用（.cmd 垫片不能直接 spawn——Node ≥ 20.12 会抛 EINVAL） */
function runNpm(args) {
  if (process.platform === "win32") {
    return spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `npm ${args.join(" ")}`], {
      cwd: projectDir,
      stdio: "inherit",
      env: process.env,
    });
  }
  return spawnSync("npm", args, { cwd: projectDir, stdio: "inherit", env: process.env });
}

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

function probe(callback) {
  const request = http.get({ host: hostname, port, path: "/", timeout: 90_000 }, (response) => {
    response.resume();
    callback(true);
  });
  request.on("error", () => callback(false));
  request.on("timeout", () => {
    request.destroy();
    callback(false);
  });
}

function waitUntilReady(deadline, callback) {
  if (Date.now() > deadline) return callback(false);
  probe((ready) => (ready ? callback(true) : setTimeout(() => waitUntilReady(deadline, callback), 300)));
}

function hasDependencies() {
  return fs.existsSync(nextBin);
}

function installDependencies() {
  say("未找到完整依赖，正在安装 npm 依赖…");
  const result = runNpm(["install"]);
  if (result.error) {
    say(`无法执行 npm install：${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    say(`npm install 失败（退出码 ${result.status ?? "未知"}）。`);
    return false;
  }
  return true;
}

function startDevelopment() {
  say(`正在启动开发服务（端口 ${port}，热更新）…`);
  const child = spawn(process.execPath, [nextBin, "dev", "-H", hostname, "-p", port], {
    cwd: projectDir,
    stdio: ["ignore", "inherit", "inherit"],
    env: process.env,
  });

  child.on("error", (error) => {
    say(`无法启动开发服务：${error.message}`);
    process.exitCode = 1;
  });

  waitUntilReady(Date.now() + 180_000, (ready) => {
    if (!ready) {
      say("开发服务在 3 分钟内未就绪，请查看上方日志。");
      return;
    }
    say(`已就绪 → ${url}`);
    say("改动即时生效；页面首次打开需要现场编译，稍等几秒。");
    openBrowser();
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code) => process.exit(code ?? 0));
}

// 自检模式：只验证 npm 调用链路（Windows CI 用——防 .cmd 直 spawn 回归）
if (process.argv.includes("--selftest-npm")) {
  const result = runNpm(["--version"]);
  if (result.error || result.status !== 0) {
    say(`npm 自检失败：${result.error ? result.error.message : `退出码 ${result.status}`}`);
    process.exit(1);
  }
  say("npm 自检通过");
  process.exit(0);
}

probe((alreadyRunning) => {
  if (alreadyRunning) {
    say(`开发模式已在运行 → ${url}`);
    say("这个窗口只用来打开浏览器；关闭它不会停止开发服务。");
    openBrowser();
    return;
  }

  if (!hasDependencies() && !installDependencies()) {
    process.exitCode = 1;
    return;
  }
  startDevelopment();
});
