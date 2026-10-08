#!/usr/bin/env node
"use strict";

/**
 * 生产模式启动器 —— 由根目录的 start.cmd 或 npm start 调用。
 *
 * 流程：Node 版本检查 → 依赖检查/安装 → 检查并构建 .next → 启动 next start
 * → 轮询就绪 → 打开系统默认浏览器。已有服务时只打开浏览器，不重复启动。
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
const nextBuildDir = path.join(projectDir, ".next");
const port = String(process.env.PORT || 30200);
const hostname = "127.0.0.1";
const url = `http://${hostname}:${port}`;
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function say(message) {
  process.stdout.write(`\n  ${message}\n`);
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
  const result = spawnSync(npmCommand, ["install"], {
    cwd: projectDir,
    stdio: "inherit",
    env: process.env,
  });
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

function latestSourceMtime(directory) {
  let latest = 0;
  const ignored = new Set([".git", ".next", "node_modules"]);
  const visit = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;
      const entryPath = path.join(current, entry.name);
      try {
        const stat = fs.statSync(entryPath);
        if (entry.isDirectory()) visit(entryPath);
        else if (stat.mtimeMs > latest) latest = stat.mtimeMs;
      } catch {
        // 文件可能在扫描过程中被编辑或删除，交给下一次启动处理。
      }
    }
  };
  visit(directory);
  return latest;
}

function needsBuild() {
  if (!fs.existsSync(nextBuildDir)) return true;
  const buildMtime = fs.statSync(nextBuildDir).mtimeMs;
  return latestSourceMtime(projectDir) > buildMtime;
}

function buildProduction() {
  say("生产构建不存在或已过期，正在构建…");
  const result = spawnSync(npmCommand, ["run", "build"], {
    cwd: projectDir,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    say(`无法执行 npm run build：${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    say(`生产构建失败（退出码 ${result.status ?? "未知"}）。`);
    return false;
  }
  return true;
}

function startProduction() {
  say(`正在启动生产服务（端口 ${port}）…`);
  const child = spawn(process.execPath, [nextBin, "start", "-H", hostname, "-p", port], {
    cwd: projectDir,
    stdio: ["ignore", "inherit", "inherit"],
    env: process.env,
  });

  child.on("error", (error) => {
    say(`无法启动服务：${error.message}`);
    process.exitCode = 1;
  });

  waitUntilReady(Date.now() + 180_000, (ready) => {
    if (!ready) {
      say("生产服务在 3 分钟内未就绪，请查看上方日志。");
      return;
    }
    say(`已就绪 → ${url}`);
    openBrowser();
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code) => process.exit(code ?? 0));
}

probe((alreadyRunning) => {
  if (alreadyRunning) {
    say(`服务已在运行 → ${url}`);
    say("这个窗口只用来打开浏览器，关闭它不会停止服务。");
    openBrowser();
    return;
  }

  if (!hasDependencies() && !installDependencies()) {
    process.exitCode = 1;
    return;
  }
  if (needsBuild() && !buildProduction()) {
    process.exitCode = 1;
    return;
  }
  startProduction();
});
