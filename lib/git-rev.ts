/**
 * 提交 hash 校验（历史 / 详情 / 恢复三个入口共用）。
 *
 * 为什么单独成文件：`hash` 是这三个接口里**唯一直接拼进 git 命令行的用户输入**。
 * 一旦它允许 `--`、`..`、`~`、空格之类，调用方就能往 argv 里塞选项或 revision 语法
 * （`--upload-pack=...`、`HEAD~5`、`a..b`），把只读接口变成任意对象读取。
 *
 * 放宽成「只校验非空」就够了吗 —— 不够。所以这里只认小写十六进制 4–40 位：
 *   · `--upload-pack=x`、`-1`、`HEAD`、`main` 一律拒绝（大写也拒绝，git 自己认小写）
 *   · 4 位以上才可能是短 hash；超过 40 位不可能是合法对象名
 */
export const COMMIT_HASH_PATTERN = /^[0-9a-f]{4,40}$/;

export function isValidCommitHash(value: unknown): value is string {
  return typeof value === "string" && COMMIT_HASH_PATTERN.test(value);
}
