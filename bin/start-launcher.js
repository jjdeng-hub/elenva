#!/usr/bin/env node
"use strict";

/**
 * 生产模式启动器 —— 由根目录的 start.cmd 或 npm start 调用。
 *
 * 流程：Node 版本检查 → 依赖检查/安装 → 检查并构建 .next → 启动 next start
 * → 轮询就绪 → 打开系统默认浏览器。已有服务时只打开浏览器，不重复启动。
 *
 * 一键更新（2026-10-11 起）：启动器运行期间写心跳文件（.elenva-launcher.json），
 * 并轮询更新请求（.elenva-update.json，由网页「关于 → 更新到 vX.Y.Z」写入）：
 * 拉取代码 → 安装依赖（仅当依赖变化）→ 停服务 → 重建（失败自动回滚旧构建）
 * → 重启 → 打开浏览器。页面只负责下单与显示进度，执行权始终在启动器。
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
const updateStateFile = path.join(projectDir, ".elenva-update.json");
const heartbeatFile = path.join(projectDir, ".elenva-launcher.json");
const port = String(process.env.PORT || 30200);
const hostname = "127.0.0.1";
const url = `http://${hostname}:${port}`;
const updatePollMs = Number(process.env.ELENVA_UPDATE_POLL_MS || 3000);
const heartbeatMs = Number(process.env.ELENVA_HEARTBEAT_MS || 5000);

let currentChild = null;
let updating = false;
let monitorsStarted = false;
let lastHandledRequestAt = 0;

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

/** git 与 npm 同理：Windows 上是 git.cmd 垫片，必须经 cmd 调用。 */
function runGit(args, options = {}) {
  const capture = options.capture === true;
  const stdio = capture ? ["ignore", "pipe", "pipe"] : "inherit";
  if (process.platform === "win32") {
    return spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `git ${args.join(" ")}`], {
      cwd: projectDir,
      stdio,
      env: process.env,
      encoding: "utf8",
    });
  }
  return spawnSync("git", args, { cwd: projectDir, stdio, env: process.env, encoding: "utf8" });
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
  // 忽略的目录与运行状态文件（不算「源码」）：构建产物、依赖、日志目录、
  // 以及启动器/网页之间的更新与心跳状态（这些文件在每次启动时都会被改写）。
  const ignored = new Set([
    ".git",
    ".next",
    "node_modules",
    "logs",
    ".elenva-update.json",
    ".elenva-launcher.json",
    ".elenva-update.json.tmp",
  ]);
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

function startProduction(onReady) {
  say(`正在启动生产服务（端口 ${port}）…`);
  const child = spawn(process.execPath, [nextBin, "start", "-H", hostname, "-p", port], {
    cwd: projectDir,
    stdio: ["ignore", "inherit", "inherit"],
    env: process.env,
  });
  currentChild = child;

  child.on("error", (error) => {
    say(`无法启动服务：${error.message}`);
    process.exitCode = 1;
  });

  waitUntilReady(Date.now() + 180_000, (ready) => {
    if (currentChild !== child) return;
    if (!ready) {
      say("生产服务在 3 分钟内未就绪，请查看上方日志。");
      if (onReady) onReady(false);
      return;
    }
    say(`已就绪 → ${url}`);
    openBrowser();
    if (onReady) onReady(true);
  });

  child.on("exit", (code) => {
    if (updating || currentChild !== child) return;
    process.exit(code ?? 0);
  });
}

/* ---------------- 一键更新 ---------------- */

function readUpdateState() {
  try {
    return JSON.parse(fs.readFileSync(updateStateFile, "utf8"));
  } catch {
    return null;
  }
}

