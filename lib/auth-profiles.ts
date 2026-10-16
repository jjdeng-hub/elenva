import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Credential } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "@/lib/atomic-file";

/**
 * 命名凭据档（多账号，订阅类 provider 优先）。
 *
 * pi 的凭据模型是「每个 provider 在 auth.json 里只有一条凭据」（key = provider id），
 * OAuth 为 { type: "oauth", refresh, access, expires }，刷新时由内核在文件锁内做
 * 读-改-写并把轮换后的 refresh token 写回 auth.json。所以「多账号」在本内核里等于
 * **按需替换某 provider 的凭据条目**，不是并存。
 *
 * 本模块只存**指向**与凭据副本：
 *   - 索引 `~/.pi/agent/elenva-auth-profiles.json`：档名 / provider / 类型 / 时间 / 备注 / 指纹；
 *   - 凭据本体 `~/.pi/agent/elenva-auth-backups/<档 id>.json`（0600，原子写）。
 * 任何 API / UI 都不得读取或返回凭据内容，只能用指纹判断「当前生效的是哪一档」。
 *
 * 写入链安全：所有对 auth.json 的写入都复用 pi 自己的 proper-lockfile 锁 + 原子替换；
 * 切换前先把当前凭据自动备份成 `auto-<时间>`，写失败则回滚，因此切换可逆。
 */

const INDEX_VERSION = 1;
/** 自动备份滚动上限，避免每次切换无限增长 */
const MAX_AUTO_BACKUPS = 20;
const MAX_LABEL_LENGTH = 60;
const MAX_NOTE_LENGTH = 160;
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

const AUTH_FILE_WRITE_OPTIONS = { encoding: "utf-8" as const, mode: 0o600 };

export type AuthProfileKind = "named" | "auto";

export interface AuthProfile {
  /** 稳定 id，同时是凭据本体文件名（`<id>.json`） */
  id: string;
  /** 用户可读档名 */
  label: string;
  provider: string;
  /** 保存时的凭据类型（api_key / oauth） */
  type: string;
  createdAt: string;
  updatedAt: string;
  note?: string;
  /** 凭据内容的指纹（sha256 前 16 位），用于判断「当前生效」；不含明文 */
  fingerprint: string;
  kind: AuthProfileKind;
}

export interface AuthProfilesIndex {
  version: number;
  /** provider → 最近一次由本功能切到的档 id */
  active: Record<string, string>;
  profiles: AuthProfile[];
}

export interface AuthProfilesPaths {
  agentDir: string;
  authPath: string;
  indexPath: string;
  backupDir: string;
}

export interface CurrentAuthFingerprint {
  type: string;
  fingerprint: string;
}

export interface AuthProfilesListing {
  profiles: AuthProfile[];
  /** provider → 当前生效档 id（按指纹比对，未匹配为 null） */
  active: Record<string, string | null>;
  /** provider → 当前 auth.json 中凭据的类型与指纹（无明文） */
  current: Record<string, CurrentAuthFingerprint>;
  authPath: string;
  backupDir: string;
}

