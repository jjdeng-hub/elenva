import { normalize, parse, sep } from "path";

// ============================================================================
// Path primitives.
//
// Two canonical forms coexist deliberately — pick by where the path is going:
//
//   toNativePath()  Native separators (`D:\repo` on Windows). Use for anything
//                   that reaches fs/path APIs, gets compared against a session
//                   cwd, or is shown to the user. This is the form pi records
//                   cwds in, so it is the default for user-facing paths.
//
//   toSlashPath()   Forward slashes (`D:/repo`). Use only for internal,
//                   never-displayed bookkeeping — the allowed-roots set, and
//                   separator-insensitive text matching. Containment checks
//                   re-normalize their inputs anyway (see path-security.ts),
//                   so this form is about consistent keys, not correctness.
//
// Comparison always goes through samePath()/isPathWithinRoots(), never `===`:
// git emits POSIX-style paths even on Windows, and Windows itself is
// case-insensitive, so raw string equality silently fails on both counts.
// ============================================================================

const WINDOWS_ABSOLUTE_RE = /^[a-zA-Z]:[\\/]/;

export function isWindowsAbsolutePath(filePath: string): boolean {
  return WINDOWS_ABSOLUTE_RE.test(filePath) || filePath.startsWith("\\\\") || filePath.startsWith("//");
}

/** Rebuild an absolute filesystem path from Next.js catch-all route segments. */
export function filePathFromApiSegments(segments: string[]): string {
  const joined = segments.join("/");
  const slashJoined = toSlashPath(joined);
  if (/^[a-zA-Z]:$/.test(slashJoined)) return `${slashJoined}/`;
  if (isWindowsAbsolutePath(slashJoined)) return slashJoined;
  return "/" + joined.replace(/^\/+/, "");
}

/**
 * Convert a path to native separators. Chiefly for git output: git prints
 * POSIX-style absolute paths even on Windows (`D:/repo/sub`), which never
 * string-compares equal to the native paths Node and pi produce.
 *
 * Only pass paths — a branch name like `feature/x` would become `feature\x`.
 */
export function toNativePath(p: string): string {
  if (!p || process.platform !== "win32") return p;
  return normalize(p);
}

/** Convert a path to forward slashes. See the form guidance above. */
export function toSlashPath(p: string): string {
  return p.replace(/\\/g, "/");
}

function normalizeForComparison(p: string): string {
  const normalized = normalize(toNativePath(p));
  const rootLength = parse(normalized).root.length;
  let end = normalized.length;
  while (end > rootLength && normalized[end - 1] === sep) end--;
  return normalized.slice(0, end);
}

/**
 * Whether two paths denote the same location, tolerating separator style and —
 * on Windows, where the filesystem is case-insensitive — case, including the
 * drive letter (`d:\repo` vs `D:\repo`).
 *
 * Compares lexically: callers wanting symlinks resolved should realpath first.
 */
export function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const normalizedA = normalizeForComparison(a);
  const normalizedB = normalizeForComparison(b);
  if (process.platform === "win32") {
    return normalizedA.toLowerCase() === normalizedB.toLowerCase();
  }
  return normalizedA === normalizedB;
}

/**
 * 路径作为 **Map/JSON 的 key** 时的规范形式。
 *
 * 为什么需要它：同一个目录会以不同写法到达不同代码 —— 界面上传的会话 cwd 是 `C:/x/y`，
 * 而内核 `sessionManager.getCwd()` 返回的是原生形式 `C:\x\y`。直接拿它们当对象 key，
 * 就会出现「写进去一个、按另一个查」，**静默失效**（审批白名单就这幺坏过：用户点
 * 「总是允许」，规则存下了但永远匹配不上）。
 *
 * 与 samePath 的分工：那个用于一次性比较，这个用于**落到磁盘的 key** —— 必须是稳定的
 * 字符串形式（统一正斜杠 + 去尾斜杠 + Windows 下小写），才能跨进程/跨会话一致。
 */
export function cwdKey(value: string): string {
  if (!value) return "";
  const slashed = toSlashPath(value.trim()).replace(/\/+$/, "");
  return process.platform === "win32" ? slashed.toLowerCase() : slashed;
}
