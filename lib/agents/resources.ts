/**
 * Hermes 侧资源读取（仅服务端）—— 会话 / 记忆 / 技能。
 *
 * 为什么要有这一层：ELENVA 原来的会话、记忆、技能页全按 pi 的路径写死
 * （`~/.pi/agent/...`）。而应用包 Agent 跑在 Hermes 上，数据在
 * `~/.hermes/profiles/<profile>/`：会话在 state.db（sqlite），记忆是
 * `memories/*.md`，技能是 `skills/<类>/<名>/SKILL.md`。同一个页面要读两套后端，
 * 就在这里按 runtime 分流。
 *
 * 边界：只读；profile 名只接受 `[a-z0-9-]`；所有路径先 resolve 再判是否落在 profile 目录内。
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { hermesHome } from "../hermes-home";
import { sessionActivityExpr, tableColumns } from "../hermes-db";
import { isInsideDir } from "./data-store";

const PROFILE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_MESSAGES = 200;
const MAX_ENTRIES = 60;

export interface HermesSession {
  id: string;
  title: string;
  source: string;
  startedAt: string;
  lastActivityAt: string;
  messageCount: number;
  model?: string;
  /** 会话工作目录（P2 统一索引用）；state.db 里可为 null，调用方自行兑底 */
  cwd?: string | null;
  /** 累计用量（state.db 的 sessions 表；观测栏 sessionStats 的真源） */
  inputTokens?: number;
  outputTokens?: number;
  toolCallCount?: number;
}

export interface HermesSessionStats {
  sessionId: string;
  title?: string;
  cwd?: string | null;
  startedAt?: string;
  messageCount: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** 估算成本（USD，state.db 的 estimated_cost_usd；没有就是 0，不编） */
  costUsd: number;
}

export interface HermesToolCall {
  id: string;
  toolName: string;
  /** assistant.tool_calls.function.arguments 的 JSON 字符串（可解析失败，原样给出） */
  input?: string;
  /** role='tool' 那一行的结果文本（抳平后） */
  output?: string;
  isError?: boolean;
  at: string;
}

export interface HermesMessage {
  role: string;
  text: string;
  toolName?: string;
  /** assistant 行拼出的工具调用序列（与 role='tool' 结果按 tool_call_id 配对） */
  toolCalls?: HermesToolCall[];
  at: string;
}

export interface MemoryEntry {
  id: string;
  text: string;
}

export interface HermesSkill {
  name: string;
  description: string;
  category: string;
  path: string;
}

/**
 * 加载 Node 内置 sqlite。
 *
 * 直接 `import("node:sqlite")` 会被 Next 的 webpack 当成普通依赖去解析，报
 * 「Unsupported external type Url for commonjs reference」。加 webpackIgnore
 * 让它保持运行时原生导入（Node ≥22 内置，不引原生依赖）。
 */
async function loadSqlite(): Promise<typeof import("node:sqlite")> {
  return (await import(/* webpackIgnore: true */ "node:sqlite")) as typeof import("node:sqlite");
}

export function hermesProfileDir(profile: string): string | null {
  if (!PROFILE_RE.test(profile)) return null;
  const root = hermesHome();
  // default 不是 profiles/ 下的子目录，它就在 ~/.hermes 根上（SOUL/memories/skills/state.db 都在那）
  const dir = profile === "default" ? resolve(root) : resolve(root, "profiles", profile);
  return existsSync(dir) ? dir : null;
}

function isoFromUnix(seconds: unknown): string {
  const value = Number(seconds);
  return Number.isFinite(value) && value > 0 ? new Date(value * 1000).toISOString() : "";
}

/** 会话列表（Hermes：state.db 的 sessions 表）。 */
export async function listHermesSessions(profile: string, limit = 40): Promise<HermesSession[]> {
  const dir = hermesProfileDir(profile);
  if (!dir) return [];
  const dbPath = join(dir, "state.db");
  if (!existsSync(dbPath)) return [];

  // node:sqlite 是内置的（不引原生依赖）；只读打开，不碰 Hermes 的运行数据
  const { DatabaseSync } = await loadSqlite();
  let db: import("node:sqlite").DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    // Hermes v0.19 起 sessions 表没有 last_activity_at —— 表达式按实际列名选（lib/hermes-db.ts）
    const activity = sessionActivityExpr(tableColumns(db, "sessions"));
    const rows = db
      .prepare(
        `select id, title, source, cwd, started_at, ${activity} as last_activity_at, message_count, model,
                input_tokens, output_tokens, tool_call_count
           from sessions
          where coalesce(archived, 0) = 0
            and coalesce(message_count, 0) > 0
          order by ${activity} desc
          limit ?`,
      )
      .all(limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id ?? ""),
      title: String(row.title ?? "") || "(无标题)",
      source: String(row.source ?? ""),
      startedAt: isoFromUnix(row.started_at),
      lastActivityAt: isoFromUnix(row.last_activity_at ?? row.started_at),
      messageCount: Number(row.message_count ?? 0),
      model: row.model ? String(row.model) : undefined,
      cwd: row.cwd ? String(row.cwd) : null,
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
      toolCallCount: Number(row.tool_call_count ?? 0),
    }));
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      /* 关不掉不影响读取结果 */
    }
  }
}