export interface SwitchResult {
  provider: string;
  /** 切换前自动备份的档 id；切换前该 provider 无凭据时为 null */
  autoBackupId: string | null;
  /** 被顶替的凭据类型；无则 null */
  previousType: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function resolveAuthProfilesPaths(agentDir = getAgentDir()): AuthProfilesPaths {
  return {
    agentDir,
    authPath: join(agentDir, "auth.json"),
    indexPath: join(agentDir, "elenva-auth-profiles.json"),
    backupDir: join(agentDir, "elenva-auth-backups"),
  };
}

/** 与 pi 的 ReadOnlyAuthStorage 同口径的凭据校验，避免把坏数据写进 auth.json */
export function isValidCredential(value: unknown): value is Credential {
  if (!isRecord(value)) return false;
  if (value.type === "api_key") {
    if (value.key !== undefined && typeof value.key !== "string") return false;
    if (value.env !== undefined) {
      if (!isRecord(value.env)) return false;
      if (!Object.values(value.env).every((entry) => typeof entry === "string")) return false;
    }
    return true;
  }
  if (value.type === "oauth") {
    return (
      typeof value.access === "string" &&
      typeof value.refresh === "string" &&
      typeof value.expires === "number" &&
      Number.isFinite(value.expires)
    );
  }
  return false;
}

/** 稳定序列化（键排序），供指纹使用；不含明文导出 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

/** 凭据指纹（sha256 前 16 位十六进制）——只用于比对，不可逆推凭据 */
export function fingerprintCredential(credential: unknown): string {
  return createHash("sha256").update(stableStringify(credential)).digest("hex").slice(0, 16);
}

/** 由档名与 provider 生成稳定 id：英文走 slug，中文等退化为 provider + 短哈希 */
export function profileIdFor(label: string, provider: string): string {
  const hash = createHash("sha256").update(`${provider}\u0000${label}`).digest("hex").slice(0, 8);
  const fallback = provider.toLowerCase().replace(/[^a-z0-9-]+/g, "-") || "profile";
  // 非 ASCII（中文档名等）退化为 provider 前缀，避免 slug 退化成单个字母
  const slug = /[^\x00-\x7f]/.test(label)
    ? ""
    : label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 24);
  return `${slug.length >= 2 ? slug : fallback}-${hash}`;
}

function assertProviderId(provider: string): void {
  if (!provider || !PROVIDER_ID_PATTERN.test(provider)) {
    throw new Error("非法的 provider id");
  }
}

function normalizeLabel(label: string): string {
  const trimmed = typeof label === "string" ? label.trim() : "";
  if (!trimmed) throw new Error("档名不能为空");
  if (trimmed.length > MAX_LABEL_LENGTH) throw new Error(`档名过长（最多 ${MAX_LABEL_LENGTH} 字）`);
  return trimmed;
}

function normalizeNote(note: string | undefined): string | undefined {
  if (note === undefined) return undefined;
  const trimmed = String(note).trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_NOTE_LENGTH) throw new Error(`备注过长（最多 ${MAX_NOTE_LENGTH} 字）`);
  return trimmed;
}

export function readAuthProfilesIndex(agentDir = getAgentDir()): AuthProfilesIndex {
  const { indexPath } = resolveAuthProfilesPaths(agentDir);
  if (!existsSync(indexPath)) return { version: INDEX_VERSION, active: {}, profiles: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(readFileSync(indexPath, "utf-8")));
  } catch (error) {
    // 索引损坏不应让「看清账号」整页挂掉；按空索引处理，写入时会重建。
    void error;
    return { version: INDEX_VERSION, active: {}, profiles: [] };
  }
  if (!isRecord(parsed)) return { version: INDEX_VERSION, active: {}, profiles: [] };
  const profiles = Array.isArray(parsed.profiles)
    ? parsed.profiles.filter((entry): entry is AuthProfile => {
        if (!isRecord(entry)) return false;
        return typeof entry.id === "string" && typeof entry.provider === "string" && typeof entry.label === "string";
      })
    : [];
  const active: Record<string, string> = {};
  if (isRecord(parsed.active)) {
    for (const [provider, id] of Object.entries(parsed.active)) {
      if (typeof id === "string") active[provider] = id;
    }
  }
  return { version: INDEX_VERSION, active, profiles };
}

function writeAuthProfilesIndex(index: AuthProfilesIndex, agentDir = getAgentDir()): void {
  const { indexPath } = resolveAuthProfilesPaths(agentDir);
  mkdirSync(dirname(indexPath), { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
}

function ensureBackupDir(backupDir: string): void {
  if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true, mode: 0o700 });
}

export function getProfileBodyPath(id: string, agentDir = getAgentDir()): string {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) throw new Error("非法的档 id");
  return join(resolveAuthProfilesPaths(agentDir).backupDir, `${id}.json`);
}

function writeProfileBody(id: string, credential: Credential, agentDir = getAgentDir()): void {
  const { backupDir } = resolveAuthProfilesPaths(agentDir);
  ensureBackupDir(backupDir);
  writePrivateFileAtomicSync(getProfileBodyPath(id, agentDir), `${JSON.stringify(credential, null, 2)}\n`);
}

