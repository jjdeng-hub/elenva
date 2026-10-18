#!/usr/bin/env node
/**
 * 隔离门禁巡检（模块 3 安全修复 B）—— 在**固定提交的临时快照**上跑三道门，
 * 绝不碰调用方的工作区。
 *
 * 为什么需要它：原 `/root/.hermes/scripts/elenva-gates.sh` 直接在真实工作区跑
 * `python3 tools/style-converge.py`，失败后 `git checkout -- .` 把用户未提交的
 * 改动一起抹掉；而它 `exit 0` 恒真，失败只靠 stdout 兜底。这里改成：
 *
 *   1. `git archive <commit> | tar -x` 导出**不可变提交**的快照到独立临时目录；
 *      脏工作区（已跟踪文件的未提交改动、未跟踪文件）根本不进快照。
 *   2. 三道门全部在快照里跑；收敛失败只记录，**从不执行 checkout/reset/clean/stash**。
 *   3. 结果以**结构化** JSON 给出（passed / failed / skipped / error），
 *      失败与否以各门的**真实退出码 + 脚本结构化输出**为准，单看 exit 0 不算通过
 *      （收敛门还要求「共修改 0 个文件」且快照文件哈希不变）。
 *   4. 并发锁：同一时刻只允许一个巡检，第二个直接 skipped（cron 静默）。
 *   5. 状态文件保留旧键（last_checked / last_result / when）不变，另加 additive 字段，
 *      免得破坏 `lib/system-status.ts` 等读端。
 *
 * 依赖：`git` 与 `tar`（Linux/macOS 自带；Windows 10+ 自带 bsdtar）。零 npm 依赖。
 *
 * CLI：
 *   node tools/gates-isolated.mjs                     # 严格退出码，跑当前 HEAD
 *   node tools/gates-isolated.mjs --commit <sha> --json
 *   node tools/gates-isolated.mjs --if-changed --cron  # 定时巡检用（无变更即跳过、静默）
 *
 * 退出码：严格模式 passed=0 / failed=1 / error=2 / skipped=3；
 *          --cron 模式 passed=0 / skipped=0 / failed=1 / error=2。
 */
import { createHash } from "node:crypto";
import {
  closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const IS_WINDOWS = process.platform === "win32";
/** 输出上限：别把 tsc 的几千行错误全灌进内存 / 状态文件 */
const OUTPUT_CAP = 200_000;
/** 并发锁的过期时间：超时未释放（进程被杀）就允许接管 */
const LOCK_STALE_MS = 30 * 60 * 1000;

// ============================================================================
// 默认三道门（与 cron 上的 elenva-gates.sh 同源）
// ============================================================================

/**
 * kind：
 *   · "exit"      —— 退出码 0 即通过
 *   · "no-change" —— 退出码 0 **且** 输出里出现结构化标记（expect）**且** 快照文件哈希不变
 * log：写进 logDir 的文件名，沿用旧脚本的 tsc.log / probe.log，方便沿用既有读日志习惯
 */
export const DEFAULT_GATES = [
  {
    id: "tsc",
    name: "类型门",
    kind: "exit",
    command: process.execPath,
    args: ["./node_modules/typescript/bin/tsc", "--noEmit"],
    env: { NODE_OPTIONS: "--max-old-space-size=1536" },
    log: "tsc.log",
  },
  {
    id: "probe",
    name: "用法面探针",
    kind: "exit",
    command: process.execPath,
    args: ["./node_modules/typescript/bin/tsc", "-p", "tools/tsconfig.json"],
    env: { NODE_OPTIONS: "--max-old-space-size=1536" },
    log: "probe.log",
  },
  {
    id: "converge",
    name: "设计系统收敛",
    kind: "no-change",
    command: "python3",
    args: ["tools/style-converge.py"],
    expect: /共修改 0 个文件/,
    log: "converge.log",
  },
];

// ============================================================================
// 小工具
// ============================================================================

function git(repo, args, options = {}) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout ?? 60_000,
  }).trim();
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** 原子写 JSON：先写临时文件再 rename，读者不会看到半截内容 */
function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** 快照里所有**普通文件**的 sha256（符号链接——node_modules/.next——跳过） */
function hashTree(dir, base = dir, map = new Map()) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return map;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      hashTree(full, base, map);
      continue;
    }
    if (!entry.isFile()) continue;
    const key = relative(base, full).split(sep).join("/");
    map.set(key, createHash("sha256").update(readFileSync(full)).digest("hex"));
  }
  return map;
}

