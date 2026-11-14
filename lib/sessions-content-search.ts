/**
 * 会话内容搜索（P4c）—— 从「只搜标题」升级到「搜消息内容」。
 *
 * 两个数据源：
 * - Pi 会话：~/.pi/agent/sessions/<cwd-slug>/*.jsonl，逐行 JSON 解析取 content 文本。
 *   大文件流式读（readline），不整文件进内存；到 2s 死线就停，truncated 标记截断。
 * - Hermes 会话：profile 的 state.db messages 表 LIKE 匹配（node:sqlite 只读连接）。
 *
 * 返回的 sessionId 与统一会话索引（lib/session-index.ts）同 id：
 * - Pi：会话头里的 uuid（侧栏 sessions 列表里的 id 就是它）
 * - Hermes：`hermes:<profile>:<id>`
 *
 * 只读不写；LIKE 有 ESCAPE 转义；整体 2s 死线（调用方传入绝对时刻）。
 */

import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { hermesProfileDir } from "@/lib/agents/resources";

export type ContentHit = {
  /** 命中片段：关键词前后的上下文（前后各 40 字，换行折成空格） */
  text: string;
};

export type ContentSearchResult = {
  /** 与统一会话索引同 id（Pi uuid / hermes:<profile>:<id>） */
  sessionId: string;
  /** Hermes 会话有标题；Pi 会话无标题（界面用侧栏列表里的 name 兑底） */
  title: string | null;
  /** 命中条数（该会话内匹配的消息行数；单会话最多记 3 段片段，但条数照实计） */
  count: number;
  hits: ContentHit[];
};

export type ContentSearchOutcome = {
  results: ContentSearchResult[];
  /** 到死线没扫完 = true（结果可信但可能不全，界面可提示） */
  truncated: boolean;
  elapsedMs: number;
};

/** 单会话最多保留的命中片段数 */
const MAX_HITS_PER_SESSION = 3;
/** 单次搜索最多返回的会话数 */
const MAX_SESSIONS = 50;
/** 片段上下文长度（关键词前后各 40 字） */
const SNIPPET_CONTEXT = 40;
/** Pi jsonl 每隔多少行查一次死线（逐行查太浪费） */
const DEADLINE_CHECK_EVERY = 200;

const PROFILE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** 片段：关键词前后的上下文，换行折空格（片段在侧栏里只有一行高度） */
function snippetAround(text: string, lowerIdx: number, needleLen: number): string {
  const start = Math.max(0, lowerIdx - SNIPPET_CONTEXT);
  const end = Math.min(text.length, lowerIdx + needleLen + SNIPPET_CONTEXT);
  return text
    .slice(start, end)
    .replace(/\s+/g, " ")
    .trim();
}

/** LIKE 的转义：% _ \ 三个字符，配 ESCAPE '\' 使用 */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * 从一条 pi jsonl message 里抽出可搜索文本（text / thinking 块）。
 * system 消息的 sections preamble 每条会话都一样且巨大 —— 跳过，省死线。
 */
function piMessageTexts(entry: Record<string, unknown>): string[] {
  const msg = entry.message as Record<string, unknown> | undefined;
  if (!msg) return [];
  const role = msg.role;
  if (role === "system") return [];
  const content = msg.content;
  const out: string[] = [];
  if (typeof content === "string") {
    if (content.trim()) out.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (typeof b.text === "string" && b.text.trim()) out.push(b.text);
      else if (typeof b.thinking === "string" && b.thinking.trim()) out.push(b.thinking);
    }
  }
  return out;
}

