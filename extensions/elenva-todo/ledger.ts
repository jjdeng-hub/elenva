/**
 * elenva-todo 的**侧账本** —— 记录每条 open 待办「第一次被看到」的时间。
 *
 * ## 为什么需要它
 *
 * 清单本身不落盘（存 tool result details，随分支重建，见 state.ts 头注释），
 * 所以「这条待办停了多久」这个信息在会话文件里根本不存在 —— 没有 firstSeen，
 * 就判断不了「逾期」。账本是**旁路数据**：只记 open 条目的首见 / 末见时间戳，
 * 供服务端算出「最老的一条停了几天」并在工作台标出（模块 3 第 3 轮）。
 *
 * ## 口径
 *
 * - firstSeen 从**扩展观察到的第一次出现**起算，不是条目被创建的时刻
 *   （扩展只在 todo_write 成功时观察，中间可能跨轮、跨会话重开）。
 * - 账本损坏 / 写失败**只影响逾期提示本身**，绝不影响 todo_write（调用侧全程 try/ignore）。
 * - completed 或从清单里消失的条目**立即移除**——账本只反映当前的 open 待办。
 *
 * 文件：`<agentRoot>/elenva-todo-ledger.json`
 *   `{ version: 1, sessions: { [sessionId]: { [itemKey]: { firstSeen, lastSeen } } } }`
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const LEDGER_VERSION = 1;
/** 每会话最多记多少条 open 待办（todo_write 本身限 20 项，这里同口径兜底） */
export const MAX_ITEMS_PER_SESSION = 20;
/** 全局最多记多少会话（超限丢「最近活动最旧」的会话） */
export const MAX_SESSIONS = 300;
/** 条目键最长 160 字（与 todo_write 单项上限一致） */
export const ITEM_KEY_MAX_LENGTH = 160;

export interface LedgerStamp {
  /** 第一次观察到的时刻（ISO） */
  firstSeen: string;
  /** 最近一次观察到的时刻（ISO） */
  lastSeen: string;
}

export interface TodoLedger {
  version: 1;
  sessions: Record<string, Record<string, LedgerStamp>>;
}

/** 待办条目的最小形状（只关心 text / status，不依赖 state.ts，保持零依赖） */
export interface ObservedTodo {
  text: string;
  status: string;
}

export function agentRootDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) return path.join(os.homedir(), ".pi", "agent");
  return path.resolve(
    configured.startsWith("~") ? path.join(os.homedir(), configured.slice(1)) : configured,
  );
}

export function getLedgerPath(agentRoot = agentRootDir()): string {
  return path.join(agentRoot, "elenva-todo-ledger.json");
}

/**
 * 条目键：trim + 把连续空白压成一个空格 + 截断到 160 字。
 * 服务端读取侧必须用**同一口径**（lib/todo-ledger.ts 的 normalizeItemKey）。
 */
export function normalizeItemKey(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, ITEM_KEY_MAX_LENGTH);
}

function isStamp(value: unknown): value is LedgerStamp {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as LedgerStamp).firstSeen === "string" &&
    typeof (value as LedgerStamp).lastSeen === "string"
  );
}

function emptyLedger(): TodoLedger {
  return { version: LEDGER_VERSION, sessions: {} };
}

/** 容错解析：文件缺失 / 坏 JSON / 字段缺省 → 空账本；逐条丢弃坏 entry。 */
export function readLedger(file = getLedgerPath()): TodoLedger {
  let parsed: unknown;
  try {
    if (!fs.existsSync(file)) return emptyLedger();
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return emptyLedger();
  }
  if (parsed === null || typeof parsed !== "object") return emptyLedger();
  const sessionsRaw = (parsed as { sessions?: unknown }).sessions;
  if (sessionsRaw === null || typeof sessionsRaw !== "object" || Array.isArray(sessionsRaw)) {
    return emptyLedger();
  }
  const sessions: Record<string, Record<string, LedgerStamp>> = {};
  for (const [sessionId, itemsRaw] of Object.entries(sessionsRaw as Record<string, unknown>)) {
    if (!sessionId || itemsRaw === null || typeof itemsRaw !== "object" || Array.isArray(itemsRaw)) {
      continue;
    }
    const items: Record<string, LedgerStamp> = {};
    for (const [key, stamp] of Object.entries(itemsRaw as Record<string, unknown>)) {
      if (!key || !isStamp(stamp)) continue;
      items[key] = { firstSeen: stamp.firstSeen, lastSeen: stamp.lastSeen };
    }
    if (Object.keys(items).length > 0) sessions[sessionId] = items;
  }
  return { version: LEDGER_VERSION, sessions };
}