function diffHashes(before, after) {
  const changed = new Set();
  for (const [path, hash] of after) if (before.get(path) !== hash) changed.add(path);
  for (const path of before.keys()) if (!after.has(path)) changed.add(path);
  return [...changed].sort();
}

// ============================================================================
// 并发锁 / 快照
// ============================================================================

export function acquireLock(lockFile, commit, staleMs = LOCK_STALE_MS) {
  mkdirSync(dirname(lockFile), { recursive: true });
  const payload = JSON.stringify({ pid: process.pid, commit, startedAt: new Date().toISOString() });
  const take = () => {
    const fd = openSync(lockFile, "wx", 0o600);
    try {
      writeSync(fd, payload);
    } finally {
      closeSync(fd);
    }
  };
  const release = () => {
    try {
      rmSync(lockFile, { force: true });
    } catch {
      /* 释放失败不影响巡检结果 */
    }
  };
  try {
    take();
    return { ok: true, release };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  // 锁已存在：进程还活着且未过期 → 让路；否则接管
  let stale = false;
  try {
    const raw = readJson(lockFile);
    stale = !pidAlive(Number(raw?.pid)) || Date.now() - statSync(lockFile).mtimeMs > staleMs;
  } catch {
    stale = true;
  }
  if (!stale) return { ok: false, release: () => {} };
  try {
    rmSync(lockFile, { force: true });
  } catch {
    /* 接管失败就让最后一次尝试说话 */
  }
  try {
    take();
    return { ok: true, release };
  } catch {
    return { ok: false, release: () => {} };
  }
}

/** `git archive <commit>` 直接管道给 `tar -x -C dir`：不经过 shell，不留工作区痕迹 */
function extractSnapshot(repo, commit, dir, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const archive = spawn("git", ["-C", repo, "archive", "--format=tar", commit], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tar = spawn("tar", ["-x", "-C", dir], { stdio: ["pipe", "ignore", "pipe"] });
    // 任一侧断流时别让 stdin 的 EPIPE 冒成未捕获异常
    tar.stdin.on("error", () => {});
    let archiveErr = "";
    let tarErr = "";
    archive.stderr.on("data", (chunk) => { archiveErr += chunk.toString(); });
    tar.stderr.on("data", (chunk) => { tarErr += chunk.toString(); });
    archive.stdout.pipe(tar.stdin);

    let settled = false;
    let archiveDone = false;
    let tarDone = false;
    let archiveCode = null;
    let tarCode = null;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    const maybeFinish = () => {
      if (!archiveDone || !tarDone) return;
      if (archiveCode !== 0) return finish(new Error(`git archive 失败（exit ${archiveCode}）：${archiveErr.trim()}`));
      if (tarCode !== 0) return finish(new Error(`tar 解包失败（exit ${tarCode}）：${tarErr.trim()}`));
      finish();
    };
    const timer = setTimeout(() => {
      archive.kill("SIGKILL");
      tar.kill("SIGKILL");
      finish(new Error("快照导出超时"));
    }, timeoutMs);
    archive.on("error", (error) => finish(new Error(`git archive 无法执行：${error.message}`)));
    tar.on("error", (error) => finish(new Error(`tar 无法执行：${error.message}`)));
    archive.on("close", (code) => { archiveDone = true; archiveCode = code; maybeFinish(); });
    tar.on("close", (code) => { tarDone = true; tarCode = code; maybeFinish(); });
  });
}

