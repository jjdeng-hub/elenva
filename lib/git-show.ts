import { execFile } from "child_process";
import { promisify } from "util";
import { GitOpError } from "./git-errors";
import { isValidCommitHash } from "./git-rev";

/**
 * 单次提交详情（只读）。
 *
 * 两处必须小心：
 *  1. `hash` 会被拼进 argv —— 只认 4–40 位小写十六进制（lib/git-rev）。
 *  2. 每个文件的 diff 都用 `--literal-pathspecs` 传路径，避免 `a[1].txt` 这类
 *     文件名被当成 pathspec 通配符匹配到别的文件。
 *
 * 体积控制：单文件 64KB 截断（`truncated: true`），整份响应 512KB 上限；
 * 文件数超过 50 的提交不再取 diff（只给状态与行数），避免一次详情拉爆前后端。
 */

const execFileAsync = promisify(execFile);
const GIT_SHOW_TIMEOUT_MS = 20_000;
const GIT_SHOW_MAX_BUFFER = 32 * 1024 * 1024;

export const GIT_SHOW_PER_FILE_DIFF_MAX_BYTES = 64 * 1024;
export const GIT_SHOW_TOTAL_DIFF_MAX_BYTES = 512 * 1024;
export const GIT_SHOW_MAX_DIFF_FILES = 50;

const FIELD_SEP = "\x1f";
const META_FORMAT = ["%H", "%h", "%an", "%ae", "%aI", "%P", "%s", "%b"].join(FIELD_SEP);

export interface GitCommitMeta {
  hash: string;
  shortHash: string;
  subject: string;
  body: string;
  author: string;
  authorEmail: string;
  date: string;
  parents: string[];
}

export interface GitCommitFile {
  path: string;
  /** 重命名 / 复制的源路径 */
  oldPath?: string;
  /** 单字符状态码：M/A/D/R/C/T/U/X */
  status: string;
  /** 文本增删行数；二进制文件为 null */
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  diff: string | null;
  truncated: boolean;
  /** 没取 diff 的原因（文件过多 / 二进制 / 超出总量上限） */
  note?: string;
}

export interface GitShowResponse {
  commit: GitCommitMeta;
  files: GitCommitFile[];
  diffTruncated: boolean;
}

export interface NameStatusEntry {
  status: string;
  path: string;
  oldPath?: string;
}

export interface NumstatEntry {
  path: string;
  oldPath?: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

async function git(cwd: string, args: string[], maxBuffer = GIT_SHOW_MAX_BUFFER): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    // --literal-pathspecs 放最前：告诉 git 后面的 `-- <path>` 都是字面路径，不做 glob
    ["--literal-pathspecs", "-c", "core.quotepath=false", "-C", cwd, ...args],
    { timeout: GIT_SHOW_TIMEOUT_MS, maxBuffer, env: { ...process.env, LC_ALL: "C" } },
  );
  return stdout;
}

/** 按字节截断，且不留下被切一半的 UTF-8 尾巴 */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  let out = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  if (out.endsWith("\uFFFD")) out = out.slice(0, -1);
  return { text: out, truncated: true };
}

/** 纯函数：解析 `git show -s --format=<META_FORMAT>` */
export function parseCommitMeta(output: string): GitCommitMeta {
  const fields = output.replace(/\n+$/, "").split(FIELD_SEP);
  const [hash = "", shortHash = "", author = "", authorEmail = "", date = "", parentField = ""] = fields;
  return {
    hash,
    shortHash,
    author,
    authorEmail,
    date,
    parents: parentField ? parentField.split(" ").filter(Boolean) : [],
    subject: fields[6] ?? "",
    // %b 是最后一个字段，正文里的 \x1f 用 join 拼回来
    body: fields.slice(7).join(FIELD_SEP).replace(/\s+$/, ""),
  };
}

/**
 * 纯函数：解析 `git diff-tree --name-status -r -z -M -C`。
 * 记录为 NUL 分隔；重命名/复制是 `<status>\0<old>\0<new>\0`。
 */
export function parseNameStatusZ(output: string): NameStatusEntry[] {
  const tokens = output.split("\0");
  const entries: NameStatusEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i++];
    if (!status) continue;
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = tokens[i++];
      const path = tokens[i++];
      if (!path) continue;
      entries.push({ status, path, oldPath });
    } else {
      const path = tokens[i++];
      if (!path) continue;
      entries.push({ status, path });
    }
  }
  return entries;
}

/**
 * 纯函数：解析 `git diff-tree --numstat -r -z -M -C`。
 * 普通记录 `add\tdel\tpath\0`；重命名 `add\tdel\t\0old\0new\0`；二进制给 `-\t-`。
 */
