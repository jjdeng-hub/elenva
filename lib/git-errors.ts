/**
 * git 写/恢复类操作的统一错误：带 HTTP 状态码，路由层直接映射。
 *
 * 与 lib/git-commit.ts 的 GitCommitError 同形（那边的历史调用点先不动），
 * 新增的 log / show / restore-file 一律用这个。
 */
export class GitOpError extends Error {
  constructor(message: string, readonly status = 400, readonly code?: string) {
    super(message);
    this.name = "GitOpError";
  }
}