/** node_modules / .next 是**符号链接**进快照的（不是硬链接）：只读引用，读盘路径与真实仓库一致 */
function linkIfExists(repo, dir, name) {
  const target = join(repo, name);
  const link = join(dir, name);
  if (!existsSync(target) || existsSync(link)) return null;
  try {
    symlinkSync(target, link, IS_WINDOWS ? "junction" : "dir");
    return null;
  } catch (error) {
    return `${name}: ${error.message}`;
  }
}

// ============================================================================
// 跑单条命令
// ============================================================================

function runCommand(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolvePromise({ code: null, out: "", err: String(error?.message ?? error), timedOut: false });
      return;
    }
    let out = "";
    let err = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code, out, err, timedOut });
    };
    child.stdout.on("data", (chunk) => { if (out.length < OUTPUT_CAP) out += chunk.toString(); });
    child.stderr.on("data", (chunk) => { if (err.length < OUTPUT_CAP) err += chunk.toString(); });
    child.on("error", (error) => { err += String(error?.message ?? error); finish(null); });
    child.on("close", (code) => finish(code));
  });
}

// ============================================================================
// 主流程
// ============================================================================

/**
 * 在提交快照上跑门禁巡检。
 * 返回结构化结果（见文件头）；调用方据此决定告警与退出码。
 */
