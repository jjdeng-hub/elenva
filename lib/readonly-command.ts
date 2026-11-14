/**
 * 只读 shell 命令的**结构化白名单**（计划模式 / 节律 readonly 档共用同一口径）。
 *
 * 为什么单列一个模块：`lib/tool-risk.ts` 的 `isReadOnlyShellCommand` 是「这条命令
 * 能不能当只读勘察放行」的唯一判据，被 host-guardrails-extension 的两处调用点共用
 * （计划模式 + 节律 readonly 档）。判定逻辑一旦复杂到按「命令 + 参数」逐条约束，
 * 就应该能被单独审计与回归，而不是埋在一个大文件里靠 `READ_ONLY_COMMANDS` 集合兜底。
 *
 * ## 保证范围（务必读完，别把它当沙箱）
 *
 * 这是**启发式分类器**，不是操作系统级沙箱：
 *   · 只按「命令名 + 参数形态」判定，不做 path sandbox、不做 seccomp/容器/只读挂载；
 *   · 能拦下**已知形态**的解释器内联代码（`node -e` / `python -c` / `awk '…system…'`）
 *     与**已知写盘参数**（`git stash clear`、`find -delete`、`sort -o`、`sed -i`…）；
 *   · 拦不住刻意伪装：把代码写进文件再执行、用未列举的解释器、通过环境变量注入、
 *     写进被允许命令的冷门参数（我们没穷举到的）——这些都可能漏过；
 *   · 因此它的定位是「防手滑 + 让模型在勘察阶段别乱写」，**不是安全边界**。
 *
 * 需要真隔离请用容器 / 只读挂载 / 独立用户 / 不可变快照（见 `tools/gates-isolated.mjs`）。
 *
 * 取向：**保守拒绝**。命令不认识、参数不认识、复杂 shell 语法（重定向 / 命令替换 /
 * 后台执行）一律不放行 —— 宁可让模型换一条更直白的只读命令，也不要放过去一个写操作。
 */

/** `&& ; | \n` 拆段（与 `lib/tool-risk.ts` 的 classifyBash 同款分隔符） */
function splitShellSegments(command: string): string[] {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/**
 * 保守的 shell 词法切分：引号内的整体保留为一个 token（引号剥掉），
 * 支持单/双引号；遇到未闭合的引号返回 null（由调用方拒绝）。
 * 不做变量展开、不做转义解释 —— 反斜杠留字面量，交给各命令的检查函数判断。
 */
function tokenize(segment: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote) return null;
  if (started) tokens.push(current);
  return tokens;
}

type TokensCheck = (tokens: string[]) => boolean;

/* ── git：按子命令 + 参数判定 ───────────────────────────────────────────── */

/** 取值型全局参数（`-C <path>` / `--git-dir=<path>` …）：要吃掉一个值，不能当作子命令 */
const GIT_VALUE_GLOBALS = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env",
]);
/** 无值型全局参数：跳过即可，不影响子命令定位 */
const GIT_FLAG_GLOBALS = new Set([
  "-p", "-P", "--paginate", "--no-pager", "--literal-pathspecs", "--no-replace-objects",
  "--bare", "--no-optional-locks",
]);

/** 纯查询子命令：参数不再逐条约束（只读语义由子命令本身保证） */
const GIT_READONLY_SUBCOMMANDS = new Set([
  "status", "log", "show", "rev-parse", "rev-list", "describe", "shortlog", "blame",
  "annotate", "ls-files", "ls-tree", "cat-file", "whatchanged", "grep", "show-ref",
  "name-rev", "ls-remote", "diff-tree", "diff-index", "diff-files", "merge-base",
  "for-each-ref", "count-objects", "var", "check-ignore", "check-attr",
  "check-ref-format", "verify-commit", "verify-tag", "verify-pack", "fsck",
  "get-tar-commit-id", "help",
]);

