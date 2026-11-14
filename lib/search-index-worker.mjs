/**
 * 会话内容搜索 · FTS5 索引 worker（P4d）
 *
 * 独立索引库 ~/.elenva/search-index.db，**绝不写 Hermes 的 state.db**（只读打开）。
 *
 * 为什么放进 worker_threads：node:sqlite 的同步语句跑在 JS 线程上，
 * 主线程的死线检查要等 SQLite 吐出整块结果才轮得到（P4b 验收实测 8573ms 拦不住）。
 * worker 里同样有软死线（批间检查，进度分批提交不丢），主线程到硬死线直接 terminate，
 * 双保险保证搜索在 2s 内返回。
 *
 * 结构：
 * - docs(id INTEGER PK, profile, session_id, ts REAL, role, content) —— 存正文（单条截断）
 * - messages_fts USING fts5(content, content='docs', content_rowid='id', tokenize="trigram")
 *   外挂内容表：FTS 只存倒排，不重复存正文；trigram 支持中文子串与 ASCII 大小写不敏感
 * - meta(profile PK, last_rowid, updated_at) —— 每 profile 的同步水位（state.db messages.rowid）
 *
 * 协议：parentPort 收 { type: "search"|"reindex", token, ... }，回 { token, ... }。
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parentPort } from "node:worker_threads";

/** 单条消息最多入索引的字符数（片段只取几十字，32K 绰绰有余；同时控制索引体积） */
const MAX_CONTENT_CHARS = 32_000;
/** 增量同步的批大小（每批一个事务：超时中断时已提交的进度不丢） */
const SYNC_BATCH = 2_000;
/** 搜索最多读的命中行数（之后按 bm25 截断） */
const MAX_MATCH_ROWS = 4_000;
/** 单次搜索最多返回的会话数 */
const MAX_SESSIONS = 50;
/** 每会话最多保留的片段数 */
const MAX_HITS_PER_SESSION = 3;
/** 片段上下文长度（前后各 40 字） */
const SNIPPET_CONTEXT = 40;
/** trigram 分词器要求的最短查询长度 */
const TRIGRAM_MIN = 3;

const PROFILE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const INDEX_DIR = process.env.ELENVA_SEARCH_INDEX_DIR || join(homedir(), ".elenva");
const INDEX_DB_PATH = join(INDEX_DIR, "search-index.db");

/** profile → Hermes state.db（default 在 ~/.hermes 根上，其余在 profiles/ 下） */
function hermesStateDb(profile) {
  if (!PROFILE_RE.test(profile)) return null;
  const root = join(homedir(), ".hermes");
  const dir = profile === "default" ? root : join(root, "profiles", profile);
  const dbPath = join(dir, "state.db");
  return existsSync(dbPath) ? dbPath : null;
}

function openIndexDb() {
  if (!existsSync(INDEX_DIR)) mkdirSync(INDEX_DIR, { recursive: true });
  const db = new DatabaseSync(INDEX_DB_PATH);
  db.exec(`pragma journal_mode = wal; pragma synchronous = normal;`);
  db.exec(`
    create table if not exists docs(
      id integer primary key,
      profile text not null,
      session_id text not null,
      ts real not null default 0,
      role text not null default '',
      content text not null default ''
    );
    create index if not exists idx_docs_profile_session on docs(profile, session_id);
    create virtual table if not exists messages_fts using fts5(
      content,
      content='docs',
      content_rowid='id',
      tokenize="trigram"
    );
    create table if not exists meta(
      profile text primary key,
      last_rowid integer not null default 0,
      updated_at real not null default 0
    );
  `);
  return db;
}

