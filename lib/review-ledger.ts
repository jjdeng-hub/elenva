import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  getHermesMemoryDir,
  getHermesProjectsDir,
  parseMemoryEntries,
  type AgentMemoryKind,
} from "./agent-memory";
import { worklogDir } from "./memory-suggestions";

/**
 * 复台账 —— 把「定期复盘到底产出了什么」集中到一条时间线上。
 *
 * 为什么要有它：自动复盘由 pi-hermes-memory 扩展在跑（写记忆 / 整理记忆），产出散落在
 * 记忆文件与工作记录里，没有一处能把「哪天学到了什么 / 那天在干什么 / 去掉了什么」对起来。
 *
 * 数据来源全是**只读**的既有痕迹（本模块不写任何文件，边界见 AGENTS.md「绝不写记忆扩展数据」）：
 *  1. 记忆条目元数据 `<!-- created=…, last=… -->`（`lib/agent-memory.ts` 解析）
 *     - `created` = 条目首次落盘的日期 → 「学到了什么」
 *     - `last`    = 最近一次被引用/整理的日期（复盘整理会刷新它）→ 「复习/更新了哪些」
 *  2. 工作记录 `~/.pi/agent/worklog/*.md`（含 `archive/`）→ 「工作上发生了什么」
 *  3. 记忆文件的快照副产物 `.<文件>.recovery-<ms>-<uuid>` / `.retired-<ms>-<uuid>`
 *     —— 扩展每次写盘前留的旧状态；把相邻两份快照做条目差集，能还原出
 *     「曾经存在、之后不再存在」的条目 → 「去掉什么」。**这是近似**（条目被改写也会表现为旧文本消失），
 *     展示层必须如实标注。
 *
 * 设计约束（与仓库其它聚合层一致）：
 *  - 读不到 / 损坏 / 目录缺失都不抛，返回空段（账本是尽力而为的旁路视图）；
 *  - 结果做 30s 级进程内缓存，避免每次打开页面全量扫盘；
 *  - 日期一律按 `YYYY-MM-DD` 粒度聚合与排序（扩展只写到天）。
 */

/* ============================ 类型 ============================ */

export type ReviewLedgerGroupBy = "day" | "week";

/** 一条记忆（新增 / 更新共用），`file` 供界面「点回记忆条目」定位 */
export interface ReviewLedgerMemoryItem {
  /** 记忆文件标识：user | memory | failures | project/<项目名> */
  file: string;
  label: string;
  kind: AgentMemoryKind;
  /** 条目正文（剥掉元数据注释）；界面截断展示，点击可回记忆页对应文件 */
  text: string;
  preview: string;
  created: string | null;
  last: string | null;
}

/** 一条工作记录（`## <时间> · <标题> · <状态>`） */
export interface ReviewLedgerWorkItem {
  /** 来源文件（worklog 文件名，如 elenva.md / archive/...） */
  source: string;
  date: string | null;
  /** 标题行里的 HH:MM（有则用于同日精确排序） */
  time: string | null;
  title: string;
  /** done | doing | blocked | null */
  status: string | null;
  /** 「待办」行（工作记录里的未完成项），没有则 null */
  todo: string | null;
}

/** 一条「去掉」痕迹（由快照差分推得，近似） */
export interface ReviewLedgerRemovedItem {
  file: string;
  label: string;
  kind: AgentMemoryKind;
  text: string;
  preview: string;
  /** 消失发生的时刻（下一份快照的落盘时间，ISO） */
  at: string;
}

/** 一个时间桶（按天或按周） */
export interface ReviewLedgerBucket {
  /** 天：YYYY-MM-DD；周：YYYY-Www */
  key: string;
  /** 展示标签：天=日期；周=「MM-DD ~ MM-DD · 第 N 周」 */
  label: string;
  dateFrom: string;
  dateTo: string;
  learned: ReviewLedgerMemoryItem[];
  touched: ReviewLedgerMemoryItem[];
  removed: ReviewLedgerRemovedItem[];
  work: ReviewLedgerWorkItem[];
  counts: { learned: number; touched: number; removed: number; work: number };
}

