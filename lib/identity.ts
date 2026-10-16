import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";

/**
 * ELENVA 身份（identity）—— 宿主提示词里「你是谁」那一段的受管数据。
 *
 * ## 为什么要有这一层
 *
 * 身份段原先硬编码在 `lib/host-prompt.ts` 里。身份是**设计这个人的核心工具**（SOUL 思路工程化），
 * 改一个词、调一句价值观，都该像改记忆条目一样随手可做，而不是「改代码 → 跑类型检查 → 重启」。
 * 于是把它升级为受管文件：
 *
 *   <agentDir>/elenva-identity.json          当前值（0600、原子写、损坏回退内置默认）
 *   <agentDir>/elenva-identity-history/*.json 保存前的旧值快照（cap 50，最旧淘汰）
 *
 * ## 形状
 *
 *   { version: 1, updatedAt: ISO, sections: [{ id, title, body }] }
 *
 * **title 只用于编辑界面与历史列表，不注入提示词**（注入的是 body）。这样「给段落起个名字」
 * 不会污染系统提示、也不会打掉前缀缓存 —— 这也是迁移能保证「默认 = 现文逐字」的关键：
 * 内置默认的 body 拼起来与旧代码里的字符串逐字相同。
 *
 * ## 迁移
 *
 * 文件缺失 = 用内置默认（= 改造前的文本）→ 行为零变化；文件损坏 = 回退内置默认（不抛、
 * 不清空用户文件，下次保存会把损坏内容当作旧值快照下来，仍可追溯）。
 *
 * 与 `lib/host-prompt.ts` 的分工：这里只管身份段的数据与装配，提示词层的槽位、环境事实、
 * 装配顺序仍在 host-prompt.ts。装配顺序见 `docs/host-prompt.md`。
 */

/** 受管文件名（相对 agentDir） */
export const IDENTITY_FILE_NAME = "elenva-identity.json";
/** 历史快照目录名（相对 agentDir） */
export const IDENTITY_HISTORY_DIR_NAME = "elenva-identity-history";
/** 当前数据版本（形状变化时递增） */
export const IDENTITY_VERSION = 1;
/** 身份块的固定标题（注入提示词时拼在正文之前；段落标题不注入） */
export const IDENTITY_HEADING = "## 你是谁";
/** 段落标题长度上限（仅编辑界面用） */
export const IDENTITY_TITLE_LIMIT = 40;
/** 单段正文长度上限 */
export const IDENTITY_SECTION_BODY_LIMIT = 2000;
/** 整块身份正文（含标题）长度上限 —— 每轮注入，按 token × 轮数计费 */
export const IDENTITY_TOTAL_LIMIT = 4000;
/** 段落数量上限 */
export const IDENTITY_MAX_SECTIONS = 40;
/** 历史快照保留上限（最旧淘汰） */
export const IDENTITY_HISTORY_CAP = 50;

export interface IdentitySection {
  /** 稳定标识（同一份数据内唯一） */
  id: string;
  /** 段落名：编辑界面与历史列表用，不注入提示词 */
  title: string;
  /** 正文：注入提示词（按顺序用空行拼接） */
  body: string;
}

export interface IdentityDocument {
  version: number;
  /** 最近一次保存时间（ISO）；内置默认固定为一个常量时间 */
  updatedAt: string;
  sections: IdentitySection[];
}

/**
 * 内置默认身份段 —— **必须与改造前 `lib/host-prompt.ts` 的 identity 文本逐字一致**。
 * selftest（`tools/identity-selftest.mjs`）把它拼回整块后与钉死的现文对比。
 *
 * 分段依据：现状文本本来就是五段语义（自我认知 / 岗位 / 零件 / 能力边界 / 成长路径）。
 * 拆成段落只是把「本来就分开的意思」显式化，不改一个字。
 */
