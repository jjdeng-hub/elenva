import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { GitOpError } from "./git-errors";
import { getGitStatus } from "./git-changes";
import { isValidCommitHash } from "./git-rev";

/**
 * 从历史恢复单个文件（`git checkout <hash> -- <path>`）。
 *
 * 这是本轮唯一会**覆盖工作区内容**的操作，所以门是三重的：
 *   1. `hash` 只认 4–40 位小写十六进制（lib/git-rev）
 *   2. `path` 必须是仓库内的相对路径：绝对路径、`..`、NUL 一律拒绝；
 *      解析后再确认落在仓库根内，且路径上任何一段的**真实路径**（realpath）
 *      没有指到仓库外（软链逃逸）
 *   3. 目标文件在当前工作区有未提交改动（含未跟踪/被忽略的既有文件）→ 409，
 *      要调用方显式 `force: true` 才放行
 *
 * 所有带路径的 git 调用都加 `--literal-pathspecs`：否则 `a[1].txt` 会被当
 * pathspec 通配符，可能匹配到本不该动的文件。
 */

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 20_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["--literal-pathspecs", "-c", "core.quotepath=false", "-C", cwd, ...args],
    { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, env: { ...process.env, LC_ALL: "C" } },
  );
  return stdout;
}

function isWithin(parent: string, target: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(target));
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

/**
 * 纯函数：把调用方给的 path 规范化成「仓库内相对路径」。
 * 不合法直接抛 GitOpError(400)。不做任何 IO —— 软链检查在 resolveRepoSafePath。
 */
export function sanitizeRepoRelativePath(raw: unknown): string {
  if (typeof raw !== "string") throw new GitOpError("path 必须是字符串", 400, "invalid-path");
  const trimmed = raw.trim();
  if (!trimmed) throw new GitOpError("path 不能为空", 400, "invalid-path");
  if (trimmed.includes("\0")) throw new GitOpError("path 含非法字符", 400, "invalid-path");

  // Windows 风格分隔符统一成 git 认的正斜杠
  const slashed = trimmed.replace(/\\/g, "/");
  if (slashed.startsWith("/")) {
    throw new GitOpError("path 必须是仓库内的相对路径，不能是绝对路径", 400, "invalid-path");
  }
  if (/^[a-zA-Z]:/.test(slashed) || slashed.startsWith("//")) {
    throw new GitOpError("path 必须是仓库内的相对路径，不能是绝对路径", 400, "invalid-path");
  }

  const segments = slashed.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0) throw new GitOpError("path 不能为空", 400, "invalid-path");
  if (segments.some((segment) => segment === "..")) {
    throw new GitOpError("path 不能包含 ..，必须留在仓库内", 400, "invalid-path");
  }
  return segments.join("/");
}

/**
 * 在 sanitizeRepoRelativePath 之后做 IO 层校验：解析出的绝对路径必须在仓库根内，
 * 且路径上「最深的存在祖先」realpath 之后仍在仓库内（挡仓库内软链指向外部）。
 * 返回绝对路径。
 */
export function resolveRepoSafePath(repositoryRoot: string, relativePath: string): string {
  const absolute = path.resolve(repositoryRoot, relativePath);
  if (!isWithin(repositoryRoot, absolute)) {
    throw new GitOpError("path 解析后落在仓库外", 403, "path-escape");
  }

  let realRoot: string;
  try {
    realRoot = fs.realpathSync(repositoryRoot);
  } catch {
    throw new GitOpError("无法解析仓库根目录", 500, "path-escape");
  }

  // 目标可能不存在（在历史里被删除的文件），逐级往上找第一个存在的祖先
  let probe = absolute;
  for (;;) {
    if (fs.existsSync(probe)) break;
    const parent = path.dirname(probe);
    if (parent === probe) return absolute;
    probe = parent;
  }
  let realProbe: string;
  try {
    realProbe = fs.realpathSync(probe);
  } catch {
    throw new GitOpError("无法解析路径的真实位置", 403, "path-escape");
  }
  if (!isWithin(realRoot, realProbe)) {
    throw new GitOpError("path 经软链指向仓库外，拒绝操作", 403, "path-escape");
  }
  return absolute;
}

export interface RestoreFileResult {
  hash: string;
  shortHash: string;
  subject: string;
  /** 仓库相对路径 */
  path: string;
  /** 恢复后是否与 HEAD 一致（true 表示工作区回到了 HEAD 的版本） */
  matchesHead: boolean;
  /** 恢复后该文件在 git status 里的状态；null = 与 HEAD 一致 */
  status: { code: string; status: string } | null;
}