export interface ReviewLedgerSummary {
  learned: number;
  touched: number;
  removed: number;
  work: number;
  /** 账面上最早的日期与最晚的日期（无数据则 null） */
  from: string | null;
  to: string | null;
}

export interface ReviewLedger {
  /** 是否走的是「近似重建」路线（有元数据痕迹时为 false，见模块头注释） */
  approximate: boolean;
  generatedAt: string;
  groupBy: ReviewLedgerGroupBy;
  buckets: ReviewLedgerBucket[];
  summary: ReviewLedgerSummary;
  /** 数据来源与口径说明（界面顶部一句话 + 展开细目） */
  notes: string[];
  /** 是否真的读到了记忆文件（用于界面判「未安装扩展 / 空数据」） */
  memoryFound: boolean;
}

export interface ReviewLedgerSources {
  memoryDir: string;
  projectsDir: string;
  worklogDir: string;
}

/* ============================ 常量 ============================ */

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PREVIEW_MAX = 90;
/** 单个文件最多回看的快照份数（旧→新截断，防止长期运行后扫盘过重） */
const MAX_SNAPSHOTS_PER_FILE = 24;
/** 单个桶的条数上限（账本是给人看的，不做全量倾倒） */
const MAX_ITEMS_PER_SECTION = 120;
const MAX_BUCKETS = 400;
const CACHE_TTL_MS = 30_000;
const MEMORY_FILES = [
  { id: "user", label: "USER.md", kind: "user" as AgentMemoryKind, file: "USER.md" },
  { id: "memory", label: "MEMORY.md", kind: "memory" as AgentMemoryKind, file: "MEMORY.md" },
  { id: "failures", label: "failures.md", kind: "failures" as AgentMemoryKind, file: "failures.md" },
];

/* ============================ 小工具 ============================ */

/** 文本归一：折叠空白 + 去首尾（用于去重 / 差集比对） */
export function normalizeLedgerText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 预览：折叠空白后截断（超长加省略号） */
export function previewOf(text: string, max = PREVIEW_MAX): string {
  const flat = normalizeLedgerText(text);
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 只接受 `YYYY-MM-DD`；其它（空串 / 非法日期）返回 null */
export function asDay(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!DAY_PATTERN.test(trimmed)) return null;
  const at = Date.parse(`${trimmed}T00:00:00Z`);
  if (!Number.isFinite(at)) return null;
  // Date.parse 会把 2026-02-31 归一成 3 月，回读比对拦掉
  return new Date(at).toISOString().slice(0, 10) === trimmed ? trimmed : null;
}

/** 毫秒时间戳 → `YYYY-MM-DD`（本地时区，与工作记录书写口径一致） */
function dayOfMs(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** ISO 字符串 → `YYYY-MM-DD`（取本地日期） */
function dayOfIso(iso: string): string | null {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? dayOfMs(at) : null;
}

/**
 * ISO 周键：`YYYY-Www`（周一起算，周四决定归属年份）。
 * 不引第三方库 —— 这里只需要稳定的分组键与展示区间。
 */
export function isoWeekOf(day: string): { key: string; week: number; monday: string; sunday: string } | null {
  const at = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(at)) return null;
  const d = new Date(at);
  const dow = (d.getUTCDay() + 6) % 7; // 周一=0
  const thursday = new Date(at + (3 - dow) * 86_400_000);
  const year = thursday.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.floor((thursday.getTime() - jan1) / 86_400_000 / 7) + 1;
  const monday = new Date(at - dow * 86_400_000);
  const sunday = new Date(monday.getTime() + 6 * 86_400_000);
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  return { key: `${year}-W${String(week).padStart(2, "0")}`, week, monday: iso(monday.getTime()), sunday: iso(sunday.getTime()) };
}

/* ============================ 记忆条目 ============================ */