export async function runIsolatedGates(options = {}) {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const repo = options.repo ? options.repo : process.cwd();
  const ref = options.ref ?? "HEAD";
  const gates = options.gates ?? DEFAULT_GATES;
  const logDir = options.logDir ?? join(tmpdir(), "elenva-gates");
  const lockFile = options.lockFile ?? join(tmpdir(), "elenva-gates-isolated.lock");
  const stateFile = options.stateFile ?? join(tmpdir(), "elenva-gates-state.json");
  const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;
  const keepSnapshot = options.keep === true;
  const result = {
    status: "error",
    reason: null,
    repo: null,
    commit: null,
    commitSubject: null,
    shortCommit: null,
    snapshotDir: null,
    keepSnapshot,
    checks: [],
    modifiedFiles: [],
    startedAt,
    finishedAt: null,
  };

  let root;
  try {
    root = git(repo, ["rev-parse", "--show-toplevel"], { timeout: 15_000 });
  } catch (error) {
    result.reason = `不是 git 仓库或 git 不可用：${error.message}`;
    result.finishedAt = now().toISOString();
    return result;
  }
  result.repo = root;

  let commit;
  try {
    const target = options.commit ?? ref;
    commit = git(root, ["rev-parse", "--verify", `${target}^{commit}`], { timeout: 15_000 });
  } catch (error) {
    result.reason = `无法解析提交：${error.message}`;
    result.finishedAt = now().toISOString();
    return result;
  }
  result.commit = commit;
  result.shortCommit = commit.slice(0, 7);
  try {
    result.commitSubject = git(root, ["log", "-1", "--format=%s", commit], { timeout: 15_000 });
  } catch {
    result.commitSubject = null;
  }

  // 无新提交：与旧脚本一致——不落状态、不输出（避免「exit 0 = 重跑通过」的误读：
  // 这里明确是 skipped，且状态文件保持上一次真实结果）。
  const previousState = stateFile ? readJson(stateFile) : null;
  if (options.ifChanged && previousState?.last_checked === commit) {
    result.status = "skipped";
    result.reason = "提交未变化，未重新验证";
    result.finishedAt = now().toISOString();
    return result;
  }

  const lock = acquireLock(lockFile, commit);
  if (!lock.ok) {
    result.status = "skipped";
    result.reason = "已有巡检在运行（并发锁未释放）";
    result.finishedAt = now().toISOString();
    return result;
  }

  const snapshotDir = mkdtempSync(join(tmpdir(), `elenva-gates-${commit.slice(0, 7)}-`));
  result.snapshotDir = snapshotDir;
  try {
    mkdirSync(logDir, { recursive: true });
    await extractSnapshot(root, commit, snapshotDir, timeoutMs);

    const linkWarnings = [
      linkIfExists(root, snapshotDir, "node_modules"),
      linkIfExists(root, snapshotDir, ".next"),
    ].filter(Boolean);
    if (linkWarnings.length > 0) {
      // node_modules 链接不上时门禁必然结果失真，直接判 error 而不是假装跑过
      result.status = "error";
      result.reason = `快照依赖链接失败：${linkWarnings.join("；")}`;
      return result;
    }

    for (const gate of gates) {
      const gateStarted = Date.now();
      const before = gate.kind === "no-change" ? hashTree(snapshotDir) : null;
      const logFile = join(logDir, gate.log ?? `${gate.id}.log`);
      const outcome = await runCommand(gate.command, gate.args, {
        cwd: snapshotDir,
        env: { ...process.env, ...(options.env ?? {}), ...(gate.env ?? {}) },
        timeoutMs: gate.timeoutMs ?? timeoutMs,
      });
      const combined = `${outcome.out}${outcome.err ? `\n${outcome.err}` : ""}`;
      try {
        writeFileSync(logFile, combined);
      } catch {
        /* 日志写不进去不改变判定 */
      }
      const detail = [];
      if (outcome.timedOut) detail.push("超时被终止");
      const check = {
        id: gate.id,
        name: gate.name,
        kind: gate.kind ?? "exit",
        exitCode: outcome.code,
        durationMs: Date.now() - gateStarted,
        log: logFile,
        ok: false,
        detail,
        modified: [],
      };
      if (outcome.timedOut) {
        check.ok = false;
      } else if (outcome.code !== 0) {
        check.ok = false;
        detail.push(`退出码 ${outcome.code}`);
      } else if (gate.kind === "no-change") {
        const marked = gate.expect ? gate.expect.test(combined) : true;
        const after = hashTree(snapshotDir);
        check.modified = diffHashes(before, after);
        if (!marked) {
          check.ok = false;
          detail.push("未见结构化标记（如「共修改 0 个文件」），不能凭退出码推断通过");
        } else if (check.modified.length > 0) {
          check.ok = false;
          detail.push(`在快照里改动了 ${check.modified.length} 个文件（收敛非幂等）`);
        } else {
          check.ok = true;
        }
      } else {
        check.ok = true;
      }
      result.checks.push(check);
    }

    const failed = result.checks.filter((check) => !check.ok);
    result.status = failed.length > 0 ? "failed" : "passed";
    result.modifiedFiles = [...new Set(failed.flatMap((check) => check.modified))].sort();
    return result;
  } catch (error) {
    result.status = "error";
    result.reason = error instanceof Error ? error.message : String(error);
    return result;
  } finally {
    if (!keepSnapshot) {
      try {
        rmSync(snapshotDir, { recursive: true, force: true });
      } catch (error) {
        result.checks.push({
          id: "cleanup",
          name: "快照清理",
          kind: "cleanup",
          exitCode: null,
          durationMs: 0,
          log: null,
          ok: false,
          detail: [`快照目录未能删除：${error.message}`],
          modified: [],
        });
      }
    }
    result.finishedAt = now().toISOString();
    lock.release();
    if (stateFile && result.status === "passed") {
      writeJsonAtomic(stateFile, {
        // 旧键保持不变（lib/system-status.ts 读这三个）
        last_checked: result.commit,
        last_result: "ok",
        when: result.finishedAt,
        // additive 字段
        schema: 2,
        status: "passed",
        commit: result.commit,
        checks: result.checks.map((check) => ({ id: check.id, ok: check.ok, durationMs: check.durationMs })),
        mode: "isolated",
      });
    } else if (stateFile && result.status === "failed") {
      writeJsonAtomic(stateFile, {
        last_checked: previousState?.last_checked ?? null,
        last_result: "fail",
        when: result.finishedAt,
        schema: 2,
        status: "failed",
        commit: result.commit,
        checks: result.checks.map((check) => ({ id: check.id, ok: check.ok, durationMs: check.durationMs })),
        mode: "isolated",
      });
    }
  }
}