/** Pi 侧：扫所有 cwd-slug 目录下的 jsonl（Elen 是唯一的 pi Agent，无按 cwd 缩小必要） */
async function searchPiSessions(q: string, deadline: number): Promise<ContentSearchOutcome> {
  const started = Date.now();
  const results: ContentSearchResult[] = [];
  let truncated = false;
  const lower = q.toLowerCase();

  const sessionsRoot = join(homedir(), ".pi", "agent", "sessions");
  if (!existsSync(sessionsRoot)) return { results, truncated, elapsedMs: Date.now() - started };

  // 全部 jsonl，按 mtime 新→旧（最近的会话先扫，死线到来时最相关的已经进了）
  const files: { path: string; mtime: number }[] = [];
  let slugs: string[] = [];
  try {
    slugs = readdirSync(sessionsRoot);
  } catch {
    return { results, truncated, elapsedMs: Date.now() - started };
  }
  for (const slug of slugs) {
    const dir = join(sessionsRoot, slug);
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const p = join(dir, name);
      try {
        const mtime = statSync(p).mtimeMs;
        if (Number.isFinite(mtime)) files.push({ path: p, mtime });
      } catch {
        /* stat 失败的文件跳过 */
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);

  for (const file of files) {
    if (Date.now() >= deadline) {
      truncated = true;
      break;
    }
    if (results.length >= MAX_SESSIONS) break;

    // 流式逐行读：大文件也不整读进内存
    const rl = createInterface({ input: createReadStream(file.path, { encoding: "utf8" }), crlfDelay: Infinity });
    let headerSessionId: string | null = null;
    let matchedLines = 0;
    let lineNo = 0;
    const hits: ContentHit[] = [];
    const hitIds = new Set<number>(); // 已留过片段的行号（一行只留一段）
    try {
      for await (const line of rl) {
        lineNo++;
        if (lineNo % DEADLINE_CHECK_EVERY === 0 && Date.now() >= deadline) {
          truncated = true;
          break;
        }
        if (!line.trim()) continue;
        let entry: Record<string, unknown>;
        try {
          entry = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (entry.type === "session") {
          const id = entry.id;
          if (typeof id === "string") headerSessionId = id;
          continue;
        }
        if (entry.type !== "message") continue;
        for (const text of piMessageTexts(entry)) {
          const idx = text.toLowerCase().indexOf(lower);
          if (idx < 0) continue;
          matchedLines++;
          if (hits.length < MAX_HITS_PER_SESSION && !hitIds.has(lineNo)) {
            hitIds.add(lineNo);
            hits.push({ text: snippetAround(text, idx, q.length) });
          }
        }
      }
    } catch {
      /* 读到坏块/文件消失：该会话按已有进度计 */
    } finally {
      rl.close();
    }
    if (matchedLines > 0 && headerSessionId) {
      results.push({ sessionId: headerSessionId, title: null, count: matchedLines, hits });
    }
  }

  results.sort((a, b) => b.count - a.count);
  return { results, truncated, elapsedMs: Date.now() - started };
}

/** Hermes 侧：profile 的 state.db messages 表 LIKE（node:sqlite 只读连接） */
async function searchHermesSessions(
  q: string,
  profile: string,
  deadline: number,
): Promise<ContentSearchOutcome> {
  const started = Date.now();
  const results: ContentSearchResult[] = [];
  let truncated = false;
  const { DatabaseSync } = await import("node:sqlite");

  const dir = hermesProfileDir(profile);
  const dbPath = dir ? join(dir, "state.db") : null;
  if (!dbPath || !existsSync(dbPath)) return { results, truncated, elapsedMs: Date.now() - started };

  let db: import("node:sqlite").DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const like = `%${escapeLike(q)}%`;

    // 实测（2026-11-13）：default profile 的 messages 表上 `LIKE + group by + join sessions`
    // 全表物化要 9s+；而普通 LIKE 全扫 + iterate 只要 ~250ms，且能在循环内查死线中途断掉。
    // 所以：iterate 增量扫，顺手累计每会话命中条数；超出死线直接 break（truncated）。
    const counts = new Map<string, number>();
    for (const row of db
      .prepare(
        `select session_id from messages where content like ? escape '\\'`,
      )
      .iterate(like) as IterableIterator<{ session_id: string }>) {
      counts.set(row.session_id, (counts.get(row.session_id) ?? 0) + 1);
      if (Date.now() >= deadline) {
        truncated = true;
        break;
      }
    }

    // 标题 + 最近活跃：只查命中的 id（主键级小查询，不再 join 大表）
    const ids = [...counts.keys()];
    let titleOf = new Map<string, string | null>();
    let lastActivityOf = new Map<string, string>();
    if (ids.length > 0) {
      const sessRows = db
        .prepare(
          `select id, title, last_activity_at from sessions
            where id in (${ids.map(() => "?").join(",")})`,
        )
        .all(...ids) as { id: string; title: string | null; last_activity_at: string | number | null }[];
      for (const r of sessRows) {
        titleOf.set(r.id, r.title || null);
        lastActivityOf.set(r.id, String(r.last_activity_at ?? ""));
      }
    }

    // 最近活跃优先，最多 50 会话；每会话取至多 3 段片段（小查询，逐条查死线）
    const ordered = ids
      .sort((a, b) => (lastActivityOf.get(b) ?? "").localeCompare(lastActivityOf.get(a) ?? ""))
      .slice(0, MAX_SESSIONS);
    for (const sid of ordered) {
      if (Date.now() >= deadline) {
        truncated = true;
        break;
      }
      const hitRows = db
        .prepare(
          `select content from messages
            where session_id = ? and content like ? escape '\\'
            limit ${MAX_HITS_PER_SESSION}`,
        )
        .all(sid, like) as { content: string }[];
      const hits: ContentHit[] = [];
      for (const { content } of hitRows) {
        if (!content) continue;
        const idx = content.toLowerCase().indexOf(q.toLowerCase());
        if (idx >= 0) hits.push({ text: snippetAround(content, idx, q.length) });
      }
      results.push({
        sessionId: `hermes:${profile}:${sid}`,
        title: titleOf.get(sid) ?? null,
        count: counts.get(sid) ?? 0,
        hits,
      });
    }
  } catch {
    /* 库损坏/被锁：返回空结果（搜索故障不该拖垮侧栏） */
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }

  return { results, truncated, elapsedMs: Date.now() - started };
}

export async function searchSessionContent(opts: {
  q: string;
  runtime?: "pi" | "hermes";
  profile?: string;
  deadlineMs: number;
}): Promise<ContentSearchOutcome> {
  const started = Date.now();
  const q = opts.q.trim();
  if (!q) return { results: [], truncated: false, elapsedMs: 0 };

  // profile 给了就是 Hermes 视角（切换 Agent 时范围跟着变）；否则搜 Pi 会话
  const runtime = opts.runtime ?? (opts.profile ? "hermes" : "pi");
  if (runtime === "hermes") {
    const profile = opts.profile && PROFILE_RE.test(opts.profile) ? opts.profile : "default";
    return await searchHermesSessions(q, profile, opts.deadlineMs);
  }
  return await searchPiSessions(q, opts.deadlineMs);
}
