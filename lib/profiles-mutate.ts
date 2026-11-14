/**
 * Hermes profile 变更层（P3b：创建 / 删除 / 归档回收站）。
 *
 * 规格见 docs/specs/2026-11-12-profile-management.md 三、四节：
 * - 创建：先建后写，**任一步失败 → 删除本次新建的目录**（仅限本次创建），不留半成品
 * - 删除：四重保护（先归档 → 输入 id 确认 → 拒绝 default / 正在跑 / gateway 在用 → 删后收尾）
 * - 所有写操作串行化（全局锁），避免两个请求同时 create/delete 同名
 * - 审计：每次写操作一行 ~/.elenva/audit.jsonl
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { load as parseYaml, dump as dumpYaml } from "js-yaml";
import { agentsRoot } from "./agents/registry";
import { hermesHome } from "./hermes-home";
import {
  appendAudit,
  discoverProfiles,
  invalidateProfilesCache,
  PROFILE_ID_RE,
  type ProfileEntry,
} from "./profiles";

const execFileAsync = promisify(execFile);

const HERMES_TIMEOUT_MS = 120_000;

export function hermesRoot(): string {
  // 与发现层同源：HERMES_HOME → 平台默认（Windows 是 %LOCALAPPDATA%\hermes）→ ~/.hermes
  return hermesHome();
}

function profileDir(profileId: string): string {
  return path.join(hermesRoot(), "profiles", profileId);
}

function backupsRoot(): string {
  return path.join(hermesRoot(), "backups", "profiles");
}

function elenvaAgentDir(profileId: string): string {
  return path.join(agentsRoot(), profileId);
}

/* ---------------- 全局写锁：create / delete / import 串行 ---------------- */

let chain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

/* ---------------- hermes CLI 子进程 ---------------- */

async function runHermes(
  args: string[],
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("hermes", args, {
      timeout: HERMES_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, stdout };
  } catch (error) {
    const err = error as { stderr?: string; stdout?: string; message?: string; killed?: boolean };
    const detail = err.stderr?.trim() || err.stdout?.trim() || err.message || String(error);
    return { ok: false, error: err.killed ? `hermes 超时（120s）：${detail}` : detail };
  }
}

/* ---------------- profile 状态探查（删除前的拒绝条件） ---------------- */

const ACP_HOST = process.env.ELENVA_ACP_HOST?.trim() || "http://127.0.0.1:30201";

/** 该 profile 是否有 ACP / ELENVA 会话正在持有或运行（non-dead 即视为占用）。 */
async function profileBusy(profileId: string): Promise<string | null> {
  try {
    // ACP 宿主的存活/状态端点是 /health（/agents 不存在）
    const res = await fetch(`${ACP_HOST}/health`, { signal: AbortSignal.timeout(3000), cache: "no-store" });
    if (res.ok) {
      const data = (await res.json()) as { agents?: Array<{ profile?: string; state?: string; agentId?: string }> };
      const entry = data.agents?.find((a) => a.profile === profileId || (a.profile == null && a.agentId === profileId));
      if (entry && entry.state && entry.state !== "dead" && entry.state !== "stopped") {
        return `该 profile 有 ACP 会话正在运行（状态 ${entry.state}），请先停掉会话再删除`;
      }
    }
  } catch {
    /* ACP 宿主不可用不阻塞删除 —— 它说明没有活跃会话 */
  }
  return null;
}

/** 该 profile 是否被 live gateway 服务中（systemctl --user is-active + gateway_state.json 的平台键）。 */
async function gatewayServing(profileId: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("systemctl", ["--user", "is-active", "hermes-gateway.service"], {
      timeout: 5000,
    });
    if (stdout.trim() !== "active") return null;
    // gateway 活着：看 gateway_state.json 的平台键里有没有这个 profile（形如 `<id>:<platform>`）
    try {
      const state = JSON.parse(
        fs.readFileSync(path.join(hermesRoot(), "gateway_state.json"), "utf8"),
      ) as { platforms?: Record<string, unknown> };
      const keys = Object.keys(state.platforms ?? {});
      if (keys.some((key) => key === profileId || key.startsWith(`${profileId}:`))) {
        return `该 profile 正被 gateway 服务（hermes-gateway.service）：消息平台在用，请先 systemctl --user stop hermes-gateway 再删除`;
      }
      return null;
    } catch {
      // gateway 状态文件读不了时保守处理：gateway 活着就不敢删
      return "gateway 服务正在运行且状态文件不可读，无法确认该 profile 是否在用；请先 systemctl --user stop hermes-gateway 再删除";
    }
  } catch {
    return null; // systemctl 不可用 / 服务不存在：不在服务中
  }
}