function writeUpdateState(phase, message, extra = {}) {
  const previous = readUpdateState() ?? {};
  const state = { ...previous, ...extra, phase, message, updatedAt: Date.now() };
  try {
    const tmp = `${updateStateFile}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    fs.renameSync(tmp, updateStateFile);
  } catch {
    // 状态写不进去只影响页面显示，不阻断更新本身。
  }
  say(`[更新] ${message}`);
}

function writeHeartbeat() {
  try {
    fs.writeFileSync(heartbeatFile, `${JSON.stringify({ pid: process.pid, at: Date.now() })}\n`);
  } catch {
    // 心跳写不进去意味着网页端判定「无启动器」；不额外处理。
  }
}

function readPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "";
  } catch {
    return "";
  }
}

/** 干净检查时忽略的运行状态文件：更新/心跳状态与 Next 自动改写的类型声明。 */
function isUpdateNoise(line) {
  return line.includes(".elenva-update.json")
    || line.includes(".elenva-launcher.json")
    || line.includes("next-env.d.ts");
}

function stopChild() {
  return new Promise((resolve) => {
    const child = currentChild;
    if (!child || child.exitCode !== null) return resolve();
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill();
    } catch {
      // ignore
    }
  });
}

/** 带回滚的构建：先把旧 .next 挪到 .next.prev，失败时原样恢复，让服务能以旧版回来。 */
function buildWithRollback() {
  const previousDir = `${nextBuildDir}.prev`;
  try {
    fs.rmSync(previousDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  let hadPrevious = false;
  if (fs.existsSync(nextBuildDir)) {
    try {
      fs.renameSync(nextBuildDir, previousDir);
      hadPrevious = true;
    } catch (error) {
      say(`无法备份旧构建（${error.message}），将直接重建（失败时无法回滚）`);
    }
  }
  const result = runNpm(["run", "build"]);
  const built = !result.error && result.status === 0 && fs.existsSync(path.join(nextBuildDir, "BUILD_ID"));
  if (built) {
    if (hadPrevious) {
      try {
        fs.rmSync(previousDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    try {
      fs.writeFileSync(buildStampFile, `launcher build ok at ${new Date().toISOString()}\n`);
    } catch {
      // ignore
    }
    return true;
  }
  try {
    fs.rmSync(nextBuildDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  if (hadPrevious) {
    try {
      fs.renameSync(previousDir, nextBuildDir);
      say("构建失败：已回滚到旧构建。");
    } catch (error) {
      say(`构建失败且回滚失败：${error.message}`);
      return false;
    }
  } else {
    say("构建失败：没有可回滚的旧构建。");
  }
  return false;
}

async function performUpdate(request) {
  updating = true;
  const target = request && typeof request.targetVersion === "string" ? request.targetVersion : "新版本";
  try {
    if (!currentChild) {
      writeUpdateState("failed", "服务尚未就绪，稍后再试。");
      return;
    }
    writeUpdateState("pulling", `收到更新请求（→ v${target}），正在拉取代码…`, {
      fromVersion: request && request.fromVersion ? request.fromVersion : readPackageVersion(),
      targetVersion: target,
    });

    // 0) 还原 Next 自动改写的类型声明，避免它挡住干净检查。
    runGit(["checkout", "--", "next-env.d.ts"]);

    // 1) 只允许在干净、位于 main 分支的工作区上更新（保护本地改动）。
    const statusResult = runGit(["status", "--porcelain"], { capture: true });
    if (statusResult.error || statusResult.status !== 0) {
      const reason = statusResult.error ? statusResult.error.message : `退出码 ${statusResult.status}`;
      writeUpdateState("failed", `无法执行 git（${reason}）：请确认已安装 git 后重试。`);
      return;
    }
    const dirty = String(statusResult.stdout || "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !isUpdateNoise(line));
    if (dirty.length > 0) {
      const sample = dirty.slice(0, 3).join("；");
      writeUpdateState("failed", `本地有 ${dirty.length} 处未提交改动，已拒绝更新（${sample}${dirty.length > 3 ? " …" : ""}）。请先提交或还原后重试。`);
      return;
    }
    const branchResult = runGit(["rev-parse", "--abbrev-ref", "HEAD"], { capture: true });
    const branch = String(branchResult.stdout || "").trim();
    if (branch !== "main") {
      writeUpdateState("failed", `当前分支是「${branch || "未知"}」而不是 main，已拒绝自动更新。`);
      return;
    }
    const beforeResult = runGit(["rev-parse", "HEAD"], { capture: true });
    const beforeCommit = String(beforeResult.stdout || "").trim();

    // 2) 拉取。失败时服务保持原样运行，零影响。
    const pullResult = runGit(["pull", "--ff-only", "origin", "main"]);
    if (pullResult.error || pullResult.status !== 0) {
      writeUpdateState("failed", "拉取代码失败（网络或分支分叉），服务保持旧版运行。");
      return;
    }
    const afterResult = runGit(["rev-parse", "HEAD"], { capture: true });
    const afterCommit = String(afterResult.stdout || "").trim();
    if (afterCommit === beforeCommit) {
      writeUpdateState("done", "代码已是最新（无新提交），无需重建。", { toVersion: readPackageVersion() });
      return;
    }

    // 3) 依赖：只在 lockfile / package.json 变化时安装。
    const diffResult = runGit(["diff", "--name-only", beforeCommit, afterCommit], { capture: true });
    const changedFiles = String(diffResult.stdout || "");
    if (/package(-lock)?\.json/.test(changedFiles)) {
      writeUpdateState("installing", "依赖有变化，正在安装（npm install）…");
      const installResult = runNpm(["install"]);
      if (installResult.error || installResult.status !== 0) {
        writeUpdateState("failed", "依赖安装失败，服务保持旧版运行。");
        return;
      }
    } else {
      writeUpdateState("installing", "依赖无变化，跳过安装。");
    }

    // 4) 停服务 → 回滚式重建 → 重启。
    writeUpdateState("building", "正在停止旧服务并重建（页面会暂时断开）…");
    await stopChild();
    const built = buildWithRollback();
    const toVersion = readPackageVersion();
    if (!built) {
      writeUpdateState("failed", "构建失败，已回滚到旧版本；服务将以旧版继续运行。", { toVersion });
      startProduction();
      return;
    }
    writeUpdateState("restarting", "构建完成，正在重启服务…", { toVersion });
    startProduction(() => {
      writeUpdateState("done", `已更新到 v${toVersion}。`, { toVersion });
    });
  } finally {
    updating = false;
  }
}

function startMonitors() {
  if (monitorsStarted) return;
  monitorsStarted = true;
  writeHeartbeat();
  setInterval(writeHeartbeat, heartbeatMs);
  setInterval(() => {
    if (updating) return;
    const state = readUpdateState();
    if (!state || state.phase !== "requested") return;
    const requestedAt = typeof state.requestedAt === "number" ? state.requestedAt : 0;
    if (requestedAt <= lastHandledRequestAt) return;
    lastHandledRequestAt = requestedAt;
    void performUpdate(state);
  }, updatePollMs);
}

/* ---------------- 进程生命周期 ---------------- */

function shutdown(signal) {
  const child = currentChild;
  if (child && child.exitCode === null) {
    child.once("exit", () => process.exit(0));
    try {
      child.kill(signal);
    } catch {
      // ignore
    }
    setTimeout(() => process.exit(0), 3000).unref();
    return;
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", () => {
  try {
    fs.rmSync(heartbeatFile, { force: true });
  } catch {
    // ignore
  }
});

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

// 自检模式：验证 git 调用链路（Windows CI 用——git 同样是 .cmd 垫片）
if (process.argv.includes("--selftest-git")) {
  const result = runGit(["--version"], { capture: true });
  if (result.error || result.status !== 0) {
    say(`git 自检失败：${result.error ? result.error.message : `退出码 ${result.status}`}`);
    process.exit(1);
  }
  say(`git 自检通过（${String(result.stdout || "").trim()}）`);
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
  startMonitors();
  startProduction();
});
