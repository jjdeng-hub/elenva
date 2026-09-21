import { execFile } from "child_process";
import { readFile } from "fs/promises";
import path from "path";
import { promisify } from "util";
import { getGitStatus } from "./git-changes";
import type { GitFileStatus, GitStatusResponse } from "./git-types";

/**
 * Git 写操作（提交 / 撤销提交）。
 *
 * 设计约束（都是刻意的）：
 *  · 只暂存调用方显式点选的文件，**不提供 `git add -A`** ——
 *    工作区里常混着截图、临时脚本、探针产物，一键全暂存会把这些写进历史。
 *  · 绝不使用 `--amend` / `--force` / `--no-verify`；撤销提交只用 `reset --soft`，
 *    保证改动仍在工作区，不会丢东西。
 *  · 每个待提交路径都必须出现在当前 `git status` 的变更集合里，且落在仓库根内 ——
 *    否则一个被构造的请求就能暂存任意路径。
 *
 * 环境：`LC_ALL=C` 与 lib/git-changes 保持一致（文本解析确定性）。
 * 提交信息经 execFile 参数直传（不过 shell），中文无需转义。
 */

const execFileAsync = promisify(execFile);
const GIT_WRITE_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
const MAX_COMMIT_MESSAGE_LENGTH = 2000;
const MAX_SUBJECT_LENGTH = 100;

export class GitCommitError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  // core.quotepath=false：默认 git 会把非 ASCII 文件名转义成 "æ°..."，
  // 中文文件名在输出里就成了乱码。这是所有 git 调用的统一前提。
  const { stdout } = await execFileAsync("git", ["-c", "core.quotepath=false", "-C", cwd, ...args], {
    timeout: GIT_WRITE_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout;
}

function isWithin(parent: string, target: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(target));
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

/** 已选文件：entry 保留原始状态（展示用），rel 是 git 认的仓库相对路径 */
type PickedFile = { entry: GitFileStatus; rel: string };

/** 校验待提交文件：非空、落在仓库内、且确实处于变更状态 */
async function resolveCommittableFiles(
  repositoryRoot: string,
  requested: string[],
): Promise<{ status: GitStatusResponse; picked: PickedFile[] }> {
  if (!Array.isArray(requested) || requested.length === 0) {
    throw new GitCommitError("请至少选择一个文件");
  }
  if (requested.length > 1000) {
    throw new GitCommitError("一次提交的文件过多");
  }

  const status = await getGitStatus(repositoryRoot);
  if (!status.isGitRepository) throw new GitCommitError("当前目录不是 Git 仓库");

  /* 关键：status 返回的 filePath 是**绝对路径**，而调用方传进来的也可能是绝对或相对。
     统一以「仓库相对路径」（正斜杠）作为查表键与 git path 参数，否则永远匹配不上。 */
  const changed = new Map<string, GitFileStatus>();
  for (const f of status.files) {
    const abs = path.resolve(repositoryRoot, f.filePath);
    changed.set(toRepoRelative(repositoryRoot, abs), f);
  }

  const picked: PickedFile[] = [];
  const seen = new Set<string>();
  for (const raw of requested) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const abs = path.resolve(repositoryRoot, raw);
    if (!isWithin(repositoryRoot, abs)) {
      throw new GitCommitError(`路径不在仓库内：${raw}`);
    }
    const rel = toRepoRelative(repositoryRoot, abs);
    const entry = changed.get(rel);
    if (!entry) {
      throw new GitCommitError(`该文件当前没有变更：${rel}`);
    }
    if (seen.has(rel)) continue;
    seen.add(rel);
    picked.push({ entry, rel });
  }

  if (picked.length === 0) throw new GitCommitError("请至少选择一个文件");
  return { status, picked };
}

/** 仓库内绝对路径 → git 认的仓库相对路径（正斜杠） */
function toRepoRelative(repositoryRoot: string, abs: string): string {
  return path.relative(repositoryRoot, abs).split(path.sep).join("/");
}