/** `git branch` 的写动作参数（剩下的 `-a` / `-r` / `-v` / `--contains` … 都是查询） */
const GIT_BRANCH_WRITE_FLAGS = /^(-[dDmMcCfu]|--delete|--move|--copy|--force|--edit-description|--set-upstream-to|--unset-upstream|--set-upstream|--track|--no-track|--create-reflog)$/;
/** 让「后面跟位置参数」合法的查询型 flag（`git branch --contains HEAD`） */
const GIT_BRANCH_LIST_FLAGS = /^(-[alrv]+|--list|--all|--remotes|--verbose|--contains|--merged|--no-merged|--points-at|--show-current|--format|--sort|--column)/;

function isReadOnlyGitBranch(args: string[]): boolean {
  if (args.some((arg) => GIT_BRANCH_WRITE_FLAGS.test(arg))) return false;
  const positionals = args.filter((arg) => !arg.startsWith("-"));
  if (positionals.length === 0) return true;
  // 带位置参数（分支名 / glob）时，必须同时出现查询型 flag，否则就是「新建分支」
  return args.some((arg) => GIT_BRANCH_LIST_FLAGS.test(arg));
}

/** `git tag` 的写动作参数 */
const GIT_TAG_WRITE_FLAGS = /^(-[asdfu]|--annotate|--sign|--delete|--force|--local-user|--message|--file|--create-reflog|--cleanup)(=|$)/;
const GIT_TAG_LIST_FLAGS = /^(-l$|--list$|-n|--contains|--points-at|--merged|--no-merged|--sort|--format|--column)/;

function isReadOnlyGitTag(args: string[]): boolean {
  if (args.some((arg) => GIT_TAG_WRITE_FLAGS.test(arg))) return false;
  const positionals = args.filter((arg) => !arg.startsWith("-"));
  if (positionals.length === 0) return true;
  return args.some((arg) => GIT_TAG_LIST_FLAGS.test(arg));
}

/** `git stash`：只放行 list / show；裸 `git stash` 是 push，pop/drop/clear/apply 都是写 */
function isReadOnlyGitStash(args: string[]): boolean {
  const sub = args[0];
  return sub === "list" || sub === "show";
}

/** `git worktree`：只放行 list（add/remove/prune/move/lock 全是写） */
function isReadOnlyGitWorktree(args: string[]): boolean {
  if (args.length === 0) return true;
  if (args[0] !== "list") return false;
  return args.slice(1).every((arg) => arg === "--porcelain" || arg === "-v" || arg === "--verbose" || arg.startsWith("--porcelain="));
}

/** `git remote`：只放行列举 / show / get-url；add/remove/rename/set-url/prune 全是写 */
function isReadOnlyGitRemote(args: string[]): boolean {
  const sub = args[0];
  if (sub === undefined || sub === "-v" || sub === "--verbose") return true;
  return sub === "show" || sub === "get-url";
}

/** `git config`：放行 getter / list；两个位置参数（set）或 setter flag 一律拒 */
const GIT_CONFIG_GET_FLAGS = /^(--get|--get-all|--get-regexp|--get-urlmatch|--list|-l|--show-origin|--show-scope|--null|-z|--file|-f|--global|--local|--system|--worktree|--includes|--type|--bool|--int|--path)/;
const GIT_CONFIG_SET_FLAGS = /^(--add|--replace-all|--unset|--unset-all|--rename-section|--remove-section|--edit|-e|--set)(=|$)/;

function isReadOnlyGitConfig(args: string[]): boolean {
  if (args.some((arg) => GIT_CONFIG_SET_FLAGS.test(arg))) return false;
  if (args.some((arg) => GIT_CONFIG_GET_FLAGS.test(arg))) return true;
  // 无 flag：`git config key`（读）；`git config key value`（写）→ 位置参数 ≥2 拒
  return args.filter((arg) => !arg.startsWith("-")).length <= 1;
}

/** `git diff`：`--output=<file>` 会写盘 */
function isReadOnlyGitDiff(args: string[]): boolean {
  return !args.some((arg) => /^--output(=|$)/.test(arg));
}