/** 目标文件在当前工作区是否有未提交改动（含未跟踪 / 被忽略但存在的文件） */
async function hasUncommittedChanges(repositoryRoot: string, relativePath: string): Promise<boolean> {
  // HEAD ↔ 工作区（含已暂存 + 未暂存）的差异；exit 1 = 有差异
  try {
    await git(repositoryRoot, ["diff", "--quiet", "HEAD", "--", relativePath]);
  } catch {
    return true;
  }
  const absolute = path.join(repositoryRoot, relativePath);
  if (fs.existsSync(absolute)) {
    // 工作区里存在但 HEAD 里没有（未跟踪 / 被忽略）也算「会被覆盖」
    const trackedInHead = (await git(repositoryRoot, ["ls-tree", "-z", "HEAD", "--", relativePath])).trim();
    if (!trackedInHead) return true;
  }
  return false;
}

/** 该路径在指定提交里是什么（blob / tree / 不存在） */
async function readTreeEntry(
  repositoryRoot: string,
  treeish: string,
  relativePath: string,
): Promise<{ type: string } | null> {
  const output = await git(repositoryRoot, ["ls-tree", "-z", treeish, "--", relativePath]);
  const record = output.split("\0").find(Boolean);
  if (!record) return null;
  // "<mode> <type> <hash>\t<path>"
  const header = record.slice(0, record.indexOf("\t"));
  const type = header.split(" ")[1] ?? "";
  return { type };
}

export async function restoreFileFromCommit(
  cwd: string,
  rawHash: unknown,
  rawPath: unknown,
  options: { force?: boolean } = {},
): Promise<RestoreFileResult> {
  const hash = typeof rawHash === "string" ? rawHash.trim() : "";
  if (!isValidCommitHash(hash)) {
    throw new GitOpError("hash 必须是 4–40 位小写十六进制", 400, "invalid-hash");
  }
  const relativePath = sanitizeRepoRelativePath(rawPath);

  let repositoryRoot: string;
  try {
    repositoryRoot = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    throw new GitOpError("当前目录不是 Git 仓库", 400, "not-a-repository");
  }
  if (!repositoryRoot) throw new GitOpError("无法定位仓库根目录", 400, "not-a-repository");

  // 软链 / 越界检查（顺带把相对路径锚定到真实仓库根）
  const absolute = resolveRepoSafePath(repositoryRoot, relativePath);

  try {
    await git(repositoryRoot, ["rev-parse", "--verify", `${hash}^{commit}`]);
  } catch {
    throw new GitOpError("找不到该提交", 404, "unknown-commit");
  }

  const entry = await readTreeEntry(repositoryRoot, hash, relativePath);
  if (!entry) {
    throw new GitOpError(`该文件在提交 ${hash.slice(0, 8)} 中不存在：${relativePath}`, 404, "path-not-in-commit");
  }
  if (entry.type === "tree") {
    throw new GitOpError("path 指向一个目录，请指定具体文件", 400, "path-is-directory");
  }

  // 目标当前是否是个目录（git checkout 会展开整个目录）
  try {
    if (fs.statSync(absolute).isDirectory()) {
      throw new GitOpError("path 指向工作区里的一个目录，请指定具体文件", 400, "path-is-directory");
    }
  } catch (error) {
    if (error instanceof GitOpError) throw error;
    /* 文件不存在是正常的（历史里删除过的文件） */
  }

  if (!options.force && (await hasUncommittedChanges(repositoryRoot, relativePath))) {
    throw new GitOpError(
      `该文件有未提交改动，恢复会覆盖它们：${relativePath}\n确认后请带 force: true 重试`,
      409,
      "uncommitted-changes",
    );
  }

  try {
    await git(repositoryRoot, ["checkout", hash, "--", relativePath]);
  } catch (error) {
    const stderr = ((error as { stderr?: string }).stderr ?? "").trim();
    throw new GitOpError(stderr || "恢复文件失败", 500, "restore-failed");
  }

  const metaRaw = (await git(repositoryRoot, ["show", "-s", "--format=%h\x1f%s", hash])).trim();
  const [shortHash = "", subject = ""] = metaRaw.split("\x1f");

  let matchesHead = false;
  try {
    await git(repositoryRoot, ["diff", "--quiet", "HEAD", "--", relativePath]);
    matchesHead = true;
  } catch {
    matchesHead = false;
  }

  let status: { code: string; status: string } | null = null;
  if (!matchesHead) {
    const repoStatus = await getGitStatus(repositoryRoot);
    const targetKey = path.resolve(absolute);
    const found = repoStatus.files.find((file) => path.resolve(file.filePath) === targetKey);
    if (found) status = { code: found.code, status: found.status };
  }

  return { hash, shortHash, subject, path: relativePath, matchesHead, status };
}
