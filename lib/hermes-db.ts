/**
 * Hermes `state.db` 的 schema 兼容层（只读，供各读取点共用）。
 *
 * 背景（2026-11-14 实测）：Hermes v0.19 / schema_version 22 的 `sessions` 表
 * **没有** `last_activity_at` 这一列 —— 早期版本有。此前 profile 名册、会话列表、
 * 内容搜索三处都直接 `select last_activity_at`，在新版本上整条查询抛
 * `ERR_SQLITE_ERROR`，又被各自的 catch 吞成空值：界面表现就是「会话数 —」
 * 「Hermes 会话列表空」。
 *
 * 这里按实际列名挑表达式，两代 schema 都能读；不引 YAML/SQLite 之外的新依赖。
 */

/** 只用到 `prepare().all()` 的最小形状，避免把 node:sqlite 静态引进来。 */
export interface SqliteLike {
  prepare(sql: string): { all(): unknown[] };
}

/** 读一张表的列名（`pragma table_info`）。 */
export function tableColumns(db: SqliteLike, table: string): Set<string> {
  const rows = db.prepare(`pragma table_info(${table})`).all() as Array<{ name?: unknown }>;
  return new Set(rows.map((row) => String(row.name ?? "")));
}

/**
 * 「会话最后活跃」的 SQL 表达式。
 * 注意：主查询必须写成 `from sessions`（不带别名），表达式里用的是 `sessions.id`。
 */
export function sessionActivityExpr(columns: Set<string>): string {
  if (columns.has("last_activity_at")) return "coalesce(last_activity_at, started_at)";
  // 新 schema：messages.timestamp（idx_messages_session 支撑），ended_at 兜底
  return "coalesce((select max(m.timestamp) from messages m where m.session_id = sessions.id), ended_at, started_at)";
}
