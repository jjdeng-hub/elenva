/**
 * Hermes profile 发现层（只读）—— 「Agent 与 Profile」名册的数据源。
 *
 * 设计约束（见 docs/specs/2026-11-12-profile-management.md 一、二节）：
 * - **只读**：不碰 Hermes 的任何文件；会话数来自 state.db 的一条聚合查询，
 *   绝不 `select *`
 * - 发现 ≠ 接入：未接入的 profile 只是名册里的一行，不参与侧栏 Agent 切换
 * - 结果缓存 5 秒，避免名册每次渲染都扫盘 + 开 SQLite
 * - node:sqlite 用 `import(/* webpackIgnore * /)` 动态加载（同 lib/agents/resources.ts），
 *   不引原生依赖
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentsRoot, listAgents } from "./agents/registry";

export const PROFILE_ID_RE = /^[a-z][a-z0-9-]{1,30}$/;
const CACHE_TTL_MS = 5_000;

export interface ProfileEntry {
  /** profile id（目录名；default 是 ~/.hermes 本身） */
  id: string;
  /** 是否可用：目录里有 config.yaml */
  available: boolean;
  /** 展示名：已接入包的 manifest.name > SOUL.md 首个标题 > profile id */
  displayName: string;
  /** config.yaml 的 model.default（读不到为 null） */
  model: string | null;
  /** state.db sessions 条数（读不到为 null） */
  sessionCount: number | null;
  /** state.db max(coalesce(last_activity_at, started_at))，Unix 秒（读不到为 null） */
  lastActiveAt: number | null;
  /** 是否已接入 ELENVA：~/.elenva/agents/ 下有 profile == 该 id 的应用包 */
  connected: boolean;
}

interface Cache {
  at: number;
  entries: ProfileEntry[];
}
let cache: Cache | null = null;

function hermesRoot(): string {
  const override = process.env.HERMES_HOME?.trim();
  return override || path.join(os.homedir(), ".hermes");
}

function elenvaAgentsRoot(): string {
  return agentsRoot();
}

/** SOUL.md 首个标题里取名字：「# SOUL - Rig (Builder)」→「Rig」。 */
function nameFromSoulHeader(line: string): string | null {
  const match = /^#\s*SOUL\s*(?:[-—–]+\s*)?(.+)$/.exec(line.trim());
  if (!match) return null;
  // 去掉末尾括号补充（中英文括号都算）
  const name = match[1].replace(/[(（][^)）]*[)）]\s*$/, "").trim();
  return name || null;
}

/** 从 config.yaml 抠 model.default —— 只按行匹配，不引 YAML 依赖。 */
function modelFromConfig(text: string): string | null {
  const lines = text.split(/\r?\n/);
  let inModel = false;
  for (const line of lines) {
    if (/^model:\s*$/.test(line)) {
      inModel = true;
      continue;
    }
    if (inModel) {
      // model 块到下一个顶层键为止
      if (/^[^\s#][^:]*:/.test(line)) break;
      const value = /^ {2}default:\s*(\S+)/.exec(line);
      if (value) return value[1];
    }
  }
  return null;
}

/** 只读打开 state.db 跑一条聚合查询；任何失败都降级为 null，不抛给调用方。 */
async function sessionStats(dbPath: string): Promise<{ sessionCount: number | null; lastActiveAt: number | null }> {
  try {
    const { DatabaseSync } = (await import(/* webpackIgnore: true */ "node:sqlite")) as typeof import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("select count(*) as n, max(coalesce(last_activity_at, started_at)) as m from sessions").get() as
        | { n: number | bigint; m: number | null }
        | undefined;
      return {
        sessionCount: row ? Number(row.n) : null,
        lastActiveAt: row && row.m != null ? Number(row.m) : null,
      };
    } finally {
      db.close();
    }
  } catch {
    return { sessionCount: null, lastActiveAt: null };
  }
}

function readDisplayName(profileDir: string, profileId: string): string {
  // 已接入的包：manifest.name 最优先（Tom / 内容创作 / 装修都来自这里）
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(elenvaAgentsRoot(), profileId, "manifest.json"), "utf8"),
    ) as { profile?: unknown; name?: unknown };
    if (manifest.profile === profileId && typeof manifest.name === "string" && manifest.name.trim()) {
      return manifest.name.trim();
    }
  } catch {
    /* 未接入或读不了，落回 SOUL.md */
  }
  try {
    const soul = fs.readFileSync(path.join(profileDir, "SOUL.md"), "utf8");
    for (const line of soul.split(/\r?\n/)) {
      const name = nameFromSoulHeader(line);
      if (name) return name;
    }
  } catch {
    /* 没有 SOUL.md 或读不了，落回 profile id */
  }
  return profileId;
}