export function parseNumstatZ(output: string): NumstatEntry[] {
  const tokens = output.split("\0");
  const entries: NumstatEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const line = tokens[i++];
    if (!line) continue;
    const firstTab = line.indexOf("\t");
    const secondTab = firstTab < 0 ? -1 : line.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const addedRaw = line.slice(0, firstTab);
    const deletedRaw = line.slice(firstTab + 1, secondTab);
    let path = line.slice(secondTab + 1);
    let oldPath: string | undefined;
    if (path === "") {
      oldPath = tokens[i++];
      path = tokens[i++];
    }
    if (!path) continue;
    const binary = addedRaw === "-" || deletedRaw === "-";
    entries.push({
      path,
      oldPath,
      additions: /^\d+$/.test(addedRaw) ? Number(addedRaw) : null,
      deletions: /^\d+$/.test(deletedRaw) ? Number(deletedRaw) : null,
      binary,
    });
  }
  return entries;
}

export interface GitShowOptions {
  /** 单文件 diff 上限（默认 64KB）；自测用 */
  perFileMaxBytes?: number;
  /** 整份 diff 总量上限（默认 512KB）；自测用 */
  totalMaxBytes?: number;
  /** 最多为多少个文件取 diff（默认 50）；自测用 */
  maxDiffFiles?: number;
}

export async function getGitShow(
  cwd: string,
  rawHash: string,
  options: GitShowOptions = {},
): Promise<GitShowResponse> {
  const hash = typeof rawHash === "string" ? rawHash.trim() : "";
  if (!isValidCommitHash(hash)) {
    throw new GitOpError("hash 必须是 4–40 位小写十六进制", 400);
  }

  let repositoryRoot: string;
  try {
    repositoryRoot = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    throw new GitOpError("当前目录不是 Git 仓库", 400);
  }
  if (!repositoryRoot) throw new GitOpError("无法定位仓库根目录", 400);

  try {
    await git(repositoryRoot, ["rev-parse", "--verify", `${hash}^{commit}`]);
  } catch {
    throw new GitOpError("找不到该提交", 404);
  }

  const perFileMax = options.perFileMaxBytes ?? GIT_SHOW_PER_FILE_DIFF_MAX_BYTES;
  const totalMax = options.totalMaxBytes ?? GIT_SHOW_TOTAL_DIFF_MAX_BYTES;
  const maxDiffFiles = options.maxDiffFiles ?? GIT_SHOW_MAX_DIFF_FILES;

  const commit = parseCommitMeta(await git(repositoryRoot, ["show", "-s", `--format=${META_FORMAT}`, hash]));

  const [nameStatusRaw, numstatRaw] = await Promise.all([
    git(repositoryRoot, ["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", "-z", "-M", "-C", hash]),
    git(repositoryRoot, ["diff-tree", "--root", "--no-commit-id", "--numstat", "-r", "-z", "-M", "-C", hash]),
  ]);
  const nameStatus = parseNameStatusZ(nameStatusRaw);
  const stats = new Map(parseNumstatZ(numstatRaw).map((entry) => [entry.path, entry]));

  const files: GitCommitFile[] = [];
  let usedBytes = 0;
  let diffTruncated = false;
  let diffFetched = 0;

  for (const entry of nameStatus) {
    const stat = stats.get(entry.path);
    const file: GitCommitFile = {
      path: entry.path,
      oldPath: entry.oldPath ?? stat?.oldPath,
      status: entry.status.charAt(0).toUpperCase(),
      additions: stat?.additions ?? null,
      deletions: stat?.deletions ?? null,
      binary: stat?.binary ?? false,
      diff: null,
      truncated: false,
    };

    if (file.binary) {
      file.note = "二进制文件，不显示 diff";
      files.push(file);
      continue;
    }
    if (diffFetched >= maxDiffFiles) {
      file.truncated = true;
      file.note = `变更文件过多，未加载 diff（上限 ${maxDiffFiles} 个）`;
      diffTruncated = true;
      files.push(file);
      continue;
    }
    if (usedBytes >= totalMax) {
      file.truncated = true;
      file.note = "本次响应 diff 总量已达上限，未加载此文件的 diff";
      diffTruncated = true;
      files.push(file);
      continue;
    }

    const pathspec = file.oldPath && file.oldPath !== file.path ? [file.oldPath, file.path] : [file.path];
    let patch: string;
    try {
      patch = await git(repositoryRoot, ["show", "--no-color", "--no-ext-diff", "--format=", "--unified=3", hash, "--", ...pathspec]);
    } catch {
      file.truncated = true;
      file.note = "无法读取该文件的 diff";
      files.push(file);
      continue;
    }
    diffFetched += 1;

    const remaining = totalMax - usedBytes;
    const limit = Math.min(perFileMax, remaining);
    const cut = truncateUtf8(patch, limit);
    usedBytes += Buffer.byteLength(cut.text, "utf8");
    file.diff = cut.text;
    if (cut.truncated) {
      file.truncated = true;
      file.note = limit < perFileMax ? "超出本次响应总量上限，已截断" : "diff 过大，已截断";
      diffTruncated = true;
    }
    files.push(file);
  }

  return { commit, files, diffTruncated };
}
