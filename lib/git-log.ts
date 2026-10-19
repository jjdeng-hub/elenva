import { execFile } from "child_process";
import { promisify } from "util";
import { GitOpError } from "./git-errors";
import { isValidCommitHash } from "./git-rev";

/**
 * 提交历史（只读）。
 *
 * 解析要点：`git log` 的输出里**主题、作者名什么都可能有**（`|`、`:`、引号、emoji、
 * 中文）。所以输出格式用不可见分隔符（`%x1f` 字段 / `%x1e` 记录），绝不能按
 * `|` 或 `:` 切 —— 那样一条 `fix: 处理 a|b` 的提交就能把解析结果错位。
 *
 * 增删行数走 `--numstat`（二进制文件给 `-`，按「不是数字就跳过」处理）。
 */

const execFileAsync = promisify(execFile);
const GIT_LOG_TIMEOUT_MS = 15_000;
const GIT_LOG_MAX_BUFFER = 16 * 1024 * 1024;

export const GIT_LOG_DEFAULT_LIMIT = 30;
export const GIT_LOG_MAX_LIMIT = 100;

const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";
const LOG_FORMAT = ["%H", "%h", "%an", "%aI", "%P", "%s"].join(FIELD_SEP) + RECORD_SEP;

export interface GitCommitSummary {
  hash: string;
  shortHash: string;
  author: string;
  /** 作者时间（ISO 8601，含时区） */
  date: string;
  subject: string;
  parents: string[];
  filesChanged: number;
  additions: number;
  deletions: number;
  isHead: boolean;
}

export interface GitLogResponse {
  isGitRepository: boolean;
  branch: string | null;
  commits: GitCommitSummary[];
  hasMore: boolean;
  /** 仓库存在但还没有任何提交（HEAD 指向未创建的分支） */
  emptyRepository?: boolean;
}

export type ParsedLogCommit = Omit<GitCommitSummary, "isHead">;

async function git(cwd: string, args: string[], maxBuffer = GIT_LOG_MAX_BUFFER): Promise<string> {
  // core.quotepath=false：否则非 ASCII 路径在 diff/status 里会被转义成乱码。
  const { stdout } = await execFileAsync("git", ["-c", "core.quotepath=false", "-C", cwd, ...args], {
    timeout: GIT_LOG_TIMEOUT_MS,
    maxBuffer,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout;
}

/**
 * 纯函数：解析 `git log --pretty=format:<LOG_FORMAT> --numstat` 的输出。
 *
 * 结构（实测）：
 *   <hash>\x1f<short>\x1f<author>\x1f<date>\x1f<parents>\x1f<subject>\x1e
 *   12\t3\tpath/one
 *   -\t-\tpath/binary
 *
 *   <下一个提交…>
 *
 * 判据：以 `\x1e` 结尾的行就是元信息行；其余非空行是 numstat 行归到当前提交。
 * 空行（numstat 与下一个提交之间的分隔）直接跳过。
 */
export function parseGitLogOutput(output: string): ParsedLogCommit[] {
  const commits: ParsedLogCommit[] = [];
  let current: ParsedLogCommit | null = null;

  for (const line of output.split("\n")) {
    if (line.endsWith(RECORD_SEP)) {
      const fields = line.slice(0, -1).split(FIELD_SEP);
      const [hash = "", shortHash = "", author = "", date = "", parentField = ""] = fields;
      if (!hash) {
        current = null;
        continue;
      }
      current = {
        hash,
        shortHash,
        author,
        date,
        // 主题里若混进了 \x1f（理论可能），fields[5] 之后的内容全部并回来
        subject: fields.slice(5).join(FIELD_SEP),
        parents: parentField ? parentField.split(" ").filter(Boolean) : [],
        filesChanged: 0,
        additions: 0,
        deletions: 0,
      };
      commits.push(current);
      continue;
    }

    if (!current || !line.trim()) continue;

    const firstTab = line.indexOf("\t");
    const secondTab = firstTab < 0 ? -1 : line.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;

    const addedRaw = line.slice(0, firstTab);
    const deletedRaw = line.slice(firstTab + 1, secondTab);
    current.filesChanged += 1;
    // 二进制文件给的是 "-"，不是数字 —— 只累加真实行数
    if (/^\d+$/.test(addedRaw)) current.additions += Number(addedRaw);
    if (/^\d+$/.test(deletedRaw)) current.deletions += Number(deletedRaw);
  }

  return commits;
}

async function findRepositoryRoot(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim() || null;
  } catch {
    return null;
  }
}

async function readBranch(repositoryRoot: string): Promise<string | null> {
  try {
    // detached HEAD 时 symbolic-ref 会失败 —— 返回 null 而不是让整个接口失败
    return (await git(repositoryRoot, ["symbolic-ref", "--short", "HEAD"])).trim() || null;
  } catch {
    return null;
  }
}

export interface GitLogOptions {
  limit?: number;
  /** 分页游标：从该提交（不含）继续往旧翻，用 hash 表示 */
  before?: string | null;
}

export function normalizeLogLimit(raw: unknown): number {
  const value = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(value) || value <= 0) return GIT_LOG_DEFAULT_LIMIT;
  return Math.min(Math.floor(value), GIT_LOG_MAX_LIMIT);
}

export async function getGitLog(cwd: string, options: GitLogOptions = {}): Promise<GitLogResponse> {
  const limit = normalizeLogLimit(options.limit);
  const repositoryRoot = await findRepositoryRoot(cwd);
  if (!repositoryRoot) {
    return { isGitRepository: false, branch: null, commits: [], hasMore: false };
  }

  const branch = await readBranch(repositoryRoot);

  let headHash: string | null = null;
  try {
    headHash = (await git(repositoryRoot, ["rev-parse", "--verify", "HEAD"])).trim() || null;
  } catch {
    headHash = null;
  }
  if (!headHash) {
    return { isGitRepository: true, branch, commits: [], hasMore: false, emptyRepository: true };
  }

  const before = typeof options.before === "string" && options.before.trim() ? options.before.trim() : null;
  if (before && !isValidCommitHash(before)) {
    throw new GitOpError("before 必须是提交 hash（4–40 位小写十六进制）", 400);
  }
  if (before) {
    try {
      await git(repositoryRoot, ["rev-parse", "--verify", `${before}^{commit}`]);
    } catch {
      throw new GitOpError("before 不是本仓库中可解析的提交", 400);
    }
  }

  // 多取一条判断 hasMore；分页时把游标自身那条去掉
  const args = ["log", `--pretty=format:${LOG_FORMAT}`, "--numstat", "-n", String(limit + 1)];
  if (before) args.push(before);

  let parsed: ParsedLogCommit[];
  try {
    parsed = parseGitLogOutput(await git(repositoryRoot, args));
  } catch (error) {
    const stderr = ((error as { stderr?: string }).stderr ?? "").trim();
    throw new GitOpError(stderr || "读取提交历史失败", 500);
  }

  if (before) parsed = parsed.slice(1);
  const hasMore = parsed.length > limit;
  const commits: GitCommitSummary[] = parsed.slice(0, limit).map((commit) => ({
    ...commit,
    isHead: commit.hash === headHash,
  }));

  // 浅克隆：HEAD 存在但没有父提交，`git log` 只会给一条 —— 不是错误，照常返回
  return { isGitRepository: true, branch, commits, hasMore };
}
