// 只读边界回归（lib/readonly-command.ts + lib/tool-risk.ts）。
//
// 覆盖模块 3 取证到的两类问题：
//   ① 可写命令误放 —— 只读判定曾把 `node -e` / `python3 -c` 任意内联代码、
//      `git stash clear` / `git branch -D` / `git worktree add` 等写操作判成只读；
//   ② 合法读操作误拦 —— `memory_find` / `memory_search` / `memory_status(list)`
//      在计划模式与节律 readonly 档被拦下。
//
// 只调用分类器纯函数，**不执行**任何被测命令；攻击样例只作为字符串传入。
// 隔离：PI_CODING_AGENT_DIR 指向 mkdtemp，全用虚构数据。
// 运行：node tools/readonly-classifier-selftest.mjs
import { createJiti } from "jiti";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "elenva-readonly-selftest-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const { isReadOnlyShellCommand } = await jiti.import("../lib/readonly-command.ts");
const { classifyToolCall, isPlanModeBlocked, isReadOnlyToolCall, needsApproval } =
  await jiti.import("../lib/tool-risk.ts");

let fail = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS  ${name}`); }
  catch (error) { fail += 1; console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`); }
};
const assert = (cond, message) => { if (!cond) throw new Error(message); };

// ── ① 正例（合法勘察）：必须放行 ────────────────────────────────────────
const READ_ONLY_COMMANDS = [
  "git status",
  "git -C /tmp/repo status --porcelain",
  "git --git-dir=/tmp/repo/.git log --oneline -5",
  "git log --format=%H -1",
  "git diff --stat",
  "git diff --name-only HEAD~1",
  "git branch",
  "git branch -a",
  "git branch --list 'feat/*'",
  "git branch --contains HEAD",
  "git tag",
  "git tag -l 'v*'",
  "git tag -n5",
  "git stash list",
  "git stash show",
  "git worktree list",
  "git remote",
  "git remote -v",
  "git remote show origin",
  "git config --get user.name",
  "git config -l",
  "git config user.name",
  "git rev-parse HEAD",
  "ls -la",
  "cat README.md",
  "grep -rn 'TODO' app",
  "rg --files",
  "find . -name '*.ts' -type f",
  "find . -name '*.ts' -print",
  "wc -l lib/tool-risk.ts",
  "env",
  "env FOO=bar",
  "printenv PATH",
  "date",
  "hostname",
  "file package.json",
  "sort package.json",
  "uniq -c notes.txt",
  "yq '.name' package.json",
  "jq '.version' package.json",
  "node --version",
  "python3 --version",
  "tsc --noEmit",
  "eslint .",
  "ruff check .",
  "mypy lib",
  "npm test",
  "npm ls --depth=0",
  "pytest -q",
  "cd /tmp/repo",
  "FOO=bar git status",
  "git status && git log -1",
  "git log --oneline | head -5",
];
for (const command of READ_ONLY_COMMANDS) {
  check(`只读放行：${command}`, () => {
    assert(isReadOnlyShellCommand(command), `应判只读，实际拒绝`);
  });
}