/**
 * 按 cwd 找该应用包最近的会话。
 *
 * 识别口径是 cwd（不是 source：ACP 探针建的空会话 source='acp'、message_count=0，
 * 真实会话 source='local' 且 cwd=应用包目录），并忽略 message_count=0 的空会话。
 */
export async function findLatestHermesSessionByCwd(
  profile: string,
  cwd: string,
): Promise<HermesSession | null> {
  const dir = hermesProfileDir(profile);
  if (!dir || !cwd) return null;
  const dbPath = join(dir, "state.db");
  if (!existsSync(dbPath)) return null;

  const { DatabaseSync } = await loadSqlite();
  let db: import("node:sqlite").DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const activity = sessionActivityExpr(tableColumns(db, "sessions"));
    const rows = db
      .prepare(
        `select id, title, source, started_at, ${activity} as last_activity_at, message_count, model
           from sessions
          where cwd = ?
            and coalesce(archived, 0) = 0
            and coalesce(message_count, 0) > 0
          order by ${activity} desc
          limit 1`,
      )
      .all(cwd) as Record<string, unknown>[];
    const row = rows[0];
    if (!row) return null;
    return {
      id: String(row.id ?? ""),
      title: String(row.title ?? "") || "(无标题)",
      source: String(row.source ?? ""),
      startedAt: isoFromUnix(row.started_at),
      lastActivityAt: isoFromUnix(row.last_activity_at ?? row.started_at),
      messageCount: Number(row.message_count ?? 0),
      model: row.model ? String(row.model) : undefined,
    };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* 关不掉不影响读取结果 */
    }
  }
}

/**
 * 单会话统计（P2 观测栏真源）：state.db 的 sessions 表一行 —— token / 工具次数 / 开始时间。
 * 找不到会话（id 不存在 / db 缺失）返回 null，不编造。
 */
export async function readHermesSessionStats(profile: string, sessionId: string): Promise<HermesSessionStats | null> {
  if (!sessionId) return null;
  const dir = hermesProfileDir(profile);
  if (!dir) return null;
  const dbPath = join(dir, "state.db");
  if (!existsSync(dbPath)) return null;
  const { DatabaseSync } = await loadSqlite();
  let db: import("node:sqlite").DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare(
        `select id, title, cwd, started_at, message_count, tool_call_count,
                input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                estimated_cost_usd
           from sessions
          where id = ?`,
      )
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      sessionId: String(row.id ?? sessionId),
      title: row.title ? String(row.title) : undefined,
      cwd: row.cwd ? String(row.cwd) : null,
      startedAt: isoFromUnix(row.started_at) || undefined,
      messageCount: Number(row.message_count ?? 0),
      toolCallCount: Number(row.tool_call_count ?? 0),
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
      cacheReadTokens: Number(row.cache_read_tokens ?? 0),
      cacheWriteTokens: Number(row.cache_write_tokens ?? 0),
      costUsd: Number(row.estimated_cost_usd ?? 0),
    };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* 关不掉不影响读取结果 */
    }
  }
}

