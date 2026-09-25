#!/usr/bin/env node
"use strict";

/**
 * 源码方式的环境准备 —— 一条命令把「检查 Node → 装依赖（→ 可选构建）」做完。
 *
 * 用法（在仓库根目录）：
 *   npm run setup              # 检查 Node 版本 → npm install
 *   npm run setup -- --build   # 装完顺手跑生产构建（之后 npm run start）
 *
 * 刻意不做的事：不自动安装 Node、不改系统配置、不做自愈。这守住「安装可靠性」的
 * 边界（换台机器部署时也不想装编译工具链），再往上就是产品化，超出本项目定位。
 */

const { spawn } = require("child_process");
const path = require("path");
const { getUnsupportedNodeVersionMessage, isNodeVersionSupported } = require("./node-version");

const ROOT = path.resolve(__dirname, "..");
const ARGS = process.argv.slice(2);
const WITH_BUILD = ARGS.includes("--build");
const HELP = ARGS.includes("--help") || ARGS.includes("-h");

function say(message = "") {
  process.stdout.write(`${message}\n`);
}

if (HELP) {
  say("用法: npm run setup [-- --build]");
  say("");
  say("  检查 Node 版本并安装依赖；--build 表示装完后接着跑生产构建。");
  process.exit(0);
}

/** npm 在 Windows 上必须经 cmd 调用（.cmd 垫片不能直接 spawn） */
function runNpm(args) {
  return new Promise((resolve) => {
    const child = process.platform === "win32"
      ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `npm ${args.join(" ")}`], {
          cwd: ROOT,
          stdio: "inherit",
        })
      : spawn("npm", args, { cwd: ROOT, stdio: "inherit" });
    child.on("error", (error) => {
      say("");
      say(`  ✗ 无法运行 npm：${error.message}`);
      say("    请确认已安装 Node.js（自带 npm）：https://nodejs.org/");
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function main() {
  const total = WITH_BUILD ? 3 : 2;
  say("");
  say("  ELENVA Web —— 源码方式环境准备");
  say("");

  // 1) Node 版本
  if (!isNodeVersionSupported(process.versions.node)) {
    say(`  [1/${total}] Node 版本检查未通过`);
    say("");
    process.stderr.write(`${getUnsupportedNodeVersionMessage(process.versions.node)}\n`);
    process.exit(1);
  }
  say(`  [1/${total}] Node v${process.versions.node} ✓（要求 >= 22.19.0）`);

  // 2) 依赖
  say("");
  say(`  [2/${total}] 安装依赖（npm install）…`);
  say("");
  if ((await runNpm(["install"])) !== 0) {
    say("");
    say("  ✗ 依赖安装失败。可能的原因与建议：");
    say("    · 网络不通或需要代理 —— 国内网络可换镜像后重试：");
    say("        npm config set registry https://registry.npmmirror.com");
    say("    · 排查完重跑：npm run setup");
    process.exit(1);
  }

  // 3) 可选：生产构建
  if (WITH_BUILD) {
    say("");
    say("  [3/3] 生产构建（npm run build）…");
    say("");
    if ((await runNpm(["run", "build"])) !== 0) {
      say("");
      say("  ✗ 构建失败。单独重跑可看完整日志：npm run build");
      process.exit(1);
    }
  }

  say("");
  say("  ✓ 环境就绪。下一步：");
  say("");
  say("    开发模式：  npm run dev            （热更新，http://127.0.0.1:30200）");
  say(`    生产模式：  ${WITH_BUILD ? "npm run start" : "npm run setup -- --build，然后 npm run start"}`);
  say("");
  say("  首次打开后按首页引导接入模型（选厂商 → 填凭据 → 选默认模型）。");
  say("");
}

void main();
