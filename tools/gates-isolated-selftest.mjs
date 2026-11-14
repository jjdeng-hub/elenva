// 隔离门禁巡检的夹具回归（tools/gates-isolated.mjs）。
//
// 用一个小型**虚构** git 仓库做实验台，重点证明七件事：
//   ① 跑的是**提交快照**而不是脏工作区（工作区里有未提交的哨兵改动，门禁只看到已提交内容）；
//   ② 巡检全程不动真实工作区：哨兵文件字节前后完全一致，git status 也不变；
//   ③ 收敛门「在快照里改文件」只污染快照，真实仓库文件不受影响；
//   ④ 只有 exit 0、没有结构化标记时不能判通过（不可凭退出码推断重跑通过）；
//   ⑤ 无新提交 → skipped，且不覆写状态文件里的上一次真实结果；
//   ⑥ 并发锁：他人在跑 → skipped；死进程留下的陈旧锁 → 接管；
//   ⑦ 快照目录最终被清理，锁被释放；状态文件保留旧键（last_checked/last_result/when）。
//
// 运行：node tools/gates-isolated-selftest.mjs
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIsolatedGates, exitCodeFor } from "./gates-isolated.mjs";

let fail = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS  ${name}`); }
  catch (error) { fail += 1; console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`); }
};
const assert = (cond, message) => { if (!cond) throw new Error(message); };
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

const root = mkdtempSync(join(tmpdir(), "elenva-gates-isolated-selftest-"));
const repo = join(root, "fixture-repo");
const logDir = join(root, "logs");
const lockFile = join(root, "gates.lock");
const stateFile = join(root, "state.json");
mkdirSync(join(repo, "app"), { recursive: true });
mkdirSync(join(repo, "tools"), { recursive: true });

const git = (...args) => execFileSync("git", ["-C", repo, ...args], {
  encoding: "utf8",
  env: { ...process.env, GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.com", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.com" },
}).trim();

git("init", "-q");
git("config", "user.name", "fixture");
git("config", "user.email", "fixture@example.com");
git("config", "commit.gpgsign", "false");

const sentinel = join(repo, "sentinel.txt");
const fixtureSource = join(repo, "app/fixture.tsx");
const untracked = join(repo, "untracked.txt");
writeFileSync(sentinel, "COMMITTED-SENTINEL\n");
writeFileSync(fixtureSource, "export const fixture = 1;\n");
git("add", "-A");
git("commit", "-q", "-m", "fixture: 初始提交");
const commitA = git("rev-parse", "HEAD");

// 制造脏工作区：已跟踪文件的未提交改动 + 未跟踪文件
writeFileSync(sentinel, "DIRTY-SENTINEL\n");
writeFileSync(untracked, "UNTRACKED\n");
const dirtyHashes = { sentinel: sha(sentinel), fixture: sha(fixtureSource), untracked: sha(untracked) };
const statusBefore = git("status", "--porcelain");

const node = process.execPath;
const baseOptions = { repo, commit: commitA, logDir, lockFile, stateFile, quiet: true };

const run = (extra) => runIsolatedGates({ ...baseOptions, ...extra });
const assertClean = (label, result) => {
  assert(!existsSync(lockFile), `${label}：锁未释放`);
  if (result.snapshotDir) assert(!existsSync(result.snapshotDir), `${label}：快照目录未清理 ${result.snapshotDir}`);
};

// ── ① 通过：门禁看到的是提交快照，不是脏工作区 ──────────────────────────
const snapshotProofGate = {
  id: "snapshot-proof",
  name: "快照内容",
  kind: "exit",
  command: node,
  args: ["-p", "require('fs').readFileSync('sentinel.txt','utf8').trim()"],
  log: "snapshot-proof.log",
};
const passResult = await run({ gates: [snapshotProofGate] });
check("通过：状态 passed / 退出码 0", () => {
  assert(passResult.status === "passed", `status=${passResult.status} reason=${passResult.reason}`);
  assert(exitCodeFor(passResult, false) === 0, "严格模式应为 0");
  assert(passResult.commit === commitA, "应记录被测提交");
});
check("通过：门禁读到的是已提交内容（不是 DIRTY）", () => {
  const log = readFileSync(join(logDir, "snapshot-proof.log"), "utf8").trim();
  assert(log === "COMMITTED-SENTINEL", `日志内容=${JSON.stringify(log)}`);
  assert(!log.includes("DIRTY"), "不应看到脏工作区内容");
});
check("通过：快照清理 + 锁释放", () => assertClean("pass", passResult));

// ── ② 类型门失败：真实退出码 1 → failed ────────────────────────────────
const typeFailGate = {
  id: "tsc",
  name: "类型门",
  kind: "exit",
  command: node,
  args: ["-e", "process.stderr.write('lib/x.ts(1,1): error TS9999: boom\\n'); process.exit(1)"],
  log: "tsc-fail.log",
};
const failResult = await run({ gates: [typeFailGate] });
check("失败：状态 failed / 退出码 1", () => {
  assert(failResult.status === "failed", `status=${failResult.status}`);
  assert(failResult.checks[0].ok === false && failResult.checks[0].exitCode === 1, "应记真实退出码");
  assert(exitCodeFor(failResult, false) === 1 && exitCodeFor(failResult, true) === 1, "严格与 cron 模式都应是 1");
});
check("失败：快照清理 + 锁释放", () => assertClean("fail", failResult));