/** `git symbolic-ref`：无位置参数或仅一个（读）；带值 = 写 */
function isReadOnlyGitSymbolicRef(args: string[]): boolean {
  if (args.some((arg) => arg === "-d" || arg === "--delete")) return false;
  return args.filter((arg) => !arg.startsWith("-")).length <= 1;
}

const GIT_ARG_VALIDATORS: Record<string, TokensCheck> = {
  branch: isReadOnlyGitBranch,
  tag: isReadOnlyGitTag,
  stash: isReadOnlyGitStash,
  worktree: isReadOnlyGitWorktree,
  remote: isReadOnlyGitRemote,
  config: isReadOnlyGitConfig,
  diff: isReadOnlyGitDiff,
  "symbolic-ref": isReadOnlyGitSymbolicRef,
};

/**
 * git：先按全局参数（`-C` / `--git-dir=` / `-c` …）走到子命令，再判子命令与参数。
 * 全局参数不得构成绕过 —— 它们只影响「在哪个仓库执行」，不改子命令的读写性质。
 */
function isReadOnlyGit(tokens: string[]): boolean {
  let index = 1;
  for (; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!token.startsWith("-")) break;
    const eq = token.indexOf("=");
    const flag = eq > 0 ? token.slice(0, eq) : token;
    if (flag === "--version" || flag === "--help" || flag === "-h") return true;
    if (GIT_VALUE_GLOBALS.has(flag)) {
      if (eq > 0) continue; // --git-dir=<path> 自带值
      index += 1; // 吃掉下一个 token 作为值
      continue;
    }
    if (GIT_FLAG_GLOBALS.has(flag)) continue;
    return false; // 不认识的全局参数：保守拒绝
  }
  const sub = tokens[index]?.toLowerCase();
  if (!sub) return false;
  const args = tokens.slice(index + 1);
  if (GIT_READONLY_SUBCOMMANDS.has(sub)) return true;
  return GIT_ARG_VALIDATORS[sub]?.(args) === true;
}

/* ── 通用工具：参数级约束 ───────────────────────────────────────────────── */

/** 只读语义由工具本身保证、参数不再细分的一类 */
const ALWAYS_READ_ONLY = new Set([
  "ls", "dir", "cat", "type", "head", "tail", "wc", "rg", "grep", "fd", "pwd", "echo",
  "printf", "which", "where", "whereis", "printenv", "whoami", "tree", "du", "df",
  "basename", "dirname", "realpath", "test", "[", "expr", "seq", "nl", "cut", "tr",
  "column", "jq", "diff", "cmp", "md5sum", "sha1sum", "sha256sum", "cksum", "base64",
  "xxd", "od", "strings", "iconv", "mypy",
  // 测试运行器：会执行项目代码（可能写临时文件）—— 见文件头「保证范围」，这是有意保留的缺口
  "pytest", "jest", "vitest", "mocha",
]);

/** `find` 的写 / 执行参数（-exec 系列会跑命令，-delete 删文件，-fprint* 写文件） */
const FIND_WRITE_FLAGS = /^\\?-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/;