interface MemoryFileRef {
  id: string;
  label: string;
  kind: AgentMemoryKind;
  path: string;
}

/** 记忆文件清单（固定三项 + 存在 MEMORY.md 的项目目录），只返回磁盘上真实存在的 */
export function listLedgerMemoryFiles(sources: Pick<ReviewLedgerSources, "memoryDir" | "projectsDir">): MemoryFileRef[] {
  const out: MemoryFileRef[] = [];
  for (const f of MEMORY_FILES) {
    const path = join(sources.memoryDir, f.file);
    if (existsFile(path)) out.push({ id: f.id, label: f.label, kind: f.kind, path });
  }
  let names: string[] = [];
  try {
    names = readdirSync(sources.projectsDir);
  } catch {
    names = [];
  }
  for (const name of names) {
    if (!name || name.startsWith(".") || name === "skills" || name.includes("/") || name.includes("\\")) continue;
    const path = join(sources.projectsDir, name, "MEMORY.md");
    if (existsFile(path)) {
      out.push({ id: `project/${name}`, label: `${name}/MEMORY.md`, kind: "project", path });
    }
  }
  return out;
}

function existsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** 从记忆文件清单收集所有条目（带 created/last） */
export function collectMemoryItems(files: MemoryFileRef[]): ReviewLedgerMemoryItem[] {
  const out: ReviewLedgerMemoryItem[] = [];
  for (const file of files) {
    for (const entry of parseMemoryEntries(readText(file.path))) {
      const text = entry.text.trim();
      if (!text) continue;
      out.push({
        file: file.id,
        label: file.label,
        kind: file.kind,
        text,
        preview: previewOf(text),
        created: asDay(entry.created),
        last: asDay(entry.last),
      });
    }
  }
  return out;
}

/* ============================ 工作记录 ============================ */

const WORKLOG_HEAD_PATTERN = /^##\s+(\d{4}-\d{2}-\d{2})(?:[ T]+(\d{1,2}:\d{2}))?\s*·\s*(.*)$/;
const STATUS_PATTERN = /·\s*(done|doing|blocked)\s*$/i;
const TODO_LINE_PATTERN = /(?:^|[*\s])待办\s*[:：]\s*(.*)$/;