// ── ③ 收敛门：在快照里改文件 → 不通过；真实仓库不受影响 ────────────────
const convergeDirtyGate = {
  id: "converge",
  name: "设计系统收敛",
  kind: "no-change",
  command: node,
  args: ["-e", "require('fs').writeFileSync('app/fixture.tsx','export const fixture = 2;\\n'); console.log('  1 行  app/fixture.tsx'); console.log('共修改 1 个文件 / 1 行')"],
  expect: /共修改 0 个文件/,
  log: "converge-dirty.log",
};
const convergeResult = await run({ gates: [convergeDirtyGate] });
check("收敛失败：快照里改了文件即不通过", () => {
  assert(convergeResult.status === "failed", `status=${convergeResult.status}`);
  const item = convergeResult.checks[0];
  assert(item.ok === false, "应不通过");
  assert(item.modified.includes("app/fixture.tsx"), `modified=${JSON.stringify(item.modified)}`);
  assert(exitCodeFor(convergeResult, false) === 1, "严格模式应为 1");
});
check("收敛失败：真实仓库文件字节不变", () => {
  assert(sha(fixtureSource) === dirtyHashes.fixture, "fixture.tsx 被巡检改动了");
});
check("收敛失败：快照清理 + 锁释放", () => assertClean("converge", convergeResult));

// ── ④ 只有 exit 0、没有结构化标记 → 不能判通过 ─────────────────────────
const markerMissingGate = {
  id: "converge",
  name: "设计系统收敛",
  kind: "no-change",
  command: node,
  args: ["-e", "console.log('共修改 3 个文件 / 5 行')"],
  expect: /共修改 0 个文件/,
  log: "converge-marker.log",
};
const markerResult = await run({ gates: [markerMissingGate] });
check("无标记：exit 0 但不能推断通过", () => {
  assert(markerResult.status === "failed", `status=${markerResult.status}`);
  const item = markerResult.checks[0];
  assert(item.exitCode === 0, "退出码应为 0");
  assert(item.ok === false, "缺结构化标记应判不通过");
  assert(item.detail.some((line) => line.includes("结构化标记")), `detail=${JSON.stringify(item.detail)}`);
});

// ── ⑤ 无新提交：skipped，且不覆写状态文件 ──────────────────────────────
writeFileSync(stateFile, JSON.stringify({ last_checked: commitA, last_result: "ok", when: "2026-01-01T00:00:00.000Z" }, null, 2));
const stateMtimeBefore = statSync(stateFile).mtimeMs;
const skipResult = await run({ ifChanged: true, gates: [snapshotProofGate] });
check("无新提交：skipped 且不动状态文件", () => {
  assert(skipResult.status === "skipped", `status=${skipResult.status}`);
  assert(skipResult.reason.includes("未变化"), `reason=${skipResult.reason}`);
  assert(exitCodeFor(skipResult, false) === 3, "严格模式 skipped=3");
  assert(exitCodeFor(skipResult, true) === 0, "cron 模式 skipped=0（静默）");
  const raw = JSON.parse(readFileSync(stateFile, "utf8"));
  assert(raw.schema === undefined, "skipped 不应写入新结构（应保持上一次真实结果）");
  assert(raw.last_checked === commitA, "旧键 last_checked 应保留");
  assert(statSync(stateFile).mtimeMs === stateMtimeBefore, "状态文件不应被改写");
});
check("无新提交：未取锁、未建快照", () => {
  assert(!existsSync(lockFile), "不应有锁文件");
  assert(skipResult.snapshotDir === null, "不应建快照");
});

// ── ⑥ 并发锁 ────────────────────────────────────────────────────────────
writeFileSync(lockFile, JSON.stringify({ pid: process.pid, commit: commitA, startedAt: new Date().toISOString() }));
const lockedResult = await run({ gates: [snapshotProofGate] });
check("并发：他人在跑 → skipped（且不误删他人锁）", () => {
  assert(lockedResult.status === "skipped", `status=${lockedResult.status}`);
  assert(lockedResult.reason.includes("并发锁"), `reason=${lockedResult.reason}`);
  assert(existsSync(lockFile), "不应删掉别人持有的锁");
});
rmSync(lockFile, { force: true });

writeFileSync(lockFile, JSON.stringify({ pid: 999_999, commit: "deadbeef", startedAt: "2000-01-01T00:00:00.000Z" }));
const staleResult = await run({ gates: [snapshotProofGate] });
check("并发：死进程的陈旧锁可被接管", () => {
  assert(staleResult.status === "passed", `status=${staleResult.status}`);
  assert(!existsSync(lockFile), "接管后应释放锁");
});

// ── ⑦ 状态文件旧键兼容 + additive 字段 ────────────────────────────────
check("状态文件：保留 last_checked / last_result / when，另加 additive", () => {
  const raw = JSON.parse(readFileSync(stateFile, "utf8"));
  assert(raw.last_checked === commitA, "last_checked");
  assert(raw.last_result === "ok", "last_result");
  assert(typeof raw.when === "string", "when");
  assert(raw.schema === 2 && raw.status === "passed" && raw.mode === "isolated", "additive 字段");
});

// ── ⑧ 全程不动真实工作区 ───────────────────────────────────────────────
check("工作区哨兵字节前后完全一致", () => {
  assert(sha(sentinel) === dirtyHashes.sentinel, `sentinel 变了：${readFileSync(sentinel, "utf8")}`);
  assert(sha(fixtureSource) === dirtyHashes.fixture, "app/fixture.tsx 变了");
  assert(sha(untracked) === dirtyHashes.untracked, "untracked.txt 变了");
});
check("git status 前后一致（未新增/还原任何改动）", () => {
  assert(git("status", "--porcelain") === statusBefore, "工作区状态被巡检改动了");
});
check("HEAD 未被移动", () => {
  assert(git("rev-parse", "HEAD") === commitA, "HEAD 变了");
});

rmSync(root, { recursive: true, force: true });
console.log(fail === 0 ? "\n全部通过" : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
