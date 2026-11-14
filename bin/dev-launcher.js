#!/usr/bin/env node
"use strict";

/**
 * 开发模式启动器 —— `npm run dev` 用。
 *
 * 为什么要有它：Hermes 侧 Agent 的对话走 ACP 宿主（bin/acp-host.cjs），
 * 生产模式由 start-launcher 负责带起；dev 模式以前只跑 `next dev`，
 * 于是「接入的 Hermes Agent 在开发环境里点进去必然报宿主不可用」。
 * 这里把两件事绑在一起：起 next dev，顺带把 ACP 宿主拉起来，退出时一起收。
 *
 * 子进程边界仍在 bin/（lib/app/components/hooks 内零 spawn 的硬约束不变）。
 *
 * 环境变量：
 *   ELENVA_DEV_PORT / PORT   dev 服务端口（默认 30299，与 package.json 历史值一致）
 *   ELENVA_ACP_PORT          ACP 宿主端口（默认 30201）
 *   ELENVA_ACP_DISABLE=1     只起 next dev，不起 ACP 宿主
 *   --lan                    绑 0.0.0.0（等同旧的 npm run dev:lan）
 */

const { spawn } = require("child_process");
const http = require("http");
const path = require("path");

const projectDir = path.resolve(__dirname, "..");
const nextBin = path.join(projectDir, "node_modules", "next", "dist", "bin", "next");
const acpHostPath = path.join(projectDir, "bin", "acp-host.cjs");

const hostname = process.argv.includes("--lan") ? "0.0.0.0" : "127.0.0.1";
const devPort = String(process.env.ELENVA_DEV_PORT || process.env.PORT || 30299);
const acpPort = String(process.env.ELENVA_ACP_PORT || 30201);
const acpDisabled = process.env.ELENVA_ACP_DISABLE === "1";

let nextChild = null;
let acpChild = null;
let shuttingDown = false;

function say(message) {
  process.stdout.write(`\n  ${message}\n`);
}

/** ACP 宿主是否已经在跑（生产启动器 / 手动起过时不要重复起）。 */
function probeAcpHost(callback) {
  const req = http.get({ host: hostname, port: acpPort, path: "/health", timeout: 800 }, (res) => {
    res.resume();
    callback(res.statusCode === 200);
  });
  req.on("error", () => callback(false));
  req.on("timeout", () => {
    req.destroy();
    callback(false);
  });
}

function startAcpHost() {
  if (acpDisabled) {
    say("ELENVA_ACP_DISABLE=1：跳过 ACP 宿主（Hermes Agent 对话会报宿主不可用）");
    return;
  }
  probeAcpHost((alreadyRunning) => {
    if (alreadyRunning) {
      say(`ACP 宿主已在 ${acpPort} 端口运行，复用现有实例`);
      return;
    }
    say(`启动 ACP 宿主（端口 ${acpPort}）…`);
    acpChild = spawn(process.execPath, [acpHostPath], {
      cwd: projectDir,
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, ELENVA_ACP_PORT: acpPort },
    });
    acpChild.on("error", (error) => {
      say(`ACP 宿主启动失败：${error.message}（其余功能不受影响）`);
      acpChild = null;
    });
    acpChild.on("exit", (code) => {
      if (!shuttingDown) say(`ACP 宿主已退出（${code ?? "signal"}），Hermes Agent 对话暂不可用`);
      acpChild = null;
    });
  });
}

function startNextDev() {
  say(`启动 next dev（端口 ${devPort}）…`);
  nextChild = spawn(process.execPath, [nextBin, "dev", "-H", hostname, "-p", devPort], {
    cwd: projectDir,
    stdio: "inherit",
    env: process.env,
  });
  nextChild.on("error", (error) => {
    say(`无法启动 next dev：${error.message}`);
    shutdown(1);
  });
  nextChild.on("exit", (code) => shutdown(code ?? 0));
}

function kill(child, signal) {
  if (!child || child.exitCode !== null) return;
  try {
    child.kill(signal);
  } catch {
    /* 已经退出 */
  }
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  kill(acpChild, "SIGTERM");
  kill(nextChild, "SIGTERM");
  // 给子进程一点时间收尾；Windows 上 SIGTERM 不能保证被处理，兜底强杀
  const timer = setTimeout(() => {
    kill(acpChild, "SIGKILL");
    kill(nextChild, "SIGKILL");
    process.exit(code);
  }, 3000);
  timer.unref();
  if (!nextChild || nextChild.exitCode !== null) process.exit(code);
  nextChild.once("exit", () => {
    clearTimeout(timer);
    kill(acpChild, "SIGKILL");
    process.exit(code);
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

startAcpHost();
startNextDev();