/** 原子写（临时文件 + rename，0600）：失败抛出，由 observeTodos 兜住。 */
export function writeLedger(ledger: TodoLedger, file = getLedgerPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 已 rename 走 / 本来就没建成功 —— 都不必处理 */
    }
  }
}

/** 会话的「最近活动」时刻（ISO 字典序即时间序）；空条目返回空串。 */
function latestLastSeen(items: Record<string, LedgerStamp>): string {
  let latest = "";
  for (const stamp of Object.values(items)) {
    if (stamp.lastSeen > latest) latest = stamp.lastSeen;
  }
  return latest;
}

/**
 * 纯函数：把一次 todo_write 的观察结果并进账本，返回**新账本**（不改入参）。
 *
 * - open（pending / in_progress）：已有条目保留 firstSeen、刷新 lastSeen；新条目两者都盖 now。
 * - completed 或未出现在本次清单里的条目：移除。
 * - 每会话 ≤20 条（超限丢 lastSeen 最旧的）；全局 ≤300 会话（超限丢最近活动最旧的）。
 */
export function observeLedger(
  ledger: TodoLedger,
  sessionId: string,
  items: readonly ObservedTodo[],
  now: string,
): TodoLedger {
  const id = sessionId.trim();
  const sessions: Record<string, Record<string, LedgerStamp>> = { ...ledger.sessions };
  if (!id) return { version: LEDGER_VERSION, sessions };

  const prev = sessions[id] ?? {};
  const next: Record<string, LedgerStamp> = {};
  for (const item of items) {
    if (item.status === "completed") continue;
    const key = normalizeItemKey(item.text);
    if (!key) continue;
    // 同一批里出现重复文本：保留先出现的那条（firstSeen 取更早的）
    if (next[key]) continue;
    const before = prev[key];
    next[key] = { firstSeen: before?.firstSeen ?? now, lastSeen: now };
  }

  // 每会话封顶：丢 lastSeen 最旧的
  const keys = Object.keys(next);
  if (keys.length > MAX_ITEMS_PER_SESSION) {
    keys
      .sort((a, b) => (next[a].lastSeen === next[b].lastSeen ? 0 : next[a].lastSeen < next[b].lastSeen ? -1 : 1))
      .slice(0, keys.length - MAX_ITEMS_PER_SESSION)
      .forEach((key) => delete next[key]);
  }

  if (Object.keys(next).length === 0) delete sessions[id];
  else sessions[id] = next;

  // 全局会话数封顶：丢最近活动最旧的（连带它整条记录）
  const sessionIds = Object.keys(sessions);
  if (sessionIds.length > MAX_SESSIONS) {
    sessionIds
      .sort((a, b) => {
        const la = latestLastSeen(sessions[a]);
        const lb = latestLastSeen(sessions[b]);
        return la === lb ? 0 : la < lb ? -1 : 1;
      })
      .slice(0, sessionIds.length - MAX_SESSIONS)
      .forEach((sid) => delete sessions[sid]);
  }

  return { version: LEDGER_VERSION, sessions };
}

/**
 * 对外入口：观察一次 todo_write 并持久化。
 *
 * **任何失败都吞掉**——账本是旁路数据，写不进去最多是逾期提示不准，不能反过来把
 * todo_write 本体搞挂（调用点无需再包 try/catch）。
 */
export function observeTodos(
  sessionId: string | null | undefined,
  items: readonly ObservedTodo[] | null | undefined,
  options: { file?: string; now?: string } = {},
): void {
  try {
    if (!sessionId || !Array.isArray(items)) return;
    const file = options.file ?? getLedgerPath();
    const now = options.now ?? new Date().toISOString();
    writeLedger(observeLedger(readLedger(file), sessionId, items, now), file);
  } catch {
    /* ignore：旁路数据不影响 todo_write */
  }
}