export const DEFAULT_IDENTITY_SECTIONS: readonly IdentitySection[] = [
  {
    id: "persona",
    title: "自我认知",
    body: "你是 **ELENVA**（昵称 **Elen**）—— 一个以 pi 为内核的 agent，住在这个 Web 工作台里。pi 是引擎，工作台是你的身体：记忆、技能、插件、子代理、护栏都长在你身上，不是外部系统；用户看到的每个页面，都是你自己的一部分。",
  },
  {
    id: "role",
    title: "岗位",
    body: "**你的主职是编码 —— 用你的能力把 ELENVA 工作台搭起来、改好。** 它是你的工作场所，也是你要交付的东西；通用助手、内容这类岗位以后会有独立 agent 承担。",
  },
  {
    id: "parts",
    title: "零件",
    body: "你身上的零件（界面上都有对应的位置）：记忆（长期 / 每日 / 待办）· 技能（按需加载的方法）· 插件（外部能力）· 子代理（并行任务）· 护栏（审批闸门 / 每轮快照 / 验证账本）。护栏保护的是你干的事，不是防着你。",
  },
  {
    id: "boundaries",
    title: "能力边界",
    body: [
      "做不到的时候，说清楚缺哪一类，不要笼统地说「做不到」：",
      "- 记不住 → 现在写进记忆",
      "- 每次都要重新查 → 沉淀成技能",
      "- 缺外部数据或操作 → 需要插件 / MCP",
      "- 重复犯错 → 升级成规则，或提议加护栏",
      "- 模态之外（图像 / 音频）→ 直接讲明，别硬凑",
    ].join("\n"),
  },
  {
    id: "growth",
    title: "成长路径",
    body: "成长路径：失败 → 记忆 → 规则。被拦一次、返工一次、验证红一次，留一条记忆；同类问题出现第二次，升级成规则。收尾时如实报出没验证的部分 —— 那里通常就是你当前最真实的短板。",
  },
];

/** 默认文档（updatedAt 用固定时间，避免每次读都变） */
export function defaultIdentityDocument(): IdentityDocument {
  return { version: IDENTITY_VERSION, updatedAt: "2026-01-01T00:00:00.000Z", sections: DEFAULT_IDENTITY_SECTIONS.map((s) => ({ ...s })) };
}

/**
 * 身份段正文拼装：固定标题 + 各段 body（空行分隔；空 body 跳过）。
 * 顺序即数组顺序 —— 编辑界面的上移/下移直接改这个顺序。
 */
export function buildIdentityText(sections: readonly IdentitySection[]): string {
  const bodies = sections.map((section) => section.body.trim()).filter(Boolean);
  if (bodies.length === 0) return "";
  return `${IDENTITY_HEADING}\n\n${bodies.join("\n\n")}`;
}

/** 预览用：宽松清洗（非法段落直接忽略）后拼出身份正文 —— 供「生效预览」边改边看 */
export function previewIdentityText(input: unknown): string {
  return buildIdentityText(normalizeSections(input) ?? []);
}

export function getIdentityPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, IDENTITY_FILE_NAME);
}

export function getIdentityHistoryDir(agentDir: string = getAgentDir()): string {
  return join(agentDir, IDENTITY_HISTORY_DIR_NAME);
}

function hashText(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex").slice(0, 12);
}

export type IdentitySource = "file" | "default" | "fallback";

export interface IdentityReadResult {
  document: IdentityDocument;
  /** file=磁盘上的有效数据；default=文件缺失，用内置默认；fallback=文件损坏，回退内置默认 */
  source: IdentitySource;
  path: string;
  /** 并发校验用的内容哈希；文件缺失时为 "absent" */
  revision: string;
  /** fallback 时的原因（仅用于界面提示） */
  error?: string;
}

/** 段落清洗：只保留合法形状；空 body 的段落会被丢弃；id 缺失/重复时补一个 */
function normalizeSections(input: unknown): IdentitySection[] | null {
  if (!Array.isArray(input)) return null;
  const used = new Set<string>();
  const out: IdentitySection[] = [];
  for (const raw of input) {
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as Record<string, unknown>;
    const body = typeof item.body === "string" ? item.body.trim() : "";
    if (!body) continue;
    const title = typeof item.title === "string" ? item.title.trim().slice(0, IDENTITY_TITLE_LIMIT) : "";
    let id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id || used.has(id)) id = `sec-${out.length + 1}-${hashText(`${title}:${body}`)}`;
    used.add(id);
    out.push({ id, title: title || "未命名", body });
  }
  return out.length > 0 ? out.slice(0, IDENTITY_MAX_SECTIONS) : null;
}

function parseDocument(raw: string): IdentityDocument | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const doc = parsed as Record<string, unknown>;
  const sections = normalizeSections(doc.sections);
  if (!sections) return null;
  return {
    version: typeof doc.version === "number" && Number.isFinite(doc.version) ? doc.version : IDENTITY_VERSION,
    updatedAt: typeof doc.updatedAt === "string" ? doc.updatedAt : new Date(0).toISOString(),
    sections,
  };
}