async function inspectProfile(profileId: string, profileDir: string): Promise<ProfileEntry> {
  const available = fs.existsSync(path.join(profileDir, "config.yaml"));

  let model: string | null = null;
  if (available) {
    try {
      model = modelFromConfig(fs.readFileSync(path.join(profileDir, "config.yaml"), "utf8"));
    } catch {
      /* config 读不了，model 留空 */
    }
  }

  const dbPath = path.join(profileDir, "state.db");
  const stats = fs.existsSync(dbPath) ? await sessionStats(dbPath) : { sessionCount: null, lastActiveAt: null };

  return {
    id: profileId,
    available,
    displayName: readDisplayName(profileDir, profileId),
    model,
    sessionCount: stats.sessionCount,
    lastActiveAt: stats.lastActiveAt,
    connected: false, // 由 discoverProfiles 统一填
  };
}

/**
 * 发现全部 Hermes profile：`~/.hermes`（default）与 `~/.hermes/profiles/*`。
 * 只读；结果缓存 5 秒。
 */
export async function discoverProfiles(): Promise<ProfileEntry[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.entries;

  const root = hermesRoot();
  const candidates: Array<{ id: string; dir: string }> = [
    { id: "default", dir: root },
    { id: "", dir: path.join(root, "profiles") },
  ];
  const list: Array<{ id: string; dir: string }> = [];
  for (const candidate of candidates) {
    if (!candidate.id) {
      // 命名 profile：profiles/ 下每个子目录
      try {
        for (const entry of fs.readdirSync(candidate.dir, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
          list.push({ id: entry.name, dir: path.join(candidate.dir, entry.name) });
        }
      } catch {
        /* profiles/ 不存在，跳过 */
      }
    } else if (fs.existsSync(path.join(candidate.dir, "config.yaml"))) {
      list.push(candidate);
    }
  }

  const entries = await Promise.all(list.map((item) => inspectProfile(item.id, item.dir)));

  // connected：扫一次应用包目录，profile == id 即已接入
  const connectedProfiles = new Set<string>();
  try {
    for (const agent of listAgents().agents) {
      if (agent.runtime === "hermes" && agent.profile && agent.dir?.startsWith(elenvaAgentsRoot())) {
        connectedProfiles.add(agent.profile);
      }
    }
  } catch {
    /* 注册表读不了时宁缺勿滥 */
  }
  for (const entry of entries) entry.connected = connectedProfiles.has(entry.id);

  entries.sort((a, b) => {
    if (a.id === "default") return -1;
    if (b.id === "default") return 1;
    return a.displayName.localeCompare(b.displayName, "zh-CN");
  });

  cache = { at: Date.now(), entries };
  return entries;
}

/** 使缓存失效（接入 / 断开后调用，让名册立即反映新状态）。 */
export function invalidateProfilesCache(): void {
  cache = null;
}

/* ---------------- 审计 ---------------- */

export interface AuditLine {
  ts: string;
  action: "connect" | "disconnect";
  profile: string;
  result: "ok" | "error";
  detail?: string;
}

export function appendAudit(line: AuditLine): void {
  try {
    const file = path.join(os.homedir(), ".elenva", "audit.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(line) + "\n", "utf8");
  } catch {
    /* 审计写失败不阻塞主操作 */
  }
}