// ── ② 反例（写 / 执行）：必须拒绝 ───────────────────────────────────────
const WRITE_COMMANDS = [
  // 解释器内联代码（模块 3 取证：曾被放行）
  "node -e \"require('fs').writeFileSync('x','y')\"",
  "node --eval \"process.exit(0)\"",
  "python3 -c \"open('x','w').write('y')\"",
  "python -c \"import os; os.remove('x')\"",
  "awk 'BEGIN { system(\"rm -rf /tmp/x\") }' data.txt",
  "sed -n '1w /tmp/out' data.txt",
  "sed -i 's/a/b/' data.txt",
  "perl -e 'unlink \"x\"'",
  "ruby -e 'File.delete(\"x\")'",
  "bash -c 'rm -rf /tmp/x'",
  "sh -c 'rm -rf /tmp/x'",
  // git 写操作
  "git stash",
  "git stash pop",
  "git stash clear",
  "git stash drop",
  "git stash apply",
  "git branch -D feat/x",
  "git branch -d feat/x",
  "git branch -m old new",
  "git branch newbranch",
  "git branch -c a b",
  "git -C /tmp/repo branch -D main",
  "git --git-dir=/tmp/repo/.git branch -D main",
  "git tag v1.0.0",
  "git tag -d v1.0.0",
  "git tag -a v1 -m rel",
  "git worktree add /tmp/wt",
  "git worktree remove /tmp/wt",
  "git worktree prune",
  "git remote add origin git@example.com:x.git",
  "git remote set-url origin git@example.com:y.git",
  "git config user.name hacker",
  "git config --global --add safe.directory /x",
  "git config --unset user.name",
  "git symbolic-ref HEAD refs/heads/x",
  "git diff --output=/tmp/out.patch",
  "git reset --hard",
  "git clean -fd",
  "git checkout .",
  "git push",
  "git fetch",
  "git pull",
  "git commit -m x",
  "git add .",
  // 通用工具的参数（模块 3 取证：awk/find/env 需复核）
  "find . -delete",
  "find . -exec rm {} ;",
  "find . -execdir touch hacked \\;",
  "find . -fprint /tmp/out",
  "env rm -rf /tmp/x",
  "env FOO=bar rm -rf /tmp/x",
  "sort -o out.txt in.txt",
  "sort --output=out.txt in.txt",
  "uniq in.txt out.txt",
  "date -s '2020-01-01'",
  "hostname evil",
  "file -C -m magic",
  "yq -i '.name = \"x\"' package.json",
  "eslint --fix .",
  "eslint -o report.txt .",
  "ruff format .",
  "ruff check --fix .",
  "tsc",
  // 重定向 / 命令替换 / 后台执行 / 复杂语法
  "cat f > out.txt",
  "echo x >> out.txt",
  "cat f 2> err.txt",
  "cat f < in.txt",
  "echo `rm -rf x`",
  "echo $(rm -rf x)",
  "echo ${HOME}",
  "ls & rm -rf x",
  "ls; rm -rf x",
  "ls && rm -rf x",
  "xargs rm < filelist",
  "ls | xargs rm",
  "unknown-tool --nowrite",
  "\"node\" -e 'process.exit(0)'",
];
for (const command of WRITE_COMMANDS) {
  check(`写操作拒绝：${command}`, () => {
    assert(!isReadOnlyShellCommand(command), `应拒绝，实际判成只读`);
  });
}

// ── ③ 记忆类读操作：计划模式 / readonly 档必须放行（模块 3 取证问题②）──
const MEMORY_READ_CALLS = [
  ["memory_find", { query: "x" }],
  ["memory_find", { query: "x", full: true, ids: [1, 2] }],
  ["memory_search", { query: "x" }],
  ["session_search", { query: "x" }],
  ["memory_status", { target: "memory", action: "list" }],
];
for (const [tool, input] of MEMORY_READ_CALLS) {
  check(`计划模式放行读操作：${tool} ${JSON.stringify(input)}`, () => {
    assert(!isPlanModeBlocked(tool, input), `计划模式不应拦下 ${tool}`);
    assert(isReadOnlyToolCall(tool, input), `应判只读`);
    const risk = classifyToolCall(tool, input, { cwd: "/tmp/repo" });
    assert(risk.level === "safe", `应判 safe，实际 ${risk.level}`);
    for (const mode of ["off", "risky", "writes"]) {
      assert(!needsApproval(risk, mode), `mode=${mode} 不应弹卡`);
    }
  });
}

// ── ④ 记忆写操作：仍然是 guarded（不扩大权限）──────────────────────────
const MEMORY_WRITE_CALLS = [
  ["memory_add", { target: "memory", text: "x" }],
  ["memory_replace", { target: "memory", old_text: "a", text: "b" }],
  ["memory_remove", { target: "memory", old_text: "a" }],
  ["memory_status", { target: "memory", action: "invalidate", old_text: "a" }],
  ["memory_status", { target: "memory", action: "restore", old_text: "a" }],
];
for (const [tool, input] of MEMORY_WRITE_CALLS) {
  check(`写操作仍 guarded：${tool} ${input.action ?? ""}`, () => {
    assert(isPlanModeBlocked(tool, input), `计划模式应拦下 ${tool}`);
    assert(!isReadOnlyToolCall(tool, input), `不应判只读`);
    const risk = classifyToolCall(tool, input, { cwd: "/tmp/repo" });
    assert(risk.level === "guarded", `应判 guarded，实际 ${risk.level}`);
    assert(needsApproval(risk, "writes"), "写入档必须弹卡");
  });
}

// ── ⑤ 原有只读工具与写工具不受影响 ──────────────────────────────────────
check("read / grep / todo_write / present_plan 仍只读", () => {
  for (const tool of ["read", "grep", "ls", "glob", "todo_write", "present_plan"]) {
    assert(!isPlanModeBlocked(tool), `${tool} 应放行`);
  }
});
check("write / edit 仍被计划模式拦下", () => {
  assert(isPlanModeBlocked("write", { file_path: "a.ts" }), "write 应拦");
  assert(isPlanModeBlocked("edit", { file_path: "a.ts" }), "edit 应拦");
  assert(classifyToolCall("write", { file_path: "a.ts" }, { cwd: "/tmp/repo" }).level === "guarded", "write 仍 guarded");
});

rmSync(root, { recursive: true, force: true });
console.log(fail === 0 ? "\n全部通过" : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
