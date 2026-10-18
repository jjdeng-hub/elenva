import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { getAgentDir, parseSkillBlock } from "@earendil-works/pi-coding-agent";

/**
 * 技能调用统计 —— 离线扫描全部会话文件。
 *
 * pi 内核在用户消息里以 <skill name="..." location="..."> 块记录 `/skill:` 命令展开，
 * 因此对 JSONL 的用户消息行做计数即可得到命令调用次数；此外本机实操更常见的是
 * 模型主动 `read <agentDir>/skills/<name>/SKILL.md`（见 R2），两条路径都计入。
 *
 * 2026-10-18（模块 4 R1）：从「字面 includes + 正则计数」改为**真正解析 JSON 行**
 * + 内核 parseSkillBlock 定位。旧写法有两处误计：
 *   · 用户在消息里**引用/讨论** skill 块（不在文本起始）也被计入；
 *   · 非 JSON 的损坏行只要含有字面 `"role":"user"` 就参与计数。
 * 现在：行 JSON 解析失败直接跳过；且 skill 块必须位于该消息**文本起始**
 * （parseSkillBlock 的正则就是 `^<skill …>`），位置不对即为引用，不是调用。
 *
 * 2026-10-18（模块 4 R2）：口径扩展到文件读取路径。**读数是「会话级激活数」**：
 *   · 命令路径：每个 `/skill:` 块计一次（保留既有语义，可一会话多次）；
 *   · 读取路径：`(会话, 技能)` 去重，一个会话读多次只算 1；
 *   · 两条都命中时只算命令那一次，不双计（命令是显式调用）；
 *   · 同会话内被 `write`/`edit`/`skill_manage`/`skill_draft` 改写的技能，
 *     其**读取**不计入（维护行为否决）——显式 `/skill:` 调用不受影响。
 *
 * 2026-10-18（模块 4 尾巴轮 · 归因）：**来源归因**。此前按**光名字**归并，于是
 * `projects-memory/<项目>/skills/<名>/SKILL.md` 的读取计进了 total，但
 * `buildSkillLifecycle` 只枚举 `<agentDir>/skills`，项目技能上不了高频榜
 * （真实数据：31 次里 28 次读的是项目技能，榜单只列 3 条全局的）。
 * 现补一层 additive 的 `entries`：按 **(scope, name)** 拆分，与 total 同口径
 * （每条 count 之和 = total）。scope 从观察到的**路径**推：
 *   · `global`    = `<agentDir>/skills/<名>/SKILL.md`
 *   · `workspace` = 项目内 `.pi/skills` / `.agents/skills`
 *   · `project`   = `projects-memory/<项目>/skills/<名>/SKILL.md`（带 project 标识）
 *   · `unknown`   = 其它路径
 * 键 `key`：`global:<名>` / `workspace:<名>` / `project:<项目>:<名>` / `unknown:<名>`。
 * **为何键里带 scope/project**：全局与项目可能同名、两个项目之间也可能同名；
 * 只用名字会把不同技能的读数混在一起（见 skill-advisor 的高频榜）。
 * 既有字段（total / skills / lastUsed / recent / sources / skillSources）我们**不动**：
 * 它们仍是「按名字归并」的历史口径，老客户端忽略 entries 不会崩。
 *
 * 既有字段语义不变，只是覆盖了第二条路径；来源拆分走 additive 字段。
 */

export type SkillScope = "global" | "workspace" | "project" | "unknown";

/** 按 (scope, name) 拆分的用量条目 —— Σcount = total，Σcommand/read = sources.command/read */
export interface SkillUsageEntry {
  /** 稳定键：`global:<名>` / `workspace:<名>` / `project:<项目>:<名>` / `unknown:<名>` */
  key: string;
  name: string;
  scope: SkillScope;
  /** scope === "project" 时的项目标识（`projects-memory/<项目>` 里的 `<项目>`） */
  project?: string;
  count: number;
  command: number;
  read: number;
  count7: number;
  count30: number;
  lastUsedAt: string | null;
}

export interface SkillUsageReport {
  /** 全部会话中的技能调用总次数（命令 + 读取，会话级激活口径） */
  total: number;
  /** 按调用次数降序（**按名字归并**的历史口径，保留兼容） */
  skills: { name: string; count: number }[];
  /** 技能名 → 最近一次出现在会话里的时间（取会话文件 mtime，近似值） */
  lastUsed: Record<string, string>;
  /**
   * 2026-10-16 增（模块 4 R5）：调用时间窗口统计。在同一次全量扫描里顺带算出，
   * 老客户端可整体忽略本字段，既有字段均不变（向后兼容只增不改）。
   */
  recent: SkillUsageWindows;
  /**
   * 2026-10-18 增（模块 4 R2）：按来源拆分总读数，additive。
   * `readSkippedMaintenance` 是「被维护否决、未计入」的读取次数（诊断用，不算进 total）。
   */
  sources: SkillUsageSources;
  /** 2026-10-18 增（模块 4 R2）：按技能拆分来源，additive（按名字归并）。 */
  skillSources: Record<string, { command: number; read: number }>;
  /**
   * 2026-10-18 增（模块 4 尾巴轮）：按 (scope, name) 拆分的条目，additive。
   * 与 total 同口径（Σcount = total）；项目技能在此可见，高频榜据此取数。
   */
  entries: SkillUsageEntry[];
}