/* ---------------- 创建（异步任务） ---------------- */

export interface CreateProfileParams {
  id: string;
  displayName: string;
  soul: string;
  cloneFrom?: string;
  model?: string;
  connect?: boolean;
}

export interface ProfileJob {
  jobId: string;
  kind: "create";
  profile: string;
  status: "running" | "done" | "error";
  step: string;
  error?: string;
  startedAt: string;
}

const jobs = new Map<string, ProfileJob>();

export function getProfileJob(jobId: string): ProfileJob | null {
  return jobs.get(jobId) ?? null;
}

let jobSeq = 0;

/** 启动创建任务（立即返回 jobId；进度走 getProfileJob）。校验失败同步抛 ApiError。 */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function startCreateProfile(params: CreateProfileParams): { jobId: string } {
  const id = params.id.trim();
  if (!PROFILE_ID_RE.test(id)) {
    throw new ApiError(400, `profile id 不合法：${id || "(空)"}（规则：小写字母开头，仅小写字母 / 数字 / 连字符，3~31 位）`);
  }
  if (id === "default") throw new ApiError(400, "default 是 Hermes 主 profile，不能重名创建");
  if (fs.existsSync(profileDir(id))) {
    throw new ApiError(409, `磁盘上已存在该 profile：${id}`);
  }
  if (params.cloneFrom) {
    const src = params.cloneFrom.trim();
    if (!PROFILE_ID_RE.test(src)) throw new ApiError(400, `clone 来源 id 不合法：${src}`);
    if (!fs.existsSync(profileDir(src)) && !fs.existsSync(hermesRoot())) {
      throw new ApiError(400, `clone 来源 profile 不存在：${src}`);
    }
    if (!fs.existsSync(profileDir(src)) && src !== "default") {
      throw new ApiError(400, `clone 来源 profile 不存在：${src}`);
    }
  }

  const jobId = `create-${Date.now().toString(36)}-${(jobSeq++).toString(36)}`;
  const job: ProfileJob = {
    jobId,
    kind: "create",
    profile: id,
    status: "running",
    step: "排队中",
    startedAt: new Date().toISOString(),
  };
  jobs.set(jobId, job);
  // 任务表防膨胀：只留最近 50 条
  if (jobs.size > 50) {
    for (const key of jobs.keys()) {
      jobs.delete(key);
      if (jobs.size <= 50) break;
    }
  }

  void withLock(() => runCreateJob(job, params)).catch(() => undefined);
  return { jobId };
}