/** 读当前身份：磁盘有效值 → file；缺失 → 内置默认；损坏 → 内置默认（error 带原因） */
export function readIdentity(agentDir: string = getAgentDir()): IdentityReadResult {
  const path = getIdentityPath(agentDir);
  let raw: string | null = null;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    raw = null;
  }
  if (raw === null) {
    return { document: defaultIdentityDocument(), source: "default", path, revision: "absent" };
  }
  const parsed = parseDocument(raw);
  if (!parsed) {
    return {
      document: defaultIdentityDocument(),
      source: "fallback",
      path,
      revision: hashText(raw),
      error: `${IDENTITY_FILE_NAME} 内容无法解析，已回退内置默认（文件未改动）`,
    };
  }
  return { document: parsed, source: "file", path, revision: hashText(raw) };
}

/* ============================== 版本历史 ============================== */

export interface IdentityHistoryEntry {
  /** 快照文件标识（时间戳，去掉扩展名） */
  id: string;
  /** 快照产生时间（保存发生的那一刻） */
  savedAt: string;
  /** 该版本身份正文（含标题）的字符数 */
  chars: number;
  /** 段落摘要：列表里展示，不必读全文 */
  sections: { id: string; title: string }[];
}

interface IdentitySnapshotFile {
  version: number;
  savedAt: string;
  sections: IdentitySection[];
}

function snapshotFileName(date = new Date()): string {
  return `${date.toISOString().replace(/[:.]/g, "-")}.json`;
}

function isSafeHistoryId(id: unknown): id is string {
  return typeof id === "string" && /^[0-9A-Za-z._-]+$/.test(id) && !id.includes("..");
}