const ARG_CHECKERS: Record<string, TokensCheck> = {
  git: isReadOnlyGit,
  find: (tokens) => !tokens.some((token) => FIND_WRITE_FLAGS.test(token)),
  // env 后面只要出现「非选项、非赋值」的 token，就是把后面的命令跑起来 → 拒
  env: (tokens) => tokens.slice(1).every((token) => token.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)),
  sort: (tokens) => !tokens.some((token) => /^(-o|--output)(=|$)/.test(token)),
  // uniq [OPTION]... [INPUT [OUTPUT]]：位置参数 ≤1 才可能只读
  uniq: (tokens) => tokens.slice(1).filter((token) => !token.startsWith("-")).length <= 1,
  date: (tokens) => !tokens.some((token) => /^(-s|--set)(=|$)/.test(token)),
  hostname: (tokens) => tokens.slice(1).every((token) => token.startsWith("-")),
  file: (tokens) => !tokens.some((token) => /^(-C|--compile|=)/.test(token)),
  yq: (tokens) => !tokens.some((token) => /^(-i|--inplace|--in-place)(=|$)/.test(token)),
  tsc: (tokens) => tokens.includes("--noEmit"),
  eslint: (tokens) => !tokens.some((token) => /^(--fix|--fix-dry-run|--output-file|-o)(=|$)/.test(token)),
  ruff: (tokens) =>
    !tokens.includes("format") &&
    !tokens.some((token) => /^(--fix|--fix-only|--add-noqa)(=|$)/.test(token)),
  node: (tokens) => tokens.length === 2 && /^(--version|-v)$/.test(tokens[1]!),
  nodejs: (tokens) => tokens.length === 2 && /^(--version|-v)$/.test(tokens[1]!),
  python: (tokens) => tokens.length === 2 && /^(--version|-V)$/.test(tokens[1]!),
  python3: (tokens) => tokens.length === 2 && /^(--version|-V)$/.test(tokens[1]!),
};

/**
 * 只按「命令 + 参数」白名单判定的测试类命令前缀。
 *
 * 这些命令会**执行项目代码**（编译产物 / 测试用例），严格说不是只读；但在计划模式与
 * 只读档里「跑一遍测试看看现状」是核心勘察手段，因此有意保留。见文件头「保证范围」。
 */
const TEST_COMMAND_PREFIXES: RegExp[] = [
  /^npm\s+(test|run\s+test|ls|view|outdated|ping)\b/i,
  /^pnpm\s+(test|ls|view|outdated|why)\b/i,
  /^yarn\s+(test|info|why)\b/i,
  /^bun\s+test\b/i,
  /^go\s+(test|vet|list|env)\b/i,
  /^cargo\s+(test|check|tree|metadata)\b/i,
  /^dotnet\s+(test|build\s+--no-restore)\b/i,
  /^make\s+\S*test\S*\b/i,
];

/** 去掉前置变量赋值（`FOO=bar cmd`）：赋值本身不改世界，命令由后半段判 */
function stripLeadingAssignments(segment: string): string {
  return segment.replace(/^([A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "");
}

/** 后台执行 `a & b`（`2>&1` 这类 fd 复制不算）：拆段后仍残留的单个 `&` 一律拒 */
function hasBackgroundOperator(segment: string): boolean {
  return /&(?![&])/.test(segment.replace(/[<>]&/g, ""));
}

function isReadOnlySegment(rawSegment: string): boolean {
  let segment = rawSegment.trim();
  if (!segment) return true;
  if (hasBackgroundOperator(segment)) return false;
  segment = stripLeadingAssignments(segment);
  const tokens = tokenize(segment);
  if (!tokens || tokens.length === 0) return false;
  const command = tokens[0]!.replace(/^[('"]+/, "").toLowerCase();
  if (!command) return false;
  if (command === "cd") return true; // 只是切目录，后续片段由外层拆开判
  if (ALWAYS_READ_ONLY.has(command)) return true;
  const check = ARG_CHECKERS[command];
  if (check) return check(tokens);
  return TEST_COMMAND_PREFIXES.some((prefix) => prefix.test(segment));
}

/**
 * 计划模式 / 节律 readonly 档是否可以把这条 shell 命令当作只读勘察放行。
 * 保守优先：重定向、命令替换、后台执行、命令不认识、参数不认识，一律不放行。
 */
export function isReadOnlyShellCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  // 输出 / 追加重定向 / here-doc：只允许 fd 复制（2>&1 / >&2）
  if (/[<>]/.test(trimmed.replace(/\d*>&\d+/g, ""))) return false;
  // 命令替换 / 参数展开 / 进程替换 / eval：复杂语法一律拒
  if (/\$\(|\$\{|`|<\(|>\(|\beval\b/.test(trimmed)) return false;
  const segments = splitShellSegments(trimmed);
  if (segments.length === 0) return false;
  return segments.every(isReadOnlySegment);
}