/** 单个会话的消息（只读、截断，避免一次拉太多）；assistant.tool_calls 与 role='tool' 结果拼成工具调用序列。 */
export async function readHermesMessages(profile: string, sessionId: string, limit = MAX_MESSAGES): Promise<HermesMessage[]> {
  const dir = hermesProfileDir(profile);
  if (!dir || !/^[A-Za-z0-9._-]{1,200}$/.test(sessionId)) return [];
  const dbPath = join(dir, "state.db");
  if (!existsSync(dbPath)) return [];

  const { DatabaseSync } = await loadSqlite();
  let db: import("node:sqlite").DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare(
        `select role, content, tool_call_id, tool_calls, tool_name, timestamp
           from messages
          where session_id = ?
          order by id
          limit ?`,
      )
      .all(sessionId, limit) as Record<string, unknown>[];

    const messages: HermesMessage[] = [];
    for (const row of rows) {
      const role = String(row.role ?? "");
      const at = isoFromUnix(row.timestamp);
      if (role === "assistant") {
        // tool_calls 是 JSON 数组：[{ id, function: { name, arguments } }]
        const toolCalls: HermesToolCall[] = [];
        const rawCalls = typeof row.tool_calls === "string" ? row.tool_calls : "";
        if (rawCalls) {
          try {
            const parsed = JSON.parse(rawCalls) as unknown;
            if (Array.isArray(parsed)) {
              for (const call of parsed) {
                const entry = call as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
                const id = entry?.id ? String(entry.id) : "";
                const name = entry?.function?.name ? String(entry.function.name) : "";
                if (!id && !name) continue;
                toolCalls.push({
                  id: id || `call-${toolCalls.length}`,
                  toolName: name,
                  input: entry?.function?.arguments ? String(entry.function.arguments) : undefined,
                  at,
                });
              }
            }
          } catch {
            /* 坏 JSON 不拦整条消息 */
          }
        }
        messages.push({
          role,
          text: String(row.content ?? "").slice(0, 4000),
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
          at,
        });
        continue;
      }
      if (role === "tool") {
        // 结果行：按 tool_call_id 挂回最近的 assistant 消息
        const callId = row.tool_call_id ? String(row.tool_call_id) : "";
        for (let i = messages.length - 1; i >= 0; i--) {
          const target = messages[i];
          const call = target.toolCalls?.find((item) => item.id === callId && item.output === undefined);
          if (!call) continue;
          call.output = String(row.content ?? "").slice(0, 4000);
          // Hermes 的结果体形如 {"status":"success","output":"..."}；能解析就取 output 并记错误态
          try {
            const parsed = JSON.parse(call.output) as { status?: unknown; output?: unknown };
            if (typeof parsed?.output === "string") call.output = parsed.output.slice(0, 4000);
            if (typeof parsed?.status === "string") call.isError = parsed.status !== "success";
          } catch {
            /* 非 JSON 结果原样保留 */
          }
          break;
        }
        continue;
      }
      messages.push({
        role,
        text: String(row.content ?? "").slice(0, 4000),
        toolName: row.tool_name ? String(row.tool_name) : undefined,
        at,
      });
    }
    return messages;
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      /* 同上 */
    }
  }
}

/** 记忆：memories/MEMORY.md 与 USER.md，按 `§` 切条目。 */
export function readHermesMemories(profile: string): { name: string; entries: MemoryEntry[]; bytes: number }[] {
  const dir = hermesProfileDir(profile);
  if (!dir) return [];
  const out: { name: string; entries: MemoryEntry[]; bytes: number }[] = [];
  for (const name of ["MEMORY.md", "USER.md"]) {
    const file = resolve(join(dir, "memories", name));
    if (!isInsideDir(dir, file) || !existsSync(file)) continue;
    try {
      const raw = readFileSync(file, "utf8");
      const entries = raw
        .split("§")
        .map((text) => text.trim())
        .filter(Boolean)
        .slice(0, MAX_ENTRIES)
        .map((text, index) => ({ id: `${name}#${index}`, text }));
      out.push({ name, entries, bytes: statSync(file).size });
    } catch {
      /* 单个文件读不到不影响另一个 */
    }
  }
  return out;
}

function parseFrontmatter(text: string): { name?: string; description?: string } {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!match) return {};
  const fields: { name?: string; description?: string } = {};
  for (const line of match[1].split("\n")) {
    const m = /^(name|description):\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    fields[m[1] as "name" | "description"] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return fields;
}

/** 技能：skills/<类>/<名>/SKILL.md（也兼容 skills/<名>/SKILL.md）。 */
export function listHermesSkills(profile: string): HermesSkill[] {
  const dir = hermesProfileDir(profile);
  if (!dir) return [];
  const root = resolve(join(dir, "skills"));
  if (!isInsideDir(dir, root) || !existsSync(root)) return [];

  const skills: HermesSkill[] = [];
  const collect = (file: string, category: string) => {
    try {
      const text = readFileSync(file, "utf8").slice(0, 8000);
      const fm = parseFrontmatter(text);
      skills.push({
        name: fm.name || file.split("/").slice(-2, -1)[0] || "?",
        description: fm.description || "",
        category,
        path: relative(dir, resolve(file)).split("\\").join("/"),
      });
    } catch {
      /* 坏文件跳过 */
    }
  };

  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const first = join(root, entry.name);
      const direct = join(first, "SKILL.md");
      if (existsSync(direct)) {
        collect(direct, "");
        continue;
      }
      try {
        for (const child of readdirSync(first, { withFileTypes: true })) {
          if (!child.isDirectory() || child.name.startsWith(".")) continue;
          const file = join(first, child.name, "SKILL.md");
          if (existsSync(file)) collect(file, entry.name);
        }
      } catch {
        /* 这个分类读不到就跳过 */
      }
    }
  } catch {
    return [];
  }

  return skills.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