function normalizeKey(p: string): string {
  return p.split(path.sep).join("/").replace(/^\.\//, "");
}

export interface CommitResult {
  hash: string;
  shortHash: string;
  subject: string;
  branch: string | null;
  committedFiles: string[];
  /** 选中但暂存后无实际变更、因而未能进入提交的路径 */
  skipped: string[];
}

/** 提交选中的文件。返回新提交的 hash 与标题。 */
export async function commitFiles(
  cwd: string,
  requestedFiles: string[],
  message: string,
): Promise<CommitResult> {
  const trimmed = typeof message === "string" ? message.trim() : "";
  if (!trimmed) throw new GitCommitError("提交信息不能为空");
  if (trimmed.length > MAX_COMMIT_MESSAGE_LENGTH) {
    throw new GitCommitError(`提交信息过长（上限 ${MAX_COMMIT_MESSAGE_LENGTH} 字）`);
  }

  const repositoryRoot = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  if (!repositoryRoot) throw new GitCommitError("无法定位仓库根目录");

  const { picked } = await resolveCommittableFiles(repositoryRoot, requestedFiles);

  // 未解决的冲突不能静默提交 —— 半解决的合并进历史后极难回溯
  const conflicted = picked.filter((p) => p.entry.status === "conflict");
  if (conflicted.length > 0) {
    throw new GitCommitError(
      `有 ${conflicted.length} 个文件处于冲突状态，请先解决后再提交：\n`
      + conflicted.slice(0, 5).map((p) => `· ${p.rel}`).join("\n"),
      409,
    );
  }

  const paths = picked.map((p) => p.rel);

  /*
   * 三步序列，每一步都是必需的（已用独立仓库逐个验证）：
   *
   * 1) reset HEAD -- <选中路径>
   *    把选中路径的暂存状态退回 HEAD。**不能省**：已经暂存的删除，其路径
   *    既不在索引也不在工作区，任何 pathspec（字面或 glob）都匹配不到，
   *    `git add` 会直接 `fatal: pathspec ... did not match any files`（exit 128）
   *    并**中止整条 add** —— 结果是一个文件都没暂存。退回 HEAD 后路径重新
   *    出现在索引里，后续命令才能匹配到它。
   *
   * 2) add -A -- <选中路径>
   *    按工作区实际状态暂存（新增 / 修改 / 删除三种都覆盖）。
   *
   * 3) commit -m <msg> -- <选中路径>
   *    `--only` 语义：只提交列出的路径，**忽略索引里其它已暂存内容**。
   *    否则一个带 pathspec 的 add 后直接 `git commit` 会把用户此前暂存、
   *    但本次并未勾选的文件一并提交 —— 与界面上「将提交 N 个文件」不符。
   *
   * 副作用（已知且接受）：如果调用方对选中文件做过部分暂存（git add -p），
   * 这里会改为暂存其工作区全量内容。这里的语义就是「提交这几个文件的当前状态」，
   * 与确认弹窗的承诺一致。
   */
  const gitOrThrow = async (args: string[], what: string): Promise<string> => {
    try {
      return await git(repositoryRoot, args);
    } catch (error) {
      const stderr = ((error as { stderr?: string }).stderr ?? "").trim();
      throw new GitCommitError(`${what}失败：${stderr || (error instanceof Error ? error.message : String(error))}`, 500);
    }
  };

  await gitOrThrow(["reset", "-q", "HEAD", "--", ...paths], "重置暂存区");
  await gitOrThrow(["add", "-A", "--", ...paths], "暂存文件");

  // 暂存后选中路径必须真的有变更（文件可能在拉取状态与提交之间被改回去了）
  const stagedForSelection = (await git(repositoryRoot, [
    "diff", "--cached", "--name-only", "--", ...paths,
  ])).trim();
  const stagedNames = new Set(stagedForSelection.split("\n").map((s) => s.trim()).filter(Boolean));
  const missing = paths.filter((p) => !stagedNames.has(p));
  if (stagedNames.size === 0) {
    throw new GitCommitError("选中的文件没有可提交的变更（可能已被改回原状，请刷新后重试）");
  }

  try {
    await git(repositoryRoot, ["commit", "-m", trimmed, "--", ...paths]);
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    // 缺少 user.name / user.email 是最常见的失败原因，直接给出可执行的指引
    if (/user\.(name|email)|Please tell me who you are/i.test(stderr)) {
      throw new GitCommitError(
        "Git 还没有配置提交身份。请先在终端执行：\n"
        + 'git config --global user.name "你的名字"\n'
        + 'git config --global user.email "你的邮箱"',
        409,
      );
    }
    throw new GitCommitError(stderr.trim() || (error instanceof Error ? error.message : String(error)), 500);
  }

  const hash = (await git(repositoryRoot, ["rev-parse", "HEAD"])).trim();
  const shortHash = (await git(repositoryRoot, ["rev-parse", "--short", "HEAD"])).trim();
  const subject = (await git(repositoryRoot, ["log", "-1", "--pretty=%s"])).trim();
  let branch: string | null = null;
  try {
    // 仓库可能处于 detached HEAD，此时 symbolic-ref 会失败
    branch = (await git(repositoryRoot, ["symbolic-ref", "--short", "HEAD"])).trim() || null;
  } catch {
    branch = null;
  }

  return { hash, shortHash, subject, branch, committedFiles: paths, skipped: missing };
}

export interface UndoCommitResult {
  previousSubject: string;
  previousShortHash: string;
  restoredFiles: number;
}

/**
 * 撤销最近一次提交（`git reset --soft HEAD~1`）。
 * 只回退提交记录，改动全部留在工作区/暂存区 —— 这是「撤回误提交」的安全做法。
 */
export async function undoLastCommit(cwd: string): Promise<UndoCommitResult> {
  const repositoryRoot = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  if (!repositoryRoot) throw new GitCommitError("无法定位仓库根目录");

  // 只有一个提交（或空仓库）时没有可回退的父提交
  try {
    await git(repositoryRoot, ["rev-parse", "--verify", "HEAD~1"]);
  } catch {
    throw new GitCommitError("已经是第一个提交，无法再撤销", 409);
  }

  const previousSubject = (await git(repositoryRoot, ["log", "-1", "--pretty=%s"])).trim();
  const previousShortHash = (await git(repositoryRoot, ["rev-parse", "--short", "HEAD"])).trim();

  await git(repositoryRoot, ["reset", "--soft", "HEAD~1"]);

  // reset --soft 之后原提交的改动全部回到暂存区 —— 数量按此统计
  const staged = (await git(repositoryRoot, ["diff", "--cached", "--name-only"])).trim();
  const restoredFiles = staged ? staged.split("\n").filter(Boolean).length : 0;
  return { previousSubject, previousShortHash, restoredFiles };
}

export interface CommitContext {
  /** 供模型阅读的改动摘要：文件清单 + 截断后的 patch */
  modelInput: string;
  fileCount: number;
  additions: number;
  deletions: number;
}

const MODEL_PATCH_MAX_BYTES = 12 * 1024;
const MODEL_UNTRACKED_FILE_MAX_BYTES = 4 * 1024;

/**
 * 组装给模型看的改动上下文。
 *
 * 已跟踪文件走 `git diff HEAD`。未跟踪文件**不用 `git add -N`** ——
 * 那会改动用户的 index（intent-to-add 条目会出现在他们的 git status 里）。
 * 改为直接读文件内容并截断，既不污染状态，模型也能看到新增文件写了什么。
 */
export async function buildCommitContext(cwd: string, requestedFiles: string[]): Promise<CommitContext> {
  const repositoryRoot = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  const { picked } = await resolveCommittableFiles(repositoryRoot, requestedFiles);
  const paths = picked.map((p) => p.rel);
  const listLines = picked.map((p) => `${p.entry.code}  ${p.rel}`);

  let patch = "";
  try {
    patch = await git(repositoryRoot, [
      "diff", "--unified=2", "--no-color", "--no-ext-diff", "HEAD", "--", ...paths,
    ]);
  } catch {
    patch = "";
  }
  if (patch.length > MODEL_PATCH_MAX_BYTES) {
    patch = `${patch.slice(0, MODEL_PATCH_MAX_BYTES)}\n（patch 已截断）`;
  }

  // 新增文件的内容不在 diff 里，单独附上
  const addedSections: string[] = [];
  for (const { entry, rel } of picked) {
    const isUntracked = entry.status === "untracked" || entry.indexStatus === "?" || entry.worktreeStatus === "?";
    if (!isUntracked) continue;
    try {
      const text = (await readFile(path.join(repositoryRoot, rel))).toString("utf8");
      addedSections.push(
        `--- 新增文件 ${rel}\n${text.length > MODEL_UNTRACKED_FILE_MAX_BYTES ? `${text.slice(0, MODEL_UNTRACKED_FILE_MAX_BYTES)}\n（内容已截断）` : text}`,
      );
    } catch {
      addedSections.push(`--- 新增文件 ${rel}（无法读取，可能是二进制）`);
    }
  }

  const body = [
    `改动文件（${picked.length} 个）：`,
    listLines.join("\n"),
    "",
    "完整改动（可能截断）：",
    patch || "（已跟踪文件无文本差异）",
    ...(addedSections.length > 0 ? ["", ...addedSections] : []),
  ].join("\n");

  return {
    modelInput: body,
    fileCount: picked.length,
    ...(await countSelectedStats(repositoryRoot, picked, addedSections.length)),
  };
}

/**
 * 选中文件的增/删行数。
 *
 * `git diff --numstat HEAD` **不含未跟踪文件** —— 只提交新增文件时会是 +0/−0，
 * 界面上那个「+N/−M」就是错的。未跟踪文件单独按内容行数计入新增。
 */
async function countSelectedStats(
  repositoryRoot: string,
  picked: PickedFile[],
  untrackedCount: number,
): Promise<{ additions: number; deletions: number }> {
  const tracked = picked.filter(
    (p) => !(p.entry.status === "untracked" || p.entry.indexStatus === "?" || p.entry.worktreeStatus === "?"),
  );
  let additions = 0;
  let deletions = 0;
  if (tracked.length > 0) {
    const paths = tracked.map((p) => p.rel);
    additions = await countNumstat(repositoryRoot, paths, 0);
    deletions = await countNumstat(repositoryRoot, paths, 1);
  }
  for (const { rel } of picked) {
    const isUntracked = !tracked.some((t) => t.rel === rel);
    if (!isUntracked) continue;
    try {
      const text = (await readFile(path.join(repositoryRoot, rel))).toString("utf8");
      if (text.length > 0) additions += text.split(/\r?\n/).length - (text.endsWith("\n") ? 1 : 0);
    } catch {
      /* 二进制或不可读：不计行数 */
    }
  }
  return { additions, deletions };
}

/** 选中文件的增/删行数（git diff --numstat 的某一列，二进制文件记 "-" 则跳过） */
async function countNumstat(repositoryRoot: string, paths: string[], column: 0 | 1): Promise<number> {
  try {
    const out = await git(repositoryRoot, ["diff", "--numstat", "HEAD", "--", ...paths]);
    return out
      .split("\n")
      .map((line) => line.split("\t")[column])
      .reduce((sum, v) => sum + (v && /^\d+$/.test(v) ? Number(v) : 0), 0);
  } catch {
    return 0;
  }
}

export function sanitizeCommitSubject(raw: string): string {
  const firstLine = raw.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  let stripped = firstLine.replace(/^```[a-z]*\s*/i, "").trim();
  stripped = stripped.replace(/^(commit message|message|提交信息)\s*[:：]\s*/i, "").trim();
  // 去掉模型习惯性包上的整体引号
  if (/^["'`].*["'`]$/.test(stripped)) stripped = stripped.slice(1, -1).trim();
  return stripped.length > MAX_SUBJECT_LENGTH
    ? stripped.slice(0, MAX_SUBJECT_LENGTH).trim()
    : stripped;
}