/** 增量同步：把 state.db 里 rowid > 水位 的消息补进索引。返回进度与是否还有剩余。 */
function syncProfile(indexDb, profile, softDeadline) {
  const started = Date.now();
  const dbPath = hermesStateDb(profile);
  if (!dbPath) return { exists: false, inserted: 0, pending: 0, syncMs: Date.now() - started };

  let src;
  try {
    src = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return { exists: false, inserted: 0, pending: 0, syncMs: Date.now() - started };
  }

  try {
    const totalRow = src.prepare(`select coalesce(max(rowid), 0) m from messages`).get();
    const total = Number(totalRow?.m ?? 0);
    let wm = Number(indexDb.prepare(`select last_rowid from meta where profile = ?`).get(profile)?.last_rowid ?? 0);
    let inserted = 0;
    let pending = Math.max(0, total - wm);

    const pull = src.prepare(
      // 注意：messages.id 本身就是 rowid 的别名（INTEGER PRIMARY KEY），node:sqlite
      // 会把 select rowid 返回成键名 `id` —— 显式取别名 rid，别直接读 row.rowid
      `select rowid as rid, session_id, timestamp, role, content from messages
        where rowid > ? and rowid <= ? and content is not null
        order by rowid limit ?`,
    );

    while (wm < total) {
      if (Date.now() >= softDeadline) break; // 软死线：批间让位，进度已提交不丢
      const batchEnd = Math.min(total, wm + SYNC_BATCH);
      const rows = pull.all(wm, batchEnd, SYNC_BATCH);
      if (rows.length === 0) {
        wm = batchEnd;
        pending = Math.max(0, total - wm);
        continue;
      }
      indexDb.exec(`begin immediate`);
      let lastProcessedRid = null;
      let midBatchStop = false;
      try {
        const insDoc = indexDb.prepare(
          `insert into docs(profile, session_id, ts, role, content) values(?, ?, ?, ?, ?)`,
        );
        const insFts = indexDb.prepare(`insert into messages_fts(rowid, content) values(?, ?)`);
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          // 软死线检查下沉到**每行**：重行（32K 字符）单行 trigram 索引能拖 ~50ms，
          // 20 行一组实测能超软死线 500ms+（P4d）—— Date.now() 每行的开销可忽略
          if (i > 0 && Date.now() >= softDeadline) {
            midBatchStop = true;
            break;
          }
          lastProcessedRid = row.rid;
          const content = String(row.content ?? "");
          if (!content.trim()) continue;
          const capped = content.length > MAX_CONTENT_CHARS ? content.slice(0, MAX_CONTENT_CHARS) : content;
          const info = insDoc.run(profile, String(row.session_id ?? ""), Number(row.timestamp ?? 0), String(row.role ?? ""), capped);
          insFts.run(Number(info.lastInsertRowid), capped);
          inserted++;
        }
        indexDb.exec(`commit`);
      } catch (e) {
        try { indexDb.exec(`rollback`); } catch { /* ignore */ }
        throw e;
      }
      // 水位 = 本批实际处理到的行（中途让位时只记已处理的，未处理的重拉无害）
      wm = midBatchStop && lastProcessedRid !== null ? lastProcessedRid : rows[rows.length - 1].rid;
      if (midBatchStop) break;
      wm = rows[rows.length - 1].rid;
      try {
        indexDb.prepare(
          `insert into meta(profile, last_rowid, updated_at) values(?, ?, ?)
            on conflict(profile) do update set last_rowid = excluded.last_rowid, updated_at = excluded.updated_at`,
        ).run(profile, wm, Date.now() / 1000);
      } catch (e) {
        console.error("meta bind fail: profile=", typeof profile, profile, "wm=", typeof wm, String(wm), "err=", e.message);
        throw e;
      }
      pending = Math.max(0, total - wm);
      if (midBatchStop) break;
    }

    return { exists: true, inserted, pending, total, syncMs: Date.now() - started };
  } finally {
    try { src.close(); } catch { /* ignore */ }
  }
}