function readProfileBody(entry: AuthProfile, agentDir = getAgentDir()): Credential {
  const bodyPath = getProfileBodyPath(entry.id, agentDir);
  if (!existsSync(bodyPath)) throw new Error(`凭据档文件缺失：${entry.id}.json`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(readFileSync(bodyPath, "utf-8")));
  } catch (error) {
    throw new Error(`凭据档文件损坏（${entry.id}.json）：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isValidCredential(parsed)) throw new Error(`凭据档内容不合法（${entry.id}.json）`);
  return parsed;
}

function deleteProfileBody(id: string, agentDir = getAgentDir()): void {
  const bodyPath = getProfileBodyPath(id, agentDir);
  try {
    unlinkSync(bodyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * 读取 auth.json。缺文件返回空对象；存在但无法解析 / 结构不对则抛错——
 * 写路径必须知道「当前究竟是什么」，不能把坏文件当空文件覆盖。
 */
export function readLiveAuthData(authPath = resolveAuthProfilesPaths().authPath): Record<string, Credential> {
  if (!existsSync(authPath)) return {};
  const raw = stripBom(readFileSync(authPath, "utf-8")).trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`auth.json 无法解析，已拒绝写入：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new Error("auth.json 结构异常（应为对象），已拒绝写入");
  return parsed as Record<string, Credential>;
}

/** 只读：provider → { type, fingerprint }，不返回任何凭据内容 */
export function readCurrentAuthFingerprints(agentDir = getAgentDir()): Record<string, CurrentAuthFingerprint> {
  let data: Record<string, Credential>;
  try {
    data = readLiveAuthData(resolveAuthProfilesPaths(agentDir).authPath);
  } catch {
    return {};
  }
  const out: Record<string, CurrentAuthFingerprint> = {};
  for (const [provider, credential] of Object.entries(data)) {
    if (!isRecord(credential)) continue;
    out[provider] = {
      type: typeof credential.type === "string" ? credential.type : "unknown",
      fingerprint: fingerprintCredential(credential),
    };
  }
  return out;
}

function writeFileSyncPrivate(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(path, contents);
}

/** 测试钩子：让下一次写 auth.json 失败，用来验证回滚路径（生产代码不设置） */
let failNextLiveWrite: string | undefined;
export function __setFailNextLiveWriteForTest(message: string | undefined): void {
  failNextLiveWrite = message;
}

/**
 * 在 pi 自己的文件锁内原子替换某 provider 的凭据；写失败时在同一把锁内用**原始字节**回滚。
 * 同一把锁保证回滚不会被其它写入插队，字节级恢复不会破坏 auth.json 现有格式。
 */
async function writeLiveCredential(provider: string, credential: Credential, authPath: string): Promise<void> {
  const parent = dirname(authPath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (!existsSync(authPath)) writeFileSyncPrivate(authPath, "{}");

  let lockCompromisedError: Error | undefined;
  const release = await lockfile.lock(authPath, {
    retries: { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 10_000, randomize: true },
    stale: 30_000,
    onCompromised: (error) => {
      lockCompromisedError = error;
    },
  });
  const throwIfCompromised = () => {
    if (lockCompromisedError) throw lockCompromisedError;
  };
  try {
    throwIfCompromised();
    const originalText = readFileSync(authPath, "utf-8");
    const credentials = readLiveAuthData(authPath);
    credentials[provider] = credential;
    try {
      if (failNextLiveWrite) {
        const message = failNextLiveWrite;
        failNextLiveWrite = undefined;
        throw new Error(message);
      }
      throwIfCompromised();
      writePrivateFileAtomicSync(authPath, `${JSON.stringify(credentials, null, 2)}\n`);
    } catch (error) {
      // 字节级回滚（同一把锁内）：失败时 auth.json 与切换前完全一致
      writePrivateFileAtomicSync(authPath, originalText);
      throw error;
    }
  } finally {
    try {
      await release();
    } catch {
      // 锁已损坏时，上面的错误更有用
    }
  }
}

function now(): string {
  return new Date().toISOString();
}

/** 只读列表：档 + 当前生效标记（按指纹比对，跨 provider 唯一生效） */
export function listAuthProfiles(agentDir = getAgentDir()): AuthProfilesListing {
  const index = readAuthProfilesIndex(agentDir);
  const current = readCurrentAuthFingerprints(agentDir);
  const { authPath, backupDir } = resolveAuthProfilesPaths(agentDir);
  const profiles = [...index.profiles].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  // 按指纹而非索引里的 active 字段判定「当前生效」：被 /login 覆盖或内核刷新后不会误标。
  // 同一指纹可能同时存在于命名档与自动备份中，优先取索引指向的档，其次取命名档。
  const activeIdByProvider: Record<string, string | null> = {};
  for (const [provider, live] of Object.entries(current)) {
    const matches = profiles.filter((profile) => profile.provider === provider && profile.fingerprint === live.fingerprint);
    const hinted = index.active[provider];
    const hit =
      matches.find((profile) => profile.id === hinted) ??
      matches.find((profile) => profile.kind === "named") ??
      matches[0] ??
      null;
    activeIdByProvider[provider] = hit?.id ?? null;
  }
  return { profiles, active: activeIdByProvider, current, authPath, backupDir };
}

/** 当前生效档 id（按指纹比对，未匹配返回 null） */
export function resolveActiveProfileId(
  provider: string,
  listing?: AuthProfilesListing,
  agentDir = getAgentDir(),
): string | null {
  const data = listing ?? listAuthProfiles(agentDir);
  return data.active[provider] ?? null;
}

/** 把当前 auth.json 里的凭据存成命名档（等于备份） */
export async function saveCurrentAsProfile(
  provider: string,
  label: string,
  note?: string,
  agentDir = getAgentDir(),
): Promise<AuthProfile> {
  assertProviderId(provider);
  const normalizedLabel = normalizeLabel(label);
  const normalizedNote = normalizeNote(note);
  const { authPath } = resolveAuthProfilesPaths(agentDir);

  const live = readLiveAuthData(authPath);
  const credential = live[provider];
  if (!credential) throw new Error("该厂商当前没有已保存的凭据，无法存档");
  if (!isValidCredential(credential)) throw new Error("当前凭据结构不合法，已拒绝存档");

  const index = readAuthProfilesIndex(agentDir);
  const id = profileIdFor(normalizedLabel, provider);
  const existing = index.profiles.find((entry) => entry.id === id);
  const timestamp = now();
  const entry: AuthProfile = {
    id,
    label: normalizedLabel,
    provider,
    type: credential.type,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    note: normalizedNote ?? existing?.note,
    fingerprint: fingerprintCredential(credential),
    kind: "named",
  };

  writeProfileBody(id, credential, agentDir);
  const rest = index.profiles.filter((item) => item.id !== id);
  index.profiles = [...rest, entry];
  // 刚存的档就是当前生效凭据
  index.active[provider] = id;
  writeAuthProfilesIndex(index, agentDir);
  return entry;
}

export async function updateProfileNote(id: string, note: string | undefined, agentDir = getAgentDir()): Promise<AuthProfile> {
  const index = readAuthProfilesIndex(agentDir);
  const entry = index.profiles.find((profile) => profile.id === id);
  if (!entry) throw new Error("凭据档不存在");
  entry.note = normalizeNote(note);
  entry.updatedAt = now();
  writeAuthProfilesIndex(index, agentDir);
  return entry;
}

export async function deleteAuthProfile(id: string, agentDir = getAgentDir()): Promise<void> {
  const index = readAuthProfilesIndex(agentDir);
  const entry = index.profiles.find((profile) => profile.id === id);
  if (!entry) throw new Error("凭据档不存在");
  index.profiles = index.profiles.filter((profile) => profile.id !== id);
  if (index.active[entry.provider] === id) delete index.active[entry.provider];
  writeAuthProfilesIndex(index, agentDir);
  deleteProfileBody(id, agentDir);
}

function pruneAutoBackups(index: AuthProfilesIndex, agentDir: string): void {
  const autos = index.profiles
    .filter((profile) => profile.kind === "auto")
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const overflow = autos.length - MAX_AUTO_BACKUPS;
  if (overflow <= 0) return;
  const drop = new Set(autos.slice(0, overflow).map((profile) => profile.id));
  index.profiles = index.profiles.filter((profile) => !drop.has(profile.id));
  for (const id of drop) deleteProfileBody(id, agentDir);
}

/** 把当前凭据备份成 `auto-<时间>` 档（切换前调用），返回索引条目 */
function createAutoBackupEntry(provider: string, credential: Credential): AuthProfile {
  const stamp = now().replace(/[:.]/g, "-");
  return {
    id: `auto-${stamp}`,
    label: `自动备份 ${new Date().toLocaleString("zh-CN")}`,
    provider,
    type: credential.type,
    createdAt: now(),
    updatedAt: now(),
    fingerprint: fingerprintCredential(credential),
    kind: "auto",
    note: "切换前自动备份（可切回）",
  };
}

/**
 * 切换到某个命名档：
 *   1) 先把当前凭据自动备份为 auto-<时间>（可回退）；
 *   2) 若上一个生效档是 OAuth 且当前凭据与它不同，回收内核刷新后的令牌到该档（防轮换失效）；
 *   3) 在文件锁内原子替换该 provider 的凭据，失败则回滚为切换前状态。
 */
export async function switchToAuthProfile(id: string, agentDir = getAgentDir()): Promise<SwitchResult> {
  const { authPath } = resolveAuthProfilesPaths(agentDir);
  const index = readAuthProfilesIndex(agentDir);
  const entry = index.profiles.find((profile) => profile.id === id);
  if (!entry) throw new Error("凭据档不存在");
  if (!entry.provider || !PROVIDER_ID_PATTERN.test(entry.provider)) throw new Error("凭据档 provider 非法");

  // 目标档可能在索引之后被手工改坏——先校验，避免切换一半才失败
  const targetCredential = readProfileBody(entry, agentDir);

  const live = readLiveAuthData(authPath);
  const previous = live[entry.provider];
  const provider = entry.provider;

  // 1) 自动备份当前凭据
  let autoEntry: AuthProfile | null = null;
  if (previous && isValidCredential(previous)) {
    const created = createAutoBackupEntry(provider, previous);
    writeProfileBody(created.id, previous, agentDir);
    index.profiles = [...index.profiles.filter((profile) => profile.id !== created.id), created];
    pruneAutoBackups(index, agentDir);
    autoEntry = created;
  }

  // 2) 回收「上一个生效档」上被内核刷新过的 OAuth 令牌
  const previousActiveId = index.active[provider];
  if (previousActiveId && previousActiveId !== id && previous && isValidCredential(previous)) {
    const previousActive = index.profiles.find((profile) => profile.id === previousActiveId);
    if (
      previousActive &&
      previousActive.kind === "named" &&
      previousActive.type === "oauth" &&
      previous.type === "oauth"
    ) {
      writeProfileBody(previousActive.id, previous, agentDir);
      previousActive.fingerprint = fingerprintCredential(previous);
      previousActive.updatedAt = now();
    }
  }

  // 先落索引（含自动备份与令牌回收），再动 auth.json；这样即使写入失败，备份也已在册
  if (autoEntry || previousActiveId) writeAuthProfilesIndex(index, agentDir);

  // 3) 在文件锁内原子替换；失败在同一把锁内字节级回滚
  try {
    await writeLiveCredential(provider, targetCredential, authPath);
  } catch (error) {
    throw new Error(`切换失败，已回滚为切换前状态：${error instanceof Error ? error.message : String(error)}`);
  }

  const latest = readAuthProfilesIndex(agentDir);
  latest.active[provider] = id;
  writeAuthProfilesIndex(latest, agentDir);
  return { provider, autoBackupId: autoEntry?.id ?? null, previousType: previous?.type ?? null };
}