export interface SkillUsageSources {
  command: number;
  read: number;
  readSkippedMaintenance: number;
}

export interface SkillUsageWindows {
  /** 统计基准时间（ISO） */
  at: string;
  /** 近 7 天（含今天）各技能调用次数 */
  days7: Record<string, number>;
  /** 近 30 天各技能调用次数 */
  days30: Record<string, number>;
  total7: number;
  total30: number;
}

function collectJsonlFiles(dir: string, out: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const full = join(dir, name);
    if (name.endsWith(".jsonl")) {
      out.push(full);
      continue;
    }
    collectJsonlFiles(full, out); // 目录递归；对文件 readdirSync 会抛错，由上方 catch 吞掉
  }
}

let cache: { at: number; value: SkillUsageReport } | null = null;
const CACHE_TTL_MS = 30_000;

/** 仅供自测用：清掉内存缓存强制重扫（jiti 的模块注册表跨实例共享，新实例也拿同一份缓存） */
export function resetSkillUsageCacheForTest(): void {
  cache = null;
}

/** 消息行外层对象带 timestamp（pi 会话格式）：{"type":"message","timestamp":"…",…} */
function timestampMs(value: unknown, fallbackMs: number): number {
  if (typeof value === "string") {
    const at = Date.parse(value);
    if (Number.isFinite(at)) return at;
  }
  return fallbackMs;
}

/** 用户消息的文本块：content 可能是裸字符串，也可能是 [{type:"text",text}] */
function textBlocks(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    if (
      block !== null &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      out.push((block as { text: string }).text);
    }
  }
  return out;
}

/**
 * 取出文本**起始**处的 skill 块（可链式：一个消息里连着多个 /skill: 调用）。
 * 用内核自己的 parseSkillBlock —— 它的正则以 `^<skill name="…" location="…">` 开头，
 * 天然满足「位置不对即引用」的判据，也避免我们与内核格式漂移。
 * 尾随空白先行去掉：parseSkillBlock 的 `$` 只认输入末尾，消息末尾多一个换行不该让它失配。
 */
function leadingSkillBlocks(text: string): { name: string; location: string }[] {
  const blocks: { name: string; location: string }[] = [];
  let cursor = text.replace(/\s+$/, "");
  for (;;) {
    const block = parseSkillBlock(cursor);
    if (!block) break;
    blocks.push({ name: block.name, location: block.location });
    if (!block.userMessage) break;
    cursor = block.userMessage;
  }
  return blocks;
}

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** assistant 消息里结构化的 toolCall 块（只认结构化字段，不扫文本 —— 避免 bash/grep 里的字符串命中） */
function assistantToolCalls(content: unknown): ToolCall[] {
  if (!Array.isArray(content)) return [];
  const out: ToolCall[] = [];
  for (const block of content) {
    if (
      block !== null &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "toolCall" &&
      typeof (block as { name?: unknown }).name === "string"
    ) {
      const args = (block as { arguments?: unknown }).arguments;
      out.push({
        name: (block as { name: string }).name,
        args: args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {},
      });
    }
  }
  return out;
}

/** 统一成正斜杠，兼容 Windows 形态的落盘路径 */
function normalizePath(value: unknown): string | null {
  return typeof value === "string" && value ? value.replace(/\\/g, "/") : null;
}

/** 技能身份：名字 + 来源域（+ 项目标识）。归因键由此推出。 */
interface SkillIdentity {
  name: string;
  scope: SkillScope;
  project?: string;
}

/**
 * 由**路径**推来源域。认不出的路径归 `unknown`（不臆测，宁可不归因）。
 * 判定顺序：projects-memory 的项目技能 → 项目内 .pi/.agents → 全局 skills 根。
 */
