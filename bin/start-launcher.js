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
const buildStampFile = path.join(nextBuildDir, ".elenva-build-stamp");
const port = String(process.env.PORT || 30200);
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
  // 有效性判定用两道标记：
  // 1) .next/BUILD_ID —— 生产构建的存在标记（dev 缓存/半成品会让 next start 报
  //    "Could not find a production build"）；
  // 2) .elenva-build-stamp —— 由本启动器在「构建完整成功」后写入。构建中途失败
  //    （如类型检查报错）可能已留下 BUILD_ID，但不会有 stamp，因此仍会重建。
  const buildIdFile = path.join(nextBuildDir, "BUILD_ID");
  if (!fs.existsSync(buildIdFile)) return true;
  if (!fs.existsSync(buildStampFile)) return true;
  const buildMtime = fs.statSync(buildStampFile).mtimeMs;
  return latestSourceMtime(projectDir) > buildMtime;
}

function buildProduction() {
  say("生产构建不存在或已过期，正在构建…");
  // 旧的 .next 可能来自 dev 服务器（含 .next/dev/types 等）。这些文件会被 next build 的类型检查
  // 读入，残缺的 dev 缓存会直接导致 "Failed to type check"——重建前先清空，保证从干净状态构建。
  if (fs.existsSync(nextBuildDir)) {
    say("清理旧的构建产物（.next）…");
    try {
      fs.rmSync(nextBuildDir, { recursive: true, force: true });
    } catch (error) {
      say(`无法完全清理 .next（${error.message}），继续尝试构建…`);
    }
  }
  const result = runNpm(["run", "build"]);
  if (result.error) {
    say(`无法执行 npm run build：${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    say(`生产构建失败（退出码 ${result.status ?? "未知"}）。`);
    return false;
  }
  if (!fs.existsSync(path.join(nextBuildDir, "BUILD_ID"))) {
    say("构建结束但未生成构建标记（.next/BUILD_ID），视为失败——请查看上方日志。");
    return false;
  }
  try {
    fs.writeFileSync(buildStampFile, `launcher build ok at ${new Date().toISOString()}\n`);
  } catch {
    // 标记写不进去只意味着下次会重新构建，不影响本次启动。
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