/** 片段：关键词前后上下文，换行折空格 */
function snippetAround(text, lowerIdx, needleLen) {
  const start = Math.max(0, lowerIdx - SNIPPET_CONTEXT);
  const end = Math.min(text.length, lowerIdx + needleLen + SNIPPET_CONTEXT);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** 组装结果：命中行 → 每会话计数 + 至多 3 段片段 */
function groupHits(rows, q, partial) {
  const lower = q.toLowerCase();
  const bySession = new Map();
  for (const row of rows) {
    const sid = String(row.session_id ?? "");
    let agg = bySession.get(sid);
    if (!agg) {
      agg = { sessionId: sid, title: null, count: 0, hits: [], ts: Number(row.ts ?? 0) };
      bySession.set(sid, agg);
    }
    agg.count++;
    if (agg.hits.length < MAX_HITS_PER_SESSION) {
      const content = String(row.content ?? row.snip ?? "");
      const idx = content.toLowerCase().indexOf(lower);
      if (idx >= 0) agg.hits.push({ text: snippetAround(content, idx, q.length) });
    }
  }
  const results = [...bySession.values()].slice(0, MAX_SESSIONS);
  // 按最近活跃优先（ts 大→小；检索排序另有 bm25，但侧栏展示跟会话列表一致更顺）
  results.sort((a, b) => b.ts - a.ts);
  for (const r of results) delete r.ts;
  return { results, truncated: partial };
}

/** 查询：≥3 字走 FTS5 MATCH（bm25 排序），更短走 docs 表 LIKE（迭代式，软死线可停） */
function searchProfile(indexDb, profile, q, softDeadline) {
  const started = Date.now();
  if (q.length >= TRIGRAM_MIN) {
    // 短语查询：引号包住，内部引号翻倍转义，避免命中 MATCH 语法
    const phrase = `"${q.replace(/"/g, '""')}"`;
    // 查询计划器实测坑（P4d）：直接 join docs 会被翻成 docs 全表扫描驱动、逐行探测
    // MATCH（24k 行 ≈ 9.5s）。必须让 FTS 子查询作驱动：先 MATCH 拿 rowid+bm25，
    // 再按 id 回 docs 取正文（IN 分批）。实测 2-6ms。
    const ftsRows = indexDb
      .prepare(
        `select rowid, bm25(messages_fts) score
          from messages_fts where messages_fts match ?
          order by score limit ${MAX_MATCH_ROWS}`,
      )
      .all(phrase);
    const partial = ftsRows.length >= MAX_MATCH_ROWS;
    const scoreOf = new Map(ftsRows.map((r) => [Number(r.rowid), Number(r.score)]));
    const rows = [];
    const ids = [...scoreOf.keys()];
    for (let i = 0; i < ids.length; i += 800) {
      const chunk = ids.slice(i, i + 800);
      const docRows = indexDb
        .prepare(
          `select id, session_id, ts, content from docs
            where profile = ? and id in (${chunk.map(() => "?").join(",")})`,
        )
        .all(profile, ...chunk);
      for (const r of docRows) rows.push({ session_id: r.session_id, ts: r.ts, content: r.content });
    }
    return { ...groupHits(rows, q, partial), queryMs: Date.now() - started, mode: "fts" };
  }

  // <3 字：LIKE 兜底（iterate 逐行吐，配合软死线可中途停）
  const like = `%${escapeLike(q)}%`;
  const rows = [];
  let partial = false;
  let n = 0;
  for (const row of indexDb
    .prepare(
      `select session_id, ts, content from docs
        where profile = ? and content like ? escape '\\'
        order by id desc`,
    )
    .iterate(profile, like)) {
    if (n >= MAX_MATCH_ROWS) { partial = true; break; }
    if (++n % 256 === 0 && Date.now() >= softDeadline) { partial = true; break; }
    rows.push(row);
  }
  return { ...groupHits(rows, q, partial), queryMs: Date.now() - started, mode: "like" };
}

/** 标题：只查命中的 session id（小查询） */
function fillTitles(indexDb, profile, results) {
  if (results.length === 0) return;
  const dbPath = hermesStateDb(profile);
  if (!dbPath) return;
  let src;
  try {
    src = new DatabaseSync(dbPath, { readOnly: true });
    const st = src.prepare(`select title from sessions where id = ?`);
    for (const r of results) {
      try {
        const row = st.get(r.sessionId);
        r.title = row?.title || null;
      } catch { /* 单条失败不拖垮 */ }
    }
  } catch { /* 打不开就无标题 */ }
  finally {
    try { src?.close(); } catch { /* ignore */ }
  }
}

/** 处理一条消息（search / reindex），回结果给主线程 */
async function handleMessage(msg) {
  const token = msg.token;
  const profile = PROFILE_RE.test(String(msg.profile ?? "")) ? String(msg.profile) : "default";
  try {
    const indexDb = openIndexDb();
    try {
      if (msg.type === "reindex") {
        const t0 = Date.now();
        // 清掉该 profile 的行 → 让 FTS 从 docs 全量重建 → 水位归零重新同步
        indexDb.prepare(`delete from docs where profile = ?`).run(profile);
        indexDb.prepare(`insert into messages_fts(messages_fts) values('rebuild')`).run();
        indexDb.prepare(`delete from meta where profile = ?`).run(profile);
        const sync = syncProfile(indexDb, profile, Number.POSITIVE_INFINITY); // 重建是显式动作，不限 2s
        const docCount = Number(indexDb.prepare(`select count(*) c from docs where profile = ?`).get(profile)?.c ?? 0);
        const indexBytes = statSync(INDEX_DB_PATH).size + (existsSync(INDEX_DB_PATH + "-wal") ? statSync(INDEX_DB_PATH + "-wal").size : 0);
        return parentPort?.postMessage({
          token, ok: true, reindexed: true,
          stats: { docs: docCount, bytes: indexBytes, syncMs: Date.now() - t0, inserted: sync.inserted, pending: sync.pending },
        });
      }

      // search：先增量同步（软死线内），再查
      const q = String(msg.q ?? "").trim();
      const softDeadline = Number(msg.softDeadlineMs ?? Date.now() + 1_500);
      if (!q) {
        return parentPort?.postMessage({ token, ok: true, results: [], truncated: false, stats: { pending: 0 } });
      }
      const sync = syncProfile(indexDb, profile, softDeadline);
      if (!sync.exists) {
        return parentPort?.postMessage({ token, ok: true, results: [], truncated: false, stats: { pending: 0, missing: true } });
      }
      const res = searchProfile(indexDb, profile, q, softDeadline);
      fillTitles(indexDb, profile, res.results);
      // 索引还没追上（首次全量/增量未完成）→ 结果可信但不全，按 truncated 提示
      const pending = Number(sync.pending ?? 0);
      return parentPort?.postMessage({
        token, ok: true,
        results: res.results,
        truncated: res.truncated || pending > 0,
        stats: {
          pending,
          total: Number(sync.total ?? 0),
          inserted: sync.inserted,
          syncMs: sync.syncMs,
          queryMs: res.queryMs,
          mode: res.mode,
        },
      });
    } finally {
      try { indexDb.close(); } catch { /* ignore */ }
    }
  } catch (error) {
    return parentPort?.postMessage({ token, ok: false, error: String(error), stack: error?.stack, results: [], truncated: true });
  }
}

if (parentPort) {
  parentPort.on("message", (msg) => { void handleMessage(msg); });
}
