// git 能力（历史 / 详情 / 单文件恢复）的回归自检。
//
// 为什么必须有：`lib/git-commit.ts` / `lib/git-changes.ts` 是全项目少数**直接改
// 仓库状态**的模块，此前 tools/ 下零 git 测试。本轮新增的三个口里，`hash` 与
// `path` 都会被拼进 git 的 argv —— 一旦校验放松就是任意对象读取 / 任意文件覆盖。
//
// 运行：node tools/git-selftest.mjs
//
// 隔离：所有夹具都在 mkdtemp 出来的临时仓库里跑（git init + 提交），测完清理；
// **绝不触碰任何真实仓库**（也绝不碰 /root/elenva 自身的 git 状态）。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

// 记忆/运行数据一律不进真实 agent 目录
const sandbox = mkdtempSync(join(tmpdir(), "elenva-git-selftest-"));
const agentDir = join(sandbox, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const tempDirs = [sandbox];

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const { parseGitPorcelainV1, classifyGitStatus } = await jiti.import("../lib/git-status.ts");
const { sanitizeCommitSubject, undoLastCommit, GitCommitError } = await jiti.import("../lib/git-commit.ts");
const { isValidCommitHash } = await jiti.import("../lib/git-rev.ts");
const { parseGitLogOutput, getGitLog, normalizeLogLimit } = await jiti.import("../lib/git-log.ts");
const { parseCommitMeta, parseNameStatusZ, parseNumstatZ, truncateUtf8, getGitShow } = await jiti.import(
  "../lib/git-show.ts",
);
const { sanitizeRepoRelativePath, restoreFileFromCommit } = await jiti.import("../lib/git-restore.ts");
const { GitOpError } = await jiti.import("../lib/git-errors.ts");
const { guardGitCwd } = await jiti.import("../lib/git-route-guard.ts");
const { allowFileRoot } = await jiti.import("../lib/file-access.ts");

let passed = 0;
let failed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed += 1;
    failures.push(name);
    console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

/** 断言某次调用抛出 GitOpError 且状态码 / code 匹配 */
async function assertGitOpError(fn, { status, code }, label) {
  try {
    await fn();
  } catch (error) {
    if (!(error instanceof GitOpError)) {
      throw new Error(`${label}: 期望 GitOpError，实际 ${error?.constructor?.name}: ${error?.message}`);
    }
    if (status !== undefined) assertEqual(error.status, status, `${label} status`);
    if (code !== undefined) assertEqual(error.code, code, `${label} code`);
    return error;
  }
  throw new Error(`${label}: 期望抛错，实际成功`);
}

// ── 临时仓库夹具 ────────────────────────────────────────────────────────────
function gitRun(cwd, args) {
  return execFileSync("git", ["-c", "core.quotepath=false", "-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
}

function makeRepo(label) {
  const dir = mkdtempSync(join(tmpdir(), `elenva-git-selftest-${label}-`));
  tempDirs.push(dir);
  gitRun(dir, ["init", "-q", "-b", "main", "."]);
  gitRun(dir, ["config", "user.email", "dev@example.test"]);
  gitRun(dir, ["config", "user.name", "Ann Lee"]);
  gitRun(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

function commitAll(dir, message) {
  gitRun(dir, ["add", "-A"]);
  gitRun(dir, ["commit", "-q", "-m", message]);
  return gitRun(dir, ["rev-parse", "HEAD"]).trim();
}

function write(dir, name, content) {
  writeFileSync(join(dir, name), content);
}

// ═══════════════════════════════════════════════════════════════════════════
// ① 既有纯函数：parseGitPorcelainV1 / classifyGitStatus
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── ① porcelain 解析与状态分类 ──");

await check("parseGitPorcelainV1：普通 / 未跟踪 / 重命名 / 增改", () => {
  const output = [
    "M  src/a.ts",       // 已暂存修改
    " M src/b.ts",       // 工作区修改
    "?? new.txt",        // 未跟踪
    "R  renamed.txt",    // 重命名（下一段是源路径）
    "original.txt",
    "AM added-mod.txt",  // 新增后又改
  ].join("\0") + "\0";
  const entries = parseGitPorcelainV1(output);
  assertEqual(entries.length, 5, "条目数");
  assertEqual(entries[0].path, "src/a.ts", "path0");
  assertEqual(entries[0].indexStatus, "M", "index0");
  assertEqual(entries[1].worktreeStatus, "M", "worktree1");
  assertEqual(entries[2].path, "new.txt", "untracked path");
  assertEqual(entries[3].path, "renamed.txt", "rename path");
  assertEqual(entries[3].originalPath, "original.txt", "rename 源路径");
  assertEqual(entries[4].indexStatus, "A", "index4");
  assertEqual(entries[4].worktreeStatus, "M", "worktree4");
});

await check("classifyGitStatus：各状态码组合", () => {
  const cases = [
    [{ indexStatus: "?", worktreeStatus: "?" }, "untracked", "U"],
    [{ indexStatus: "U", worktreeStatus: "U" }, "conflict", "C"],
    [{ indexStatus: "A", worktreeStatus: "U" }, "conflict", "C"],
    [{ indexStatus: " ", worktreeStatus: "D" }, "deleted", "D"],
    [{ indexStatus: "R", worktreeStatus: " " }, "renamed", "R"],
    [{ indexStatus: "A", worktreeStatus: " " }, "added", "A"],
    [{ indexStatus: " ", worktreeStatus: "M" }, "modified", "M"],
    [{ indexStatus: "C", worktreeStatus: " " }, "renamed", "R"],
  ];
  for (const [entry, status, code] of cases) {
    const result = classifyGitStatus({ path: "x", ...entry });
    assertEqual(result.status, status, `${entry.indexStatus}${entry.worktreeStatus} status`);
    assertEqual(result.code, code, `${entry.indexStatus}${entry.worktreeStatus} code`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ② sanitizeCommitSubject 边界
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── ② 提交标题清洗 ──");

await check("sanitizeCommitSubject：换行 / 空 / 超长 / 引号 / 代码围栏", () => {
  assertEqual(sanitizeCommitSubject("fix: a\n\n多余正文"), "fix: a", "只取首行");
  assertEqual(sanitizeCommitSubject("   \n  \n"), "", "空内容");
  assertEqual(sanitizeCommitSubject('"fix: 带引号"'), "fix: 带引号", "去整体引号");
  assertEqual(sanitizeCommitSubject("commit message: 提交信息"), "提交信息", "去前缀");
  assertEqual(sanitizeCommitSubject("```text fix: 围栏"), "fix: 围栏", "去代码围栏");
  const long = sanitizeCommitSubject("长".repeat(250));
  assert(long.length <= 100, `超长应截到 100，实际 ${long.length}`);
  assert(!long.includes("\n"), "不得含换行");
});

// ═══════════════════════════════════════════════════════════════════════════
// ③ log 解析：主题含 | : 中文 emoji 换行 / 作者含空格 / 二进制 -
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── ③ 提交历史解析 ──");

await check("parseGitLogOutput：不可见分隔符解析，主题含 | : 中文 emoji 引号", () => {
  const hash = "a".repeat(40);
  const parent = "b".repeat(40);
  const subject = "fix: a|b: c 中文 🎉 'quote'";
  const output =
    `${hash}\x1fab12cd\x1fAnn Lee\x1f2026-10-19T10:00:00+08:00\x1f${parent}\x1f${subject}\x1e\n`
    + "3\t1\tsrc/a.ts\n"
    + "-\t-\tbin.dat\n"
    + "\n";
  const commits = parseGitLogOutput(output);
  assertEqual(commits.length, 1, "提交数");
  assertEqual(commits[0].subject, subject, "主题完整保留");
  assertEqual(commits[0].author, "Ann Lee", "作者含空格");
  assertEqual(commits[0].shortHash, "ab12cd", "短 hash");
  assertEqual(commits[0].parents.length, 1, "父提交数");
  assertEqual(commits[0].filesChanged, 2, "文件数（含二进制）");
  assertEqual(commits[0].additions, 3, "增行（二进制 - 不计）");
  assertEqual(commits[0].deletions, 1, "删行");
});

await check("parseGitLogOutput：多条记录正确分片", () => {
  const a = "1".repeat(40);
  const b = "2".repeat(40);
  const output =
    `${a}\x1f111111\x1fA\x1f2026-10-19T10:00:00+08:00\x1f\x1ffirst\x1e\n0\t0\tf\n\n`
    + `${b}\x1f222222\x1fB\x1f2026-10-19T09:00:00+08:00\x1f${a}\x1fsecond\x1e\n`;
  const commits = parseGitLogOutput(output);
  assertEqual(commits.length, 2, "提交数");
  assertEqual(commits[0].subject, "first", "第一条主题");
  assertEqual(commits[1].subject, "second", "第二条主题");
  assertEqual(commits[1].filesChanged, 0, "第二条无 numstat");
});

await check("getGitLog：真实仓库端到端（主题含特殊字符 + 二进制 + 作者空格）", async () => {
  const dir = makeRepo("log");
  write(dir, "f.txt", "a\nb\n");
  write(dir, "bin.dat", Buffer.from([0, 1, 2, 3]));
  commitAll(dir, "fix: a|b: c 中文 🎉 'quote'");
  write(dir, "f.txt", "a\nb\nc\nd\n");
  write(dir, "bin.dat", Buffer.from([0, 1, 2, 3, 4]));
  const head = commitAll(dir, "second");

  const log = await getGitLog(dir, { limit: 10 });
  assert(log.isGitRepository, "应是 git 仓库");
  assertEqual(log.branch, "main", "分支");
  assertEqual(log.commits.length, 2, "提交数");
  assertEqual(log.commits[0].hash, head, "HEAD hash");
  assertEqual(log.commits[0].subject, "second", "HEAD 主题");
  assertEqual(log.commits[0].author, "Ann Lee", "作者含空格");
  assertEqual(log.commits[0].additions, 2, "第二次提交增行（二进制不计）");
  assertEqual(log.commits[0].filesChanged, 2, "第二次提交文件数");
  assertEqual(log.commits[0].isHead, true, "isHead");
  assertEqual(log.commits[1].isHead, false, "非 HEAD");
  assert(log.commits[1].subject.includes("|"), "主题保留 | ");
  assert(log.commits[1].subject.includes(": "), "主题保留 : ");
  assert(log.commits[1].subject.includes("中文"), "主题保留中文");
  assert(log.commits[1].subject.includes("🎉"), "主题保留 emoji");
  assertEqual(log.hasMore, false, "hasMore");
});

await check("getGitLog：分页 before（hash 游标）", async () => {
  const dir = makeRepo("log-page");
  const hashes = [];
  for (let i = 1; i <= 4; i++) {
    write(dir, "f.txt", `line ${i}\n`);
    hashes.push(commitAll(dir, `commit ${i}`));
  }
  const first = await getGitLog(dir, { limit: 2 });
  assertEqual(first.commits.length, 2, "第一页条数");
  assertEqual(first.hasMore, true, "第一页 hasMore");
  const second = await getGitLog(dir, { limit: 2, before: first.commits[1].hash });
  assertEqual(second.commits.length, 2, "第二页条数");
  assertEqual(second.commits[0].subject, "commit 2", "第二页首条");
  assertEqual(second.hasMore, false, "第二页 hasMore");
});

await check("normalizeLogLimit：默认 30 / 上限 100 / 非法回默认", () => {
  assertEqual(normalizeLogLimit(undefined), 30, "默认");
  assertEqual(normalizeLogLimit("7"), 7, "字符串数字");
  assertEqual(normalizeLogLimit(9999), 100, "上限");
  assertEqual(normalizeLogLimit(-3), 30, "负数回默认");
  assertEqual(normalizeLogLimit("abc"), 30, "非数字回默认");
});

await check("getGitLog：空仓库返回 emptyRepository，不抛异常", async () => {
  const dir = makeRepo("log-empty");
  const log = await getGitLog(dir, {});
  assertEqual(log.isGitRepository, true, "是仓库");
  assertEqual(log.commits.length, 0, "无提交");
  assertEqual(log.emptyRepository, true, "emptyRepository");
});

await check("getGitLog：非仓库返回 isGitRepository=false，不抛异常", async () => {
  const dir = mkdtempSync(join(tmpdir(), "elenva-git-selftest-notrepo-"));
  tempDirs.push(dir);
  const log = await getGitLog(dir, {});
  assertEqual(log.isGitRepository, false, "非仓库");
  assertEqual(log.commits.length, 0, "无提交");
});

// ═══════════════════════════════════════════════════════════════════════════
// ④ hash 校验
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── ④ hash 校验 ──");

await check("isValidCommitHash：拒绝注入面，接受正常 hash", () => {
  const bad = [
    "--upload-pack=touch /tmp/x",
    "..",
    "HEAD~1",
    "abc def",
    "ABCDEF",
    "a".repeat(41),
    "-1",
    "HEAD",
    "main",
    "",
    null,
    undefined,
    "abc",              // 不足 4 位
    "abcg",             // 非十六进制
    "abc\n",
    " abc",
  ];
  for (const value of bad) {
    assert(!isValidCommitHash(value), `应拒绝 ${JSON.stringify(value)}`);
  }
  for (const value of ["a1b2", "0".repeat(40), "deadbeef", "0123456789abcdef0123456789abcdef01234567"]) {
    assert(isValidCommitHash(value), `应接受 ${value}`);
  }
});

await check("getGitShow：注入型 hash 一律 400", async () => {
  const dir = makeRepo("hash");
  write(dir, "f.txt", "x\n");
  commitAll(dir, "c1");
  for (const bad of ["--upload-pack=touch /tmp/elenva-pwn", "HEAD~1", "..", "abc def", "ABCDEF", "a".repeat(41)]) {
    await assertGitOpError(
      () => getGitShow(dir, bad),
      { status: 400, code: undefined },
      `show hash=${bad}`,
    );
  }
});

await check("getGitLog：注入型 before 一律 400", async () => {
  const dir = makeRepo("hash-before");
  write(dir, "f.txt", "x\n");
  commitAll(dir, "c1");
  for (const bad of ["--upload-pack=x", "HEAD~1", "..", "abc def", "ABCDEF"]) {
    await assertGitOpError(() => getGitLog(dir, { before: bad }), { status: 400 }, `before=${bad}`);
  }
});

await check("getGitShow：不存在的合法 hash → 404", async () => {
  const dir = makeRepo("hash-missing");
  write(dir, "f.txt", "x\n");
  commitAll(dir, "c1");
  await assertGitOpError(() => getGitShow(dir, "0123456789012345678901234567890123456789"), { status: 404, code: undefined }, "missing");
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑤ restore 路径校验（纯函数 + 软链/目录 IO）
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── ⑤ 恢复路径校验 ──");

await check("sanitizeRepoRelativePath：拒绝 ../ 绝对路径 Windows 路径 空值", () => {
  const bad = [
    "../outside.txt",
    "a/../../b",
    "/etc/passwd",
    "C:\\Windows\\system32",
    "//server/share/x",
    "",
    "   ",
    ".",
    "./",
    "x\0y",
  ];
  for (const value of bad) {
    let threw = false;
    try {
      sanitizeRepoRelativePath(value);
    } catch (error) {
      threw = true;
      if (!(error instanceof GitOpError)) throw new Error(`${value}: 期望 GitOpError`);
      assertEqual(error.status, 400, `${value} status`);
    }
    assert(threw, `应拒绝 ${JSON.stringify(value)}`);
  }
  assertEqual(sanitizeRepoRelativePath("sub/g.txt"), "sub/g.txt", "正常相对路径");
  assertEqual(sanitizeRepoRelativePath("./sub/g.txt"), "sub/g.txt", "去 ./");
  assertEqual(sanitizeRepoRelativePath("sub\\g.txt"), "sub/g.txt", "Windows 分隔符归一");
});

await check("restoreFileFromCommit：../ 与绝对路径被拒（400）", async () => {
  const dir = makeRepo("restore-path");
  write(dir, "f.txt", "a\n");
  const hash = commitAll(dir, "c1");
  await assertGitOpError(() => restoreFileFromCommit(dir, hash, "../f.txt"), { status: 400, code: "invalid-path" }, "../");
  await assertGitOpError(() => restoreFileFromCommit(dir, hash, "/etc/passwd"), { status: 400, code: "invalid-path" }, "absolute");
});

await check("restoreFileFromCommit：仓库外软链逃逸被拒（403）", async () => {
  const dir = makeRepo("restore-symlink");
  write(dir, "f.txt", "a\n");
  const hash = commitAll(dir, "c1");
  const outside = mkdtempSync(join(tmpdir(), "elenva-git-selftest-outside-"));
  tempDirs.push(outside);
  writeFileSync(join(outside, "secret.txt"), "leaked\n");
  symlinkSync(outside, join(dir, "link"));

  await assertGitOpError(
    () => restoreFileFromCommit(dir, hash, "link/secret.txt"),
    { status: 403, code: "path-escape" },
    "symlink escape",
  );
});

await check("restoreFileFromCommit：目录路径被拒（400），且不展开目录", async () => {
  const dir = makeRepo("restore-dir");
  mkdirSync(join(dir, "sub"));
  write(dir, "sub/g.txt", "a\n");
  const hash = commitAll(dir, "c1");
  await assertGitOpError(() => restoreFileFromCommit(dir, hash, "sub"), { status: 400, code: "path-is-directory" }, "dir");
});

await check("restoreFileFromCommit：提交里不存在的文件 → 404", async () => {
  const dir = makeRepo("restore-missing");
  write(dir, "f.txt", "a\n");
  const hash = commitAll(dir, "c1");
  await assertGitOpError(
    () => restoreFileFromCommit(dir, hash, "nope.txt"),
    { status: 404, code: "path-not-in-commit" },
    "missing in commit",
  );
});

await check("restoreFileFromCommit：有未提交改动默认 409，force 放行", async () => {
  const dir = makeRepo("restore-dirty");
  write(dir, "f.txt", "v1\n");
  const hash = commitAll(dir, "c1");
  write(dir, "f.txt", "v2-uncommitted\n");

  await assertGitOpError(
    () => restoreFileFromCommit(dir, hash, "f.txt"),
    { status: 409, code: "uncommitted-changes" },
    "dirty without force",
  );

  const result = await restoreFileFromCommit(dir, hash, "f.txt", { force: true });
  assertEqual(result.matchesHead, true, "恢复后与 HEAD 一致");
  assertEqual(gitRun(dir, ["show", "HEAD:f.txt"]).trim(), "v1", "内容回到该提交版本");
});

await check("restoreFileFromCommit：干净工作区直接恢复，返回目标版本与后续状态", async () => {
  const dir = makeRepo("restore-ok");
  write(dir, "f.txt", "v1\n");
  const first = commitAll(dir, "first");
  write(dir, "f.txt", "v2\n");
  commitAll(dir, "second");

  const result = await restoreFileFromCommit(dir, first, "f.txt");
  assertEqual(result.matchesHead, false, "与 HEAD 不一致");
  assertEqual(result.status?.code, "M", "状态码 M");
  assertEqual(result.shortHash.length > 0, true, "返回短 hash");
  assertEqual(gitRun(dir, ["show", ":f.txt"]).trim(), "v1", "索引内容为该提交版本");
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑥ undo 边界
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── ⑥ 撤销提交边界 ──");

await check("undoLastCommit：首个提交 → 409（回归）", async () => {
  const dir = makeRepo("undo-first");
  write(dir, "f.txt", "only\n");
  commitAll(dir, "the only commit");
  try {
    await undoLastCommit(dir);
  } catch (error) {
    assert(error instanceof GitCommitError, `期望 GitCommitError，实际 ${error?.constructor?.name}`);
    assertEqual(error.status, 409, "状态码");
    return;
  }
  throw new Error("首个提交的撤销应当失败");
});

await check("undoLastCommit：第二个提交可撤销（reset --soft，改动留在工作区）", async () => {
  const dir = makeRepo("undo-ok");
  write(dir, "f.txt", "v1\n");
  commitAll(dir, "first");
  write(dir, "f.txt", "v2\n");
  commitAll(dir, "second");
  const result = await undoLastCommit(dir);
  assertEqual(result.previousSubject, "second", "被撤销的标题");
  assertEqual(gitRun(dir, ["rev-list", "--count", "HEAD"]).trim(), "1", "提交数回到 1");
  assertEqual(gitRun(dir, ["diff", "--cached", "--name-only"]).trim(), "f.txt", "改动留在暂存区");
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑦ show 解析 + 端到端（重命名 / 二进制 / 截断）
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── ⑦ 提交详情 ──");

await check("parseNameStatusZ：普通 / 重命名 / 删除", () => {
  const output = "M\0bin.dat\0R066\0f.txt\0g.txt\0D\0gone.txt\0";
  const entries = parseNameStatusZ(output);
  assertEqual(entries.length, 3, "条目数");
  assertEqual(entries[0].status, "M", "M status");
  assertEqual(entries[0].path, "bin.dat", "M path");
  assertEqual(entries[1].status, "R066", "R status");
  assertEqual(entries[1].oldPath, "f.txt", "R oldPath");
  assertEqual(entries[1].path, "g.txt", "R path");
  assertEqual(entries[2].status, "D", "D status");
  assertEqual(entries[2].path, "gone.txt", "D path");
});

await check("parseNumstatZ：二进制 - 与重命名", () => {
  const output = "-\t-\tbin.dat\0" + "1\t0\t\0f.txt\0g.txt\0";
  const entries = parseNumstatZ(output);
  assertEqual(entries.length, 2, "条目数");
  assertEqual(entries[0].binary, true, "二进制");
  assertEqual(entries[0].additions, null, "二进制增行 null");
  assertEqual(entries[1].path, "g.txt", "重命名新路径");
  assertEqual(entries[1].oldPath, "f.txt", "重命名旧路径");
  assertEqual(entries[1].additions, 1, "重命名增行");
});

await check("parseCommitMeta：标题 / 正文 / 作者 / 父提交", () => {
  const hash = "a".repeat(40);
  const meta = parseCommitMeta(
    `${hash}\x1fab12cd\x1fAnn Lee\x1fdev@example.test\x1f2026-10-19T10:00:00+08:00\x1f${"b".repeat(40)}\x1fsubj\x1fbody line1\nbody line2`,
  );
  assertEqual(meta.subject, "subj", "主题");
  assertEqual(meta.body, "body line1\nbody line2", "正文");
  assertEqual(meta.author, "Ann Lee", "作者");
  assertEqual(meta.parents.length, 1, "父提交");
});

await check("truncateUtf8：按字节截断不撕裂多字节字符", () => {
  const result = truncateUtf8("中文中文", 7);
  assertEqual(result.truncated, true, "应截断");
  assert(!result.text.includes("\uFFFD"), "不得留下替换字符");
  assert(Buffer.byteLength(result.text, "utf8") <= 7, "字节数受限");
  const untouched = truncateUtf8("abc", 10);
  assertEqual(untouched.truncated, false, "未超限不截断");
});

await check("getGitShow：端到端（重命名 + 二进制 + 删除 + diff）", async () => {
  const dir = makeRepo("show");
  write(dir, "f.txt", "a\nb\n");
  write(dir, "bin.dat", Buffer.from([0, 1, 2]));
  write(dir, "gone.txt", "bye\n");
  commitAll(dir, "c1");

  gitRun(dir, ["mv", "f.txt", "g.txt"]);
  write(dir, "g.txt", "a\nb\nc\n");
  write(dir, "bin.dat", Buffer.from([0, 1, 2, 3]));
  gitRun(dir, ["rm", "-q", "gone.txt"]);
  const hash = commitAll(dir, "c2 rename+binary+delete");

  const detail = await getGitShow(dir, hash);
  assertEqual(detail.commit.subject, "c2 rename+binary+delete", "主题");
  const byPath = new Map(detail.files.map((file) => [file.path, file]));
  assertEqual(byPath.get("g.txt")?.status, "R", "重命名状态");
  assertEqual(byPath.get("g.txt")?.oldPath, "f.txt", "重命名源");
  assert((byPath.get("g.txt")?.diff ?? "").includes("+c"), "重命名文件有 diff");
  assertEqual(byPath.get("bin.dat")?.binary, true, "二进制标注");
  assertEqual(byPath.get("bin.dat")?.diff, null, "二进制无 diff");
  assertEqual(byPath.get("gone.txt")?.status, "D", "删除状态");
  assert((byPath.get("gone.txt")?.diff ?? "").includes("-bye"), "删除文件有 diff");
});

await check("getGitShow：单文件 diff 超限 → truncated", async () => {
  const dir = makeRepo("show-truncate");
  write(dir, "big.txt", Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n") + "\n");
  const hash = commitAll(dir, "big");
  const detail = await getGitShow(dir, hash, { perFileMaxBytes: 200 });
  assertEqual(detail.files.length, 1, "文件数");
  assertEqual(detail.files[0].truncated, true, "truncated");
  assertEqual(detail.diffTruncated, true, "diffTruncated");
  assert(Buffer.byteLength(detail.files[0].diff ?? "", "utf8") <= 200, "diff 字节受限");
});

await check("getGitShow：文件数超过 maxDiffFiles → 不再取 diff", async () => {
  const dir = makeRepo("show-many");
  for (let i = 0; i < 3; i++) write(dir, `f${i}.txt`, `${i}\n`);
  const hash = commitAll(dir, "many");
  const detail = await getGitShow(dir, hash, { maxDiffFiles: 1 });
  const withDiff = detail.files.filter((file) => file.diff !== null);
  assertEqual(withDiff.length, 1, "只取 1 个文件的 diff");
  assertEqual(detail.diffTruncated, true, "diffTruncated");
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑧ cwd 门禁（新路由共用的 guardGitCwd）
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── ⑧ cwd 门禁 ──");

await check("guardGitCwd：非白名单路径 403 / 相对路径 400", async () => {
  const denied = await guardGitCwd("/opt");
  assert(!("cwd" in denied), "/opt 不应放行");
  assertEqual(denied.status, 403, "/opt 状态码");

  const relative = await guardGitCwd("relative/path");
  assert(!("cwd" in relative), "相对路径不应放行");
  assertEqual(relative.status, 400, "相对路径状态码");
});

await check("guardGitCwd：白名单内目录放行 / 不存在 404", async () => {
  const dir = makeRepo("guard");
  allowFileRoot(dir);
  const allowed = await guardGitCwd(dir);
  assert("cwd" in allowed, `白名单内应放行，实际 status=${allowed.status}`);
  assertEqual(allowed.cwd, dir, "返回的 cwd");

  const missing = await guardGitCwd(join(dir, "does-not-exist"));
  assert(!("cwd" in missing), "不存在的目录不应放行");
  assertEqual(missing.status, 404, "不存在目录状态码");
});

// ═══════════════════════════════════════════════════════════════════════════
// 汇总
// ═══════════════════════════════════════════════════════════════════════════
for (const dir of tempDirs) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
}

console.log(`\n${failed === 0 ? "全部通过" : "存在失败"}：${passed} passed / ${failed} failed`);
if (failed > 0) {
  console.log(`失败用例：\n${failures.map((name) => `  · ${name}`).join("\n")}`);
  process.exit(1);
}