function readHistoryFile(dir: string, id: string): IdentitySnapshotFile | null {
  if (!isSafeHistoryId(id)) return null;
  let raw: string;
  try {
    raw = readFileSync(join(dir, `${id}.json`), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const doc = parsed as Record<string, unknown>;
  const sections = normalizeSections(doc.sections);
  if (!sections) return null;
  return {
    version: typeof doc.version === "number" ? doc.version : IDENTITY_VERSION,
    savedAt: typeof doc.savedAt === "string" ? doc.savedAt : new Date(0).toISOString(),
    sections,
  };
}

/** 把「旧值」快照到历史目录（每次保存在写盘前调用） */
function snapshotIdentity(document: IdentityDocument, agentDir: string): string | null {
  try {
    const dir = getIdentityHistoryDir(agentDir);
    mkdirSync(dir, { recursive: true });
    let base = snapshotFileName().replace(/\.json$/, "");
    let id = base;
    let n = 1;
    while (existsSync(join(dir, `${id}.json`))) {
      id = `${base}-${n}`;
      n += 1;
    }
    const payload: IdentitySnapshotFile = {
      version: IDENTITY_VERSION,
      savedAt: new Date().toISOString(),
      sections: document.sections.map((s) => ({ ...s })),
    };
    writePrivateFileAtomicSync(join(dir, `${id}.json`), `${JSON.stringify(payload, null, 2)}\n`);
    pruneIdentityHistory(agentDir);
    return id;
  } catch {
    return null;
  }
}

/** 历史列表（新→旧）；文件名即 ISO 时间，排序等价于时间排序 */
export function listIdentityHistory(agentDir: string = getAgentDir()): IdentityHistoryEntry[] {
  const dir = getIdentityHistoryDir(agentDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .filter(isSafeHistoryId)
    .sort()
    .reverse()
    .map((id) => {
      const snapshot = readHistoryFile(dir, id);
      if (!snapshot) return null;
      return {
        id,
        savedAt: snapshot.savedAt,
        chars: buildIdentityText(snapshot.sections).length,
        sections: snapshot.sections.map((s) => ({ id: s.id, title: s.title })),
      };
    })
    .filter((entry): entry is IdentityHistoryEntry => entry !== null);
}

/** 读一个历史版本（查看用） */
export function readIdentityHistory(id: string, agentDir: string = getAgentDir()): (IdentitySnapshotFile & { id: string }) | null {
  const snapshot = readHistoryFile(getIdentityHistoryDir(agentDir), id);
  return snapshot ? { ...snapshot, id } : null;
}

/** 淘汰超出 cap 的最旧快照 */
function pruneIdentityHistory(agentDir: string): void {
  const dir = getIdentityHistoryDir(agentDir);
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return;
  }
  if (names.length <= IDENTITY_HISTORY_CAP) return;
  const sorted = names.sort(); // 升序 = 旧→新
  for (const name of sorted.slice(0, names.length - IDENTITY_HISTORY_CAP)) {
    try {
      unlinkSync(join(dir, name));
    } catch {
      // 删不掉就留着，下次保存再试
    }
  }
}

/* ============================== 写入 ============================== */

export interface IdentityWriteInput {
  sections: IdentitySection[];
  /** 客户端读到的 revision；传了且不一致 → 判定并发冲突（与 /api/memory 同模式） */
  revision?: string;
}

export type IdentityWriteResult =
  | {
      ok: true;
      document: IdentityDocument;
      revision: string;
      chars: number;
      limit: number;
      /** 本次写入产生的旧值快照 id（无旧值时为 null） */
      snapshot: string | null;
    }
  | {
      ok: false;
      code: "conflict" | "over-limit" | "invalid";
      error: string;
      chars?: number;
      limit?: number;
    };

/** 校验并清洗客户端提交的段落（严格版：非法直接报错，不静默丢内容） */
function validateSections(input: unknown): { ok: true; sections: IdentitySection[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: "sections 必须是数组" };
  if (input.length === 0) return { ok: false, error: "身份至少要保留一段（可留空正文前的占位，不允许全删）" };
  if (input.length > IDENTITY_MAX_SECTIONS) return { ok: false, error: `段落过多（上限 ${IDENTITY_MAX_SECTIONS}）` };
  const used = new Set<string>();
  const sections: IdentitySection[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const raw = input[i];
    if (typeof raw !== "object" || raw === null) return { ok: false, error: `第 ${i + 1} 段格式不正确` };
    const item = raw as Record<string, unknown>;
    const body = typeof item.body === "string" ? item.body.trim() : "";
    if (!body) return { ok: false, error: `第 ${i + 1} 段正文为空` };
    if (body.length > IDENTITY_SECTION_BODY_LIMIT) {
      return { ok: false, error: `第 ${i + 1} 段过长（${body.length} 字符，上限 ${IDENTITY_SECTION_BODY_LIMIT}）` };
    }
    const title = typeof item.title === "string" ? item.title.trim() : "";
    if (title.length > IDENTITY_TITLE_LIMIT) {
      return { ok: false, error: `第 ${i + 1} 段标题过长（上限 ${IDENTITY_TITLE_LIMIT} 字符）` };
    }
    let id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id || used.has(id)) id = `sec-${i + 1}-${hashText(`${title}:${body}`)}`;
    used.add(id);
    sections.push({ id, title: title || "未命名", body });
  }
  return { ok: true, sections };
}

/**
 * 保存身份（整份替换）。
 * 顺序：并发校验 → 校验清洗 → 总量校验 → **旧值快照** → 原子写（0600）→ 淘汰历史。
 */
export function writeIdentity(input: IdentityWriteInput, agentDir: string = getAgentDir()): IdentityWriteResult {
  const current = readIdentity(agentDir);
  if (typeof input.revision === "string" && input.revision !== current.revision) {
    return { ok: false, code: "conflict", error: "身份刚被改动过（可能是另一个页面或会话），请刷新后再编辑" };
  }
  const validated = validateSections(input.sections);
  if (!validated.ok) return { ok: false, code: "invalid", error: validated.error };

  const chars = buildIdentityText(validated.sections).length;
  if (chars > IDENTITY_TOTAL_LIMIT) {
    return {
      ok: false,
      code: "over-limit",
      chars,
      limit: IDENTITY_TOTAL_LIMIT,
      error: `超出总量：${chars} / ${IDENTITY_TOTAL_LIMIT} 字符（每轮都注入，请精简）`,
    };
  }

  // 旧值快照：文件缺失时快照的是「生效中的内置默认」，保证恢复链完整
  const snapshot = snapshotIdentity(current.document, agentDir);

  const document: IdentityDocument = {
    version: IDENTITY_VERSION,
    updatedAt: new Date().toISOString(),
    sections: validated.sections,
  };
  mkdirSync(agentDir, { recursive: true });
  writePrivateFileAtomicSync(getIdentityPath(agentDir), `${JSON.stringify(document, null, 2)}\n`);

  return { ok: true, document, revision: hashText(JSON.stringify(document, null, 2) + "\n"), chars, limit: IDENTITY_TOTAL_LIMIT, snapshot };
}

/**
 * 恢复到一个历史版本。写回前同样先快照当前值（因此「恢复」本身也可再撤回）。
 * revision 是**当前值**的并发校验（与普通保存一致）。
 */
export function restoreIdentity(id: string, revision?: string, agentDir: string = getAgentDir()): IdentityWriteResult {
  const snapshot = readIdentityHistory(id, agentDir);
  if (!snapshot) return { ok: false, code: "invalid", error: "历史版本不存在或已损坏" };
  return writeIdentity({ sections: snapshot.sections, revision }, agentDir);
}

/** 权限自检用：返回文件 mode（八进制字符串）；不存在返回 null */
export function identityFileMode(agentDir: string = getAgentDir()): string | null {
  try {
    return (statSync(getIdentityPath(agentDir)).mode & 0o777).toString(8);
  } catch {
    return null;
  }
}