// ============================================================================
// CLI
// ============================================================================

function parseArgs(argv) {
  const options = { ifChanged: false, cron: false, json: false, quiet: false, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "--repo": options.repo = next(); break;
      case "--ref": options.ref = next(); break;
      case "--commit": options.commit = next(); break;
      case "--state": options.stateFile = next(); break;
      case "--lock": options.lockFile = next(); break;
      case "--log-dir": options.logDir = next(); break;
      case "--timeout": options.timeoutMs = Number(next()) * 1000; break;
      case "--if-changed": options.ifChanged = true; break;
      case "--cron": options.cron = true; break;
      case "--json": options.json = true; break;
      case "--quiet": options.quiet = true; break;
      case "--keep": options.keep = true; break;
      case "-h":
      case "--help": options.help = true; break;
      default:
        throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

/** 严格退出码：passed=0 failed=1 error=2 skipped=3；--cron 把 skipped 折成 0（cron 静默） */
export function exitCodeFor(result, cronMode) {
  if (result.status === "passed") return 0;
  if (result.status === "skipped") return cronMode ? 0 : 3;
  if (result.status === "failed") return 1;
  return 2;
}

function firstErrorLines(text, limit = 5) {
  const lines = text.split("\n").filter((line) => /error TS|Error|错误|失败/.test(line)).slice(0, limit);
  const chosen = lines.length > 0 ? lines : text.split("\n").slice(-limit);
  return chosen.map((line) => `  ${line.trim()}`).join("\n");
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`❌ ${error.message}\n用法见 node tools/gates-isolated.mjs --help`);
    process.exit(2);
  }
  if (options.help) {
    console.log(`隔离门禁巡检 —— 在固定提交的临时快照上跑三道门，不动调用方工作区。

用法：node tools/gates-isolated.mjs [选项]

  --repo <path>       仓库路径（默认当前目录）
  --ref <name>        解析提交用的 ref（默认 HEAD）
  --commit <sha>      指定提交（优先于 --ref）
  --state <file>      状态文件（默认 tmpdir/elenva-gates-state.json）
  --lock <file>       并发锁文件
  --log-dir <dir>     日志目录（默认 tmpdir/elenva-gates）
  --timeout <sec>     单门超时（默认 900）
  --if-changed        状态文件里已记录同一提交 → skipped（不重新验证）
  --cron              skipped 退出码折成 0（定时巡检静默）
  --json              输出结构化 JSON
  --quiet             通过时完全静默
  --keep              保留快照目录（调试）

退出码：passed=0 / failed=1 / error=2 / skipped=3（--cron 时 skipped=0）`);
    process.exit(0);
  }

  const result = await runIsolatedGates(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.status === "failed") {
    const repeated = options.ifChanged !== true ? "" : "";
    console.log(`🛡️ ELENVA 门禁告警${repeated} isolated @ ${result.shortCommit}（提交快照，未触碰工作区）`);
    for (const check of result.checks.filter((item) => !item.ok)) {
      let text = "";
      try {
        text = readFileSync(check.log, "utf8");
      } catch {
        /* 日志读不到就只报结论 */
      }
      console.log(`❌ ${check.name}：${check.detail.join("；") || "未通过"}\n${firstErrorLines(text)}`);
    }
    console.log(`提交：${result.commit}`);
    console.log(`日志：${result.checks.map((check) => check.log).filter(Boolean).join(" ")}`);
  } else if (result.status === "error" && !options.quiet) {
    console.log(`❌ ELENVA 门禁巡检内部错误：${result.reason}`);
  } else if (result.status === "skipped" && !options.quiet && !options.cron) {
    console.log(`⏭️  ELENVA 门禁巡检跳过：${result.reason}`);
  }
  process.exit(exitCodeFor(result, options.cron));
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (isMain) {
  main().catch((error) => {
    console.error(`❌ ELENVA 门禁巡检未捕获错误：${error?.message ?? error}`);
    process.exit(2);
  });
}