/* ---------------- 身份（SOUL.md）与节律（cron）、成长（用量） ---------------- */

const MAX_SOUL_BYTES = 64 * 1024;

export interface SoulDoc {
  path: string;
  content: string;
  bytes: number;
  modifiedAt: string;
}

/** 读这个 Agent 的身份文件（SOUL.md）。改它就是改它的行为基线。 */
export function readSoul(profile: string): SoulDoc | null {
  const dir = hermesProfileDir(profile);
  if (!dir) return null;
  const file = resolve(join(dir, "SOUL.md"));
  if (!isInsideDir(dir, file) || !existsSync(file)) return null;
  try {
    const content = readFileSync(file, "utf8");
    return { path: "SOUL.md", content, bytes: Buffer.byteLength(content, "utf8"), modifiedAt: new Date(statSync(file).mtimeMs).toISOString() };
  } catch {
    return null;
  }
}

/** 写回 SOUL.md：先备份（.bak-ui-<时间>），再原子替换。改完要新会话才生效。 */
export function writeSoul(profile: string, content: string): { ok: true; bytes: number; backup: string } | { ok: false; error: string } {
  const dir = hermesProfileDir(profile);
  if (!dir) return { ok: false, error: "找不到这个 profile 目录" };
  const file = resolve(join(dir, "SOUL.md"));
  if (!isInsideDir(dir, file)) return { ok: false, error: "路径越界" };
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_SOUL_BYTES) return { ok: false, error: `SOUL 超过 ${MAX_SOUL_BYTES / 1024}KB` };
  if (!content.trim()) return { ok: false, error: "SOUL 不能为空" };
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = join(dir, `SOUL.md.bak-ui-${stamp}`);
    if (existsSync(file)) writeFileSync(backup, readFileSync(file, "utf8"), "utf8");
    writeFileSync(file, content, "utf8");
    return { ok: true, bytes, backup: backup.split("/").pop() ?? "" };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  lastStatus?: string;
  profile?: string;
}

/** 节律：Hermes 的 cron 任务表（全局一份，按 profile 字段标注归属）。 */
export function readRhythm(profile: string): CronJob[] {
  const file = resolve(join(hermesHome(), "cron", "jobs.json"));
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    const list = Array.isArray(raw) ? raw : ((raw as { jobs?: unknown[] }).jobs ?? []);
    return (list as Record<string, unknown>[])
      .map((job) => {
        const schedule = job.schedule as Record<string, unknown> | string | undefined;
        const text =
          typeof schedule === "string"
            ? schedule
            : schedule && typeof schedule === "object"
              ? String(schedule.display ?? schedule.expr ?? schedule.kind ?? "")
              : "";
        return {
          id: String(job.id ?? ""),
          name: String(job.name ?? "(未命名)"),
          schedule: text,
          enabled: job.enabled !== false,
          lastStatus: job.last_status ? String(job.last_status) : undefined,
          profile: job.profile ? String(job.profile) : undefined,
        };
      })
      .filter((job) => !job.profile || job.profile === profile);
  } catch {
    return [];
  }
}

export interface UsageSummary {
  sessions: number;
  messages: number;
  inputTokens: number;
  outputTokens: number;
}

/** 成长：这个 profile 的用量汇总（来自 state.db 的 sessions 表）。 */
export async function readUsage(profile: string): Promise<UsageSummary | null> {
  const dir = hermesProfileDir(profile);
  if (!dir) return null;
  const dbPath = join(dir, "state.db");
  if (!existsSync(dbPath)) return null;
  const { DatabaseSync } = await loadSqlite();
  let db: import("node:sqlite").DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare(
        `select count(*) as n, coalesce(sum(message_count),0) as msgs,
                coalesce(sum(input_tokens),0) as inp, coalesce(sum(output_tokens),0) as outp
           from sessions`,
      )
      .get() as Record<string, unknown>;
    return {
      sessions: Number(row.n ?? 0),
      messages: Number(row.msgs ?? 0),
      inputTokens: Number(row.inp ?? 0),
      outputTokens: Number(row.outp ?? 0),
    };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}