function scopeForPath(normalized: string): { scope: SkillScope; project?: string } {
  const projectMatch = /(?:^|\/)projects-memory\/([^/]+)\/skills\//.exec(normalized);
  if (projectMatch) return { scope: "project", project: projectMatch[1] };
  if (/(?:^|\/)\.pi\/skills\//.test(normalized) || /(?:^|\/)\.agents\/skills\//.test(normalized)) {
    return { scope: "workspace" };
  }
  const globalRoot = join(getAgentDir(), "skills").replace(/\\/g, "/");
  if (normalized.startsWith(`${globalRoot}/`)) return { scope: "global" };
  return { scope: "unknown" };
}

/**
 * `…/skills/<name>/SKILL.md` → 身份。
 * 不硬编码技能根：全局 `<agentDir>/skills`、项目 `.pi/skills`、
 * `projects-memory/<项目>/skills` 与仓库 `skills/` 都落在这个形态里。
 */
const SKILL_FILE_RE = /(?:^|\/)skills\/([^/]+)\/SKILL\.md$/;
function skillFileIdentity(path: unknown): SkillIdentity | null {
  const normalized = normalizePath(path);
  if (!normalized) return null;
  const match = SKILL_FILE_RE.exec(normalized);
  if (!match) return null;
  return { name: match[1], ...scopeForPath(normalized) };
}

/** 路径是否落在某个技能目录内（`…/skills/<name>/…`）：write/edit 的维护信号 */
const SKILL_DIR_RE = /(?:^|\/)skills\/([^/]+)\//;
function skillDirIdentity(path: unknown): SkillIdentity | null {
  const normalized = normalizePath(path);
  if (!normalized) return null;
  const match = SKILL_DIR_RE.exec(normalized);
  if (!match) return null;
  return { name: match[1], ...scopeForPath(normalized) };
}

/** 归因键：同名不同域（或不同项目）必须分开，否则读数会混在一起 */
function usageKey(identity: SkillIdentity): string {
  if (identity.scope === "project" && identity.project) {
    return `project:${identity.project}:${identity.name}`;
  }
  return `${identity.scope}:${identity.name}`;
}

/** 单会话的原始事件（跨文件合并前先按会话聚合，才能做「会话内去重」） */
interface SessionEvents {
  /** 归因键 → 身份 + 各次 `/skill:` 命令调用的时间戳 */
  commands: Map<string, { identity: SkillIdentity; timestamps: number[] }>;
  /** 归因键 → 身份 + 最后一次读取该技能文件的时间戳 */
  reads: Map<string, { identity: SkillIdentity; atMs: number }>;
  /** 本会话里被改写的技能（按键：路径可归因时） */
  maintainedKeys: Set<string>;
  /** 被改写的技能名（按名：skill_manage / skill_draft 只给了名字，没有路径） */
  maintainedNames: Set<string>;
}

/** 把 assistant 的 toolCall 归入命令/读取/维护三类（纯函数，便于单测与解释口径） */
function collectToolCallEvents(calls: readonly ToolCall[], atMs: number, events: SessionEvents): void {
  for (const call of calls) {
    if (call.name === "read") {
      const identity = skillFileIdentity(call.args.path);
      if (identity) {
        const key = usageKey(identity);
        const previous = events.reads.get(key);
        if (!previous || atMs > previous.atMs) events.reads.set(key, { identity, atMs });
      }
      continue;
    }
    if (call.name === "write" || call.name === "edit") {
      const identity = skillDirIdentity(call.args.path);
      if (identity) events.maintainedKeys.add(usageKey(identity));
      continue;
    }
    if (call.name === "skill_manage") {
      const action = call.args.action;
      if (action === "create" || action === "patch" || action === "update") {
        const name = call.args.name;
        if (typeof name === "string" && name) events.maintainedNames.add(name);
      }
      continue;
    }
    if (call.name === "skill_draft") {
      const name = call.args.name;
      if (typeof name === "string" && name) events.maintainedNames.add(name);
    }
  }
}

/** 汇总时用的可变条目（时间戳先用毫秒；最后转 ISO） */
interface MutableUsageEntry {
  key: string;
  name: string;
  scope: SkillScope;
  project?: string;
  count: number;
  command: number;
  read: number;
  count7: number;
  count30: number;
  lastUsedMs: number;
}