async function runCreateJob(job: ProfileJob, params: CreateProfileParams): Promise<void> {
  const id = job.profile;
  const dir = profileDir(id);
  // 回滚口径：只要这个目录在我们失败时存在，就删（它是本次 hermes create 刚建出来的）
  let created = false;

  /**
   * 删除本次新建的目录。hermes profile create 的直接子进程退出后，可能还有落尾
   * 进程晚几秒把 state.db 写回来（实测 12:19:53 回滚、12:19:57 又出现 state.db），
   * 所以带重试：删完等 1 秒，还在就再删，最多 ~20 秒。
   */
  const rollbackCreatedDir = async (): Promise<string> => {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (rmError) {
        return `回滚失败，残留目录需手动删除：${dir}（${String(rmError)}）`;
      }
      if (!fs.existsSync(dir)) return "已回滚：删除本次新建的 profiles/" + id;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return fs.existsSync(dir)
      ? `回滚重试后目录仍存在（hermes 落尾进程持续写入），残留目录需手动删除：${dir}`
      : "已回滚：删除本次新建的 profiles/" + id;
  };

  const fail = async (message: string): Promise<void> => {
    job.status = "error";
    job.error = message;
    if (created && fs.existsSync(dir)) {
      job.step = "失败回滚中";
      job.error = `${message}（${await rollbackCreatedDir()}）`;
    }
    invalidateProfilesCache();
    appendAudit({ ts: new Date().toISOString(), action: "create", profile: id, result: "error", detail: job.error });
  };

  try {
    // 1) hermes profile create
    job.step = "运行 hermes profile create（拷贝 skills，约 5~20 秒）";
    const args = ["profile", "create", id, "--no-alias"];
    if (params.cloneFrom) args.push("--clone-from", params.cloneFrom.trim());
    const created1 = await runHermes(args);
    created = created1.ok; // create 成功即视为目录已由本次产生
    if (!created1.ok) return fail(`hermes profile create 失败：${created1.error}`);

    // 2) 写 SOUL.md：首行标题 + 空行 + 正文
    job.step = "写 SOUL.md";
    try {
      const title = `# SOUL - ${params.displayName.trim() || id}`;
      const body = params.soul.trim() || "（待补充这个 Agent 的性格与职责。）";
      fs.writeFileSync(path.join(dir, "SOUL.md"), `${title}\n\n${body}\n`, "utf8");
    } catch (error) {
      return fail(`写 SOUL.md 失败：${String(error)}`);
    }

    // 3) 若传 model：用 js-yaml 读写 config.yaml 的 model.default
    if (params.model?.trim()) {
      job.step = `写 config.yaml（model=${params.model.trim()}）`;
      try {
        const configPath = path.join(dir, "config.yaml");
        const doc = parseYaml(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
        if (!doc || typeof doc !== "object") throw new Error("config.yaml 不是映射");
        const model = (doc.model ?? {}) as Record<string, unknown>;
        model.default = params.model.trim();
        doc.model = model;
        fs.writeFileSync(configPath, dumpYaml(doc, { lineWidth: -1 }), "utf8");
      } catch (error) {
        return fail(`写 config.yaml 失败：${String(error)}`);
      }
    }

    // 4) connect=true → 写 ELENVA manifest（接入）
    if (params.connect !== false) {
      job.step = "写 manifest（接入 ELENVA）";
      try {
        fs.mkdirSync(elenvaAgentDir(id), { recursive: true });
        const manifest = { id, name: params.displayName.trim() || id, runtime: "hermes", profile: id, version: "0.1.0" };
        fs.writeFileSync(path.join(elenvaAgentDir(id), "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
      } catch (error) {
        return fail(`写 manifest 失败：${String(error)}`);
      }
    }

    job.step = "完成";
    job.status = "done";
    invalidateProfilesCache();
    appendAudit({
      ts: new Date().toISOString(),
      action: "create",
      profile: id,
      result: "ok",
      detail: params.cloneFrom ? `clone-from=${params.cloneFrom.trim()}` : "空白模板",
    });
  } catch (error) {
    await fail(String(error));
  }
}

/* ---------------- 删除（归档并删除） ---------------- */

export interface DeleteProfileResult {
  ok: true;
  archive: string;
  deleted: boolean;
}

/** 归档并删除；confirm 必须等于 id。archiveOnly=true 时只归档不删。 */
export async function deleteProfile(id: string, confirm: string, archiveOnly: boolean): Promise<DeleteProfileResult> {
  return withLock(async () => {
    if (!PROFILE_ID_RE.test(id)) {
      throw new ApiError(400, `profile id 不合法：${id || "(空)"}`);
    }
    if (id === "default") {
      throw new ApiError(400, "default 是 Hermes 主 profile，不能删除");
    }
    if (confirm !== id) {
      throw new ApiError(400, `confirm 不匹配：需要精确输入 "${id}"`);
    }
    if (!fs.existsSync(path.join(profileDir(id), "config.yaml"))) {
      throw new ApiError(404, `profile 不存在或不可用：${id}`);
    }

    const busy = (await profileBusy(id)) ?? (await gatewayServing(id));
    if (busy) {
      appendAudit({ ts: new Date().toISOString(), action: "delete", profile: id, result: "error", detail: busy });
      throw new ApiError(409, busy);
    }

    // 1) 先归档；失败中止，不删
    const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
    fs.mkdirSync(backupsRoot(), { recursive: true });
    const archivePath = path.join(backupsRoot(), `${id}-${ts}.tar.gz`);
    const exported = await runHermes(["profile", "export", id, "-o", archivePath]);
    if (!exported.ok) {
      const detail = `归档失败（未删除任何东西）：${exported.error}`;
      appendAudit({ ts: new Date().toISOString(), action: "delete", profile: id, result: "error", detail });
      throw new ApiError(500, detail);
    }
    if (!fs.existsSync(archivePath)) {
      const detail = `归档失败（未删除任何东西）：hermes export 未产生 ${archivePath}`;
      appendAudit({ ts: new Date().toISOString(), action: "delete", profile: id, result: "error", detail });
      throw new ApiError(500, detail);
    }

    if (archiveOnly) {
      invalidateProfilesCache();
      appendAudit({
        ts: new Date().toISOString(),
        action: "delete",
        profile: id,
        result: "ok",
        detail: `archiveOnly：仅归档 ${archivePath}`,
      });
      return { ok: true, archive: archivePath, deleted: false };
    }

    // 2) hermes profile delete -y
    const removed = await runHermes(["profile", "delete", id, "-y"]);
    if (!removed.ok) {
      const detail = `profile 已归档到 ${archivePath}，但删除失败：${removed.error}`;
      appendAudit({ ts: new Date().toISOString(), action: "delete", profile: id, result: "error", detail });
      throw new ApiError(500, detail);
    }

    // 3) 删 ELENVA 应用包（= 自动断开；Hermes 数据已随 delete 清掉）
    try {
      fs.rmSync(elenvaAgentDir(id), { recursive: true, force: true });
    } catch {
      /* 包目录删不掉不视为失败 —— profile 本体已删 */
    }

    invalidateProfilesCache();
    appendAudit({ ts: new Date().toISOString(), action: "delete", profile: id, result: "ok", detail: `归档 ${archivePath}` });
    return { ok: true, archive: archivePath, deleted: true };
  });
}

/* ---------------- 回收站（归档列表 / 恢复） ---------------- */

export interface ArchiveEntry {
  /** 文件绝对路径 */
  path: string;
  /** 文件名 */
  name: string;
  sizeBytes: number;
  modifiedAt: string;
}

export function listArchives(): ArchiveEntry[] {
  try {
    return fs
      .readdirSync(backupsRoot(), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".tar.gz"))
      .map((e) => {
        const full = path.join(backupsRoot(), e.name);
        const st = fs.statSync(full);
        return { path: full, name: e.name, sizeBytes: st.size, modifiedAt: st.mtime.toISOString() };
      })
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  } catch {
    return [];
  }
}

export interface ImportArchiveParams {
  archive: string;
  name?: string;
  connect?: boolean;
}

/** 从归档恢复 profile；完成后可选直接接入 ELENVA。 */
export async function importArchive(params: ImportArchiveParams): Promise<{ profile: string; archive: string }> {
  return withLock(async () => {
    const archive = params.archive?.trim() ?? "";
    const backupsDir = backupsRoot();
    const resolved = path.resolve(archive);
    if (!archive || !archive.endsWith(".tar.gz") || !resolved.startsWith(backupsDir + path.sep) || !fs.existsSync(resolved)) {
      throw new ApiError(400, `归档路径不合法或不存在：${archive}（只接受 ${backupsDir} 下的 .tar.gz）`);
    }
    let name: string | undefined;
    if (params.name?.trim()) {
      name = params.name.trim();
      if (!PROFILE_ID_RE.test(name)) throw new ApiError(400, `恢复目标 id 不合法：${name}`);
      if (fs.existsSync(profileDir(name))) throw new ApiError(409, `磁盘上已存在该 profile：${name}`);
    }

    const args = ["profile", "import", resolved];
    if (name) args.push("--name", name);
    const imported = await runHermes(args);
    if (!imported.ok) {
      appendAudit({
        ts: new Date().toISOString(),
        action: "import",
        profile: name ?? path.basename(resolved),
        result: "error",
        detail: imported.error,
      });
      throw new ApiError(500, `hermes profile import 失败：${imported.error}`);
    }

    // import 成功后的真实 profile 名：CLI 输出不可靠，用发现层对账
    invalidateProfilesCache();
    const profiles = await discoverProfiles();
    const restored: ProfileEntry | undefined =
      (name && profiles.find((p) => p.id === name)) ||
      profiles.find((p) => p.id !== "default" && fs.existsSync(profileDir(p.id)));

    if (params.connect !== false && restored) {
      try {
        fs.mkdirSync(elenvaAgentDir(restored.id), { recursive: true });
        const manifest = {
          id: restored.id,
          name: restored.displayName,
          runtime: "hermes",
          profile: restored.id,
          version: "0.1.0",
        };
        fs.writeFileSync(
          path.join(elenvaAgentDir(restored.id), "manifest.json"),
          JSON.stringify(manifest, null, 2) + "\n",
          "utf8",
        );
        invalidateProfilesCache();
      } catch {
        /* 接入失败不算恢复失败；名册里手动接入即可 */
      }
    }

    appendAudit({
      ts: new Date().toISOString(),
      action: "import",
      profile: restored?.id ?? name ?? path.basename(resolved),
      result: "ok",
      detail: `从 ${path.basename(resolved)} 恢复`,
    });
    return { profile: restored?.id ?? name ?? "", archive: resolved };
  });
}