/** 解析 `## <日期>[ <时间>] · <标题>[ · <状态>]`；宽松兜底：不中时整行当标题、date=null */
export function parseWorklogHeading(heading: string): { date: string | null; time: string | null; title: string; status: string | null } | null {
  const line = heading.trim();
  if (!/^##\s/.test(line)) return null;
  const match = WORKLOG_HEAD_PATTERN.exec(line);
  if (!match) {
    const rest = line.replace(/^#+\s*/, "").trim();
    if (!rest) return null;
    const lead = /^(\d{4}-\d{2}-\d{2})\s*[-—:：]?\s*/.exec(rest);
    const date = lead ? asDay(lead[1]) : null;
    const body = lead ? rest.slice(lead[0].length) : rest;
    return { date, time: null, title: stripStatus(body).title, status: stripStatus(body).status };
  }
  const body = match[3] ?? "";
  const { title, status } = stripStatus(body);
  return { date: asDay(match[1]), time: match[2] ?? null, title: title || body, status };
}

function stripStatus(text: string): { title: string; status: string | null } {
  const match = STATUS_PATTERN.exec(text);
  if (!match) return { title: text.trim(), status: null };
  return { title: text.slice(0, match.index).trim(), status: match[1].toLowerCase() };
}

/** 解析一份工作记录文件 → 若干条目（`###` 不算条目头，与 elenva-worklog 同口径） */
export function parseWorklogFile(raw: string, source: string): ReviewLedgerWorkItem[] {
  const out: ReviewLedgerWorkItem[] = [];
  let current: { head: ReturnType<typeof parseWorklogHeading>; lines: string[] } | null = null;
  const flush = () => {
    if (!current || !current.head) {
      current = null;
      return;
    }
    const todo = extractTodo(current.lines);
    out.push({ source, ...current.head, todo });
    current = null;
  };
  for (const line of raw.split(/\r?\n/)) {
    if (/^##\s/.test(line)) {
      flush();
      const head = parseWorklogHeading(line);
      if (head) current = { head, lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  flush();
  return out;
}

/** 从正文行里取「待办：…」（常见形态：`待办：xxx`、`- **待办**：xxx`、`- 待办：xxx`） */
function extractTodo(lines: string[]): string | null {
  for (const line of lines) {
    const match = TODO_LINE_PATTERN.exec(line.replace(/\*\*/g, ""));
    if (match) {
      const text = normalizeLedgerText(match[1]);
      if (text) return text;
    }
  }
  return null;
}

/** 工作记录文件：主目录 + `archive/` 子目录（滚动归档里有更早的条目） */
function listWorklogFiles(dir: string): string[] {
  const out: string[] = [];
  const push = (path: string, source: string) => {
    try {
      if (statSync(path).isFile()) out.push(`${source}\u0000${path}`);
    } catch {
      /* 读不到就跳过 */
    }
  };
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".md")) continue;
    push(join(dir, name), name);
  }
  try {
    for (const name of readdirSync(join(dir, "archive"))) {
      if (!name.toLowerCase().endsWith(".md")) continue;
      push(join(dir, "archive", name), `archive/${name}`);
    }
  } catch {
    /* 没有 archive 目录属正常 */
  }
  return out;
}

/**
 * 收集工作记录条目。归档文件与当前文件会有大量重复（滚动窗口从前一份复制而来），
 * 按 `日期 + 时间 + 标题` 去重；同一时刻只在当前文件保留一条。
 */
export function collectWorklogItems(dir: string): ReviewLedgerWorkItem[] {
  const seen = new Set<string>();
  const out: ReviewLedgerWorkItem[] = [];
  for (const entry of listWorklogFiles(dir)) {
    const [source, path] = entry.split("\u0000");
    for (const item of parseWorklogFile(readText(path), source)) {
      const key = `${item.date ?? "?"}\u0000${item.time ?? ""}\u0000${item.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

/* ============================ 「去掉什么」：快照差分 ============================ */

interface SnapshotState {
  /** 快照落盘毫秒（文件名里的时间戳） */
  ms: number;
  /** 归一文本 → 原文 */
  entries: Map<string, string>;
}

const SNAPSHOT_PATTERN = /^\.(.+)\.(?:recovery|retired)-(\d{10,})-[0-9a-f-]{36}$/i;

/** 某记忆文件的历史快照（含当前文件作为最新状态），按时间升序 */
function snapshotStates(file: MemoryFileRef): SnapshotState[] {
  const dirName = join(file.path, "..");
  const base = basename(file.path);
  const states: SnapshotState[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dirName);
  } catch {
    names = [];
  }
  for (const name of names) {
    const match = SNAPSHOT_PATTERN.exec(name);
    if (!match || match[1] !== base) continue;
    const ms = Number(match[2]);
    if (!Number.isFinite(ms)) continue;
    states.push({ ms, entries: entryMap(readText(join(dirName, name))) });
  }
  states.sort((a, b) => a.ms - b.ms);
  const trimmed = states.slice(-MAX_SNAPSHOTS_PER_FILE);
  // 当前文件是这份记忆的「现在」：只有它比最旧快照新时才纳入差分
  try {
    const mtime = statSync(file.path).mtimeMs;
    trimmed.push({ ms: mtime, entries: entryMap(readText(file.path)) });
  } catch {
    /* 文件消失：只用快照 */
  }
  return trimmed.sort((a, b) => a.ms - b.ms);
}

function entryMap(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of parseMemoryEntries(raw)) {
    const text = entry.text.trim();
    const key = normalizeLedgerText(text);
    if (key && !map.has(key)) map.set(key, text);
  }
  return map;
}

/**
 * 快照差集：相邻两份状态间「前有后无」的条目视为被去掉，记在**后一份快照**的时间点。
 * 近似：条目被改写（而非删除）同样会表现为旧文本消失 —— 展示层标注。
 */
export function collectRemovals(files: MemoryFileRef[]): ReviewLedgerRemovedItem[] {
  const out: ReviewLedgerRemovedItem[] = [];
  for (const file of files) {
    const states = snapshotStates(file);
    for (let i = 1; i < states.length; i += 1) {
      const prev = states[i - 1];
      const next = states[i];
      if (next.ms <= prev.ms) continue;
      for (const [key, text] of prev.entries) {
        if (next.entries.has(key)) continue;
        if (key.length < 12) continue; // 过短的条目差分不可靠，丢掉噪音
        out.push({
          file: file.id,
          label: file.label,
          kind: file.kind,
          text,
          preview: previewOf(text),
          at: new Date(next.ms).toISOString(),
        });
      }
    }
  }
  return out;
}

/* ============================ 聚合 ============================ */

function compareIsoDesc(a: string, b: string): number {
  if (a === b) return 0;
  return a > b ? -1 : 1;
}

function compareWorkDesc(a: ReviewLedgerWorkItem, b: ReviewLedgerWorkItem): number {
  const da = `${a.date ?? ""}T${a.time ?? "00:00"}`;
  const db = `${b.date ?? ""}T${b.time ?? "00:00"}`;
  if (da === db) return a.title.localeCompare(b.title, "zh");
  return da > db ? -1 : 1;
}

/** 按天或按周把四类条目收进桶，桶按时间倒序 */
export function groupReviewLedger(
  items: {
    learned: ReviewLedgerMemoryItem[];
    touched: ReviewLedgerMemoryItem[];
    removed: ReviewLedgerRemovedItem[];
    work: ReviewLedgerWorkItem[];
  },
  groupBy: ReviewLedgerGroupBy,
): ReviewLedgerBucket[] {
  const buckets = new Map<string, ReviewLedgerBucket>();
  const bucketOf = (day: string): ReviewLedgerBucket | null => {
    if (!DAY_PATTERN.test(day)) return null;
    const key = groupBy === "week" ? isoWeekOf(day)?.key ?? day : day;
    const existing = buckets.get(key);
    if (existing) {
      if (day < existing.dateFrom) existing.dateFrom = day;
      if (day > existing.dateTo) existing.dateTo = day;
      return existing;
    }
    const week = groupBy === "week" ? isoWeekOf(day) : null;
    const bucket: ReviewLedgerBucket = {
      key,
      label: week ? `${week.monday.slice(5)} ~ ${week.sunday.slice(5)} · 第 ${week.week} 周` : day,
      dateFrom: day,
      dateTo: day,
      learned: [],
      touched: [],
      removed: [],
      work: [],
      counts: { learned: 0, touched: 0, removed: 0, work: 0 },
    };
    buckets.set(key, bucket);
    return bucket;
  };

  for (const item of items.learned) {
    if (!item.created) continue;
    bucketOf(item.created)?.learned.push(item);
  }
  for (const item of items.touched) {
    if (!item.last) continue;
    bucketOf(item.last)?.touched.push(item);
  }
  for (const item of items.removed) {
    const day = dayOfIso(item.at);
    if (day) bucketOf(day)?.removed.push(item);
  }
  for (const item of items.work) {
    if (!item.date) continue;
    bucketOf(item.date)?.work.push(item);
  }

  const list = [...buckets.values()]
    .sort((a, b) => compareIsoDesc(a.dateTo, b.dateTo))
    .slice(0, MAX_BUCKETS);
  for (const bucket of list) {
    bucket.learned = bucket.learned.slice(0, MAX_ITEMS_PER_SECTION);
    bucket.touched = bucket.touched.slice(0, MAX_ITEMS_PER_SECTION);
    bucket.removed = bucket.removed.slice(0, MAX_ITEMS_PER_SECTION);
    bucket.work = bucket.work.sort(compareWorkDesc).slice(0, MAX_ITEMS_PER_SECTION);
    bucket.counts = {
      learned: bucket.learned.length,
      touched: bucket.touched.length,
      removed: bucket.removed.length,
      work: bucket.work.length,
    };
  }
  return list;
}

/* ============================ 主入口 ============================ */

export interface BuildReviewLedgerOptions extends Partial<ReviewLedgerSources> {
  groupBy?: ReviewLedgerGroupBy;
  /** 注入「现在」（测试用）；不传取系统时间 */
  now?: number;
}

/** 只读聚合（无缓存，供 API 与自测直接调用） */
export function buildReviewLedger(options: BuildReviewLedgerOptions = {}): ReviewLedger {
  const sources: ReviewLedgerSources = {
    memoryDir: options.memoryDir ?? getHermesMemoryDir(),
    projectsDir: options.projectsDir ?? getHermesProjectsDir(),
    worklogDir: options.worklogDir ?? worklogDir(),
  };
  const groupBy: ReviewLedgerGroupBy = options.groupBy === "week" ? "week" : "day";
  const generatedAt = new Date(options.now ?? Date.now()).toISOString();

  const files = listLedgerMemoryFiles(sources);
  const memoryItems = collectMemoryItems(files);
  const workItems = collectWorklogItems(sources.worklogDir);
  const removed = collectRemovals(files);

  const learned = memoryItems.filter((item) => item.created !== null);
  const touched = memoryItems.filter((item) => item.last !== null && item.last !== item.created);
  const buckets = groupReviewLedger({ learned, touched, removed, work: workItems }, groupBy);

  const allDays = [
    ...memoryItems.flatMap((item) => [item.created, item.last]),
    ...removed.map((item) => dayOfIso(item.at)),
    ...workItems.map((item) => item.date),
  ].filter((day): day is string => !!day && DAY_PATTERN.test(day));
  allDays.sort();

  const summary: ReviewLedgerSummary = {
    learned: learned.length,
    touched: touched.length,
    removed: removed.length,
    work: workItems.length,
    from: allDays.length > 0 ? allDays[0] : null,
    to: allDays.length > 0 ? allDays[allDays.length - 1] : null,
  };

  return {
    approximate: files.length === 0,
    generatedAt,
    groupBy,
    buckets,
    summary,
    memoryFound: files.length > 0,
    notes: [
      memoryItems.length > 0
        ? "「学到 / 更新」直接来自记忆条目元数据（created=首次落盘，last=最近被整理引用）。"
        : "没有读到记忆文件（扩展未安装或目录为空），账面只剩工作记录。",
      workItems.length > 0
        ? "「工作」来自工作记录（~/.pi/agent/worklog/*.md，含 archive/），按标题日期归入当天。"
        : "没有读到工作记录。",
      removed.length > 0
        ? "「去掉」是快照差分的近似结果：记忆文件写盘前会留旧状态，相邻快照间消失的条目记在后者时间点；条目被改写也会表现为此，仅作线索。"
        : "未发现可考的「去掉」痕迹（没有历史快照，或条目从未被删改）。",
    ],
  };
}

/* ============================ 缓存 ============================ */

interface CacheEntry {
  at: number;
  value: ReviewLedger;
}

const cache = new Map<string, CacheEntry>();

/** 读复台账（默认目录 + 30s 进程内缓存） */
export function readReviewLedger(groupBy: ReviewLedgerGroupBy = "day"): ReviewLedger {
  const key = groupBy;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;
  const value = buildReviewLedger({ groupBy });
  cache.set(key, { at: now, value });
  return value;
}

/** 清缓存（测试用；模块级缓存换 jiti 实例也管不住，见 failures 里的记录） */
export function resetReviewLedgerCacheForTest(): void {
  cache.clear();
}

/** 默认数据源（供界面侧提示 / 排查用） */
export function defaultReviewLedgerSources(): ReviewLedgerSources {
  return { memoryDir: getHermesMemoryDir(), projectsDir: getHermesProjectsDir(), worklogDir: worklogDir() };
}