export function aggregateSkillUsage(): SkillUsageReport {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const files: string[] = [];
  collectJsonlFiles(join(getAgentDir(), "sessions"), files);

  const counts = new Map<string, number>();
  const lastUsedAt = new Map<string, number>();
  const days7 = new Map<string, number>();
  const days30 = new Map<string, number>();
  const sources: SkillUsageSources = { command: 0, read: 0, readSkippedMaintenance: 0 };
  const skillSources = new Map<string, { command: number; read: number }>();
  const entries = new Map<string, MutableUsageEntry>();
  let total = 0;
  let total7 = 0;
  let total30 = 0;
  const nowMs = Date.now();
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

  /** 记一次「会话级激活」并同步窗口 / 排行 / 来源拆分 / 按域条目 */
  const record = (identity: SkillIdentity, source: "command" | "read", atMs: number, modified: number): void => {
    const key = usageKey(identity);
    counts.set(identity.name, (counts.get(identity.name) ?? 0) + 1);
    total += 1;
    sources[source] += 1;
    const per = skillSources.get(identity.name) ?? { command: 0, read: 0 };
    per[source] += 1;
    skillSources.set(identity.name, per);
    const inWeek = atMs >= nowMs - WEEK_MS;
    const inMonth = atMs >= nowMs - MONTH_MS;
    if (inWeek) {
      days7.set(identity.name, (days7.get(identity.name) ?? 0) + 1);
      total7 += 1;
    }
    if (inMonth) {
      days30.set(identity.name, (days30.get(identity.name) ?? 0) + 1);
      total30 += 1;
    }
    if (modified > (lastUsedAt.get(identity.name) ?? 0)) lastUsedAt.set(identity.name, modified);

    const entry = entries.get(key) ?? {
      key,
      name: identity.name,
      scope: identity.scope,
      ...(identity.project !== undefined ? { project: identity.project } : {}),
      count: 0,
      command: 0,
      read: 0,
      count7: 0,
      count30: 0,
      lastUsedMs: 0,
    };
    entry.count += 1;
    entry[source] += 1;
    if (inWeek) entry.count7 += 1;
    if (inMonth) entry.count30 += 1;
    if (modified > entry.lastUsedMs) entry.lastUsedMs = modified;
    entries.set(key, entry);
  };

  for (const file of files) {
    let text: string;
    let modified = 0;
    try {
      text = readFileSync(file, "utf8");
      modified = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    const events: SessionEvents = {
      commands: new Map(),
      reads: new Map(),
      maintainedKeys: new Set(),
      maintainedNames: new Set(),
    };
    for (const line of text.split("\n")) {
      const entry = parseLine(line);
      if (!entry) continue;
      const message = entry.message as { role?: unknown; content?: unknown } | undefined;
      if (!message || typeof message !== "object") continue;
      const atMs = timestampMs(entry.timestamp, modified);
      if (message.role === "user") {
        for (const textBlock of textBlocks(message.content)) {
          for (const block of leadingSkillBlocks(textBlock)) {
            const identity: SkillIdentity = { name: block.name, ...scopeForPath(block.location) };
            const key = usageKey(identity);
            const prev = events.commands.get(key) ?? { identity, timestamps: [] };
            prev.timestamps.push(atMs);
            events.commands.set(key, prev);
          }
        }
        continue;
      }
      if (message.role === "assistant") {
        collectToolCallEvents(assistantToolCalls(message.content), atMs, events);
      }
    }

    // 会话级合并：命令优先（不双计），读取去重为一次，被维护否决的读取不计
    for (const { identity, timestamps } of events.commands.values()) {
      for (const atMs of timestamps) record(identity, "command", atMs, modified);
    }
    for (const [key, { identity, atMs }] of events.reads) {
      if (events.commands.has(key)) continue; // 同会话已经有显式调用
      if (events.maintainedKeys.has(key) || events.maintainedNames.has(identity.name)) {
        sources.readSkippedMaintenance += 1;
        continue;
      }
      record(identity, "read", atMs, modified);
    }
  }

  const value: SkillUsageReport = {
    total,
    skills: [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    lastUsed: Object.fromEntries(
      [...lastUsedAt.entries()].map(([name, at]) => [name, new Date(at).toISOString()]),
    ),
    recent: {
      at: new Date(nowMs).toISOString(),
      days7: Object.fromEntries(days7),
      days30: Object.fromEntries(days30),
      total7,
      total30,
    },
    sources,
    skillSources: Object.fromEntries(skillSources),
    entries: [...entries.values()]
      .map((entry): SkillUsageEntry => ({
        key: entry.key,
        name: entry.name,
        scope: entry.scope,
        ...(entry.project !== undefined ? { project: entry.project } : {}),
        count: entry.count,
        command: entry.command,
        read: entry.read,
        count7: entry.count7,
        count30: entry.count30,
        lastUsedAt: entry.lastUsedMs > 0 ? new Date(entry.lastUsedMs).toISOString() : null,
      }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
  };
  cache = { at: Date.now(), value };
  return value;
}

/** 解析一行会话 JSONL；损坏行（非 JSON）返回 null —— 不再靠字面匹配放行 */
function parseLine(line: string): { timestamp?: unknown; message?: unknown } | null {
  if (!line.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed === null || typeof parsed !== "object") return null;
    return parsed as { timestamp?: unknown; message?: unknown };
  } catch {
    return null;
  }
}
