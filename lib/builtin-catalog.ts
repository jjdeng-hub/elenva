/**
 * 内置扩展与技能的「发现 / 状态 / 安装」（模块 4「工具与扩展」· 第 3 轮）。
 *
 * README 里「仓库自带件不会自动生效，要 `node extensions/<name>/install.mjs` /
 * `node skills/install.mjs` 复制到 pi 的 agent 目录」——这套发现与安装动作原先只在
 * README 的 CLI 里。本模块把那件事搬进插件页：枚举仓库里的源、比对 agent 目录里的
 * 目标、算出三态（missing / installed / outdated），并按 **install.mjs 的原语义** 复制。
 *
 * 两条硬边界：
 *  · **install.mjs 是 SOURCE OF TRUTH**：复制滤镜、覆盖、清理旧文件的规则逐条照搬
 *    （`extensions/<name>/install.mjs` 只装 `*.ts` + `README.md` 并删掉目标里多出来的；
 *    `skills/install.mjs` 是整目录递归复制、不删）。改了本模块就要同步改脚本，反之亦然
 *    —— 自测里有一条「lib 复制结果 == 直接跑 install.mjs 的复制结果」的一致性比对兜底。
 *  · **纯函数区与 IO 区分开**：文件顶部（纯函数区）不 `import` 任何 `node:*`，差异比较 /
 *    状态归并 / 白名单都能被自测直载；真正的 fs 操作在 IO 区，用 `await import("node:*")`
 *    按需加载，保证**本模块顶层无 node 专有依赖**——即使哪天被客户端误引也不会把 fs 带进包。
 */

// ============================ 纯函数区（无 node:* 依赖）============================

export type BuiltinItemStatus = "missing" | "installed" | "outdated";
export type BuiltinKind = "extension" | "skills";

/** 相对路径 → 文件内容；`null` 表示目标侧那个位置存在但不是同名文件（如目录） */
export type FileMap = Record<string, string | null>;

export interface TreeDiff {
  missing: string[];
  different: string[];
  extra: string[];
}

export interface BuiltinCatalogItem {
  /** 白名单用的仓库内路径：`extensions/elenva-memory` / `skills` */
  path: string;
  kind: BuiltinKind;
  /** `elenva-memory` / `内置起步技能` */
  name: string;
  description: string;
  status: BuiltinItemStatus;
  /** agent 目录里的目标路径 */
  targetPath: string;
  /** README 命令兜底，给 CLI 用户复制 */
  installCommand: string;
  /** 扩展代码在服务进程启动时读取；技能是纯文件、不涉及进程 */
  restartRequired: boolean;
  needsDependency?: boolean;
  dependencyName?: string;
  dependencyNote?: string;
}

export interface BuiltinCatalogResponse {
  items: BuiltinCatalogItem[];
  agentRoot: string;
  restartNote: string;
}

/** 装完 toast / 分节脚注共用的一句口径（沿用「新会话生效 / 可能需重启」） */
export const RESTART_NOTE =
  "安装后新会话生效；扩展代码在服务进程启动时读取，更新扩展可能需重启服务（dev 下热更新，生产模式需重建并重启）。";

/** 需要外部依赖的内置项（目前只有 elenva-memory） */
export const BUILTIN_DEPENDENCIES: Record<string, { name: string; note: string }> = {
  "extensions/elenva-memory": {
    name: "pi-hermes-memory",
    note: "elenva-memory 是 pi-hermes-memory 的索引层；缺它时索引仍会装上，但记忆读写工具不可用：pi install npm:pi-hermes-memory@0.9.9",
  },
};

/** 内置起步技能在仓库里的位置（整体作为一个安装项） */
export const SKILLS_PATH = "skills";

/**
 * 扩展安装脚本的复制滤镜（照抄 extensions/*​/install.mjs）：
 * 只装运行时要用的文件 —— `*.ts` + README，不装 selftest / install 自己（避免递归）。
 * 滤镜是通配的：新增的 .ts 会被自动带上，无需登记。
 */
export function isRuntimeExtensionFile(name: string): boolean {
  return name.endsWith(".ts") || name === "README.md";
}

/** 逐文件比对源与目标；键是**相对路径**（skills 用 `<name>/SKILL.md` 这种） */
export function diffTree(source: FileMap, target: FileMap): TreeDiff {
  const missing: string[] = [];
  const different: string[] = [];
  for (const [rel, content] of Object.entries(source)) {
    const hit = target[rel];
    if (hit === undefined || hit === null) missing.push(rel);
    else if (hit !== content) different.push(rel);
  }
  const extra = Object.keys(target).filter((rel) => !(rel in source));
  return { missing: missing.sort(), different: different.sort(), extra: extra.sort() };
}

/**
 * 差异 → 三态。
 *  · 目标一个文件都没有 → `missing`
 *  · 有任何缺失 / 内容不同 → `outdated`
 *  · `extraIsOutdated` 控制「目标里多出来的文件」算不算可同步：
 *      extensions 的 install.mjs **会删掉**多余文件（所以多余 = 需要更新）；
 *      skills 的 install.mjs 是纯递归复制、**不删**（多余文件一键装也装不掉，
 *      若算作 outdated 就会永远停在「可更新」，反而误导）。
 */
export function statusFromDiff(
  diff: TreeDiff,
  opts: { targetFileCount: number; extraIsOutdated: boolean },
): BuiltinItemStatus {
  if (opts.targetFileCount === 0) return "missing";
  const changed =
    diff.missing.length > 0 ||
    diff.different.length > 0 ||
    (opts.extraIsOutdated && diff.extra.length > 0);
  return changed ? "outdated" : "installed";
}

/** POST 白名单：只认从仓库枚举出来的项（由调用方把 allowed 传进来，避免与枚举漂移） */
export function isAllowedBuiltinPath(path: string, allowed: readonly string[]): boolean {
  return allowed.includes(path);
}

/** 从 README 的 h1 取「—— 后面那句」当说明；取不到用 fallback */
export function descriptionFromReadme(markdown: string, fallback: string): string {
  const line = markdown.split(/\r?\n/).find((l) => l.trim().startsWith("# "));
  if (!line) return fallback;
  const title = line.replace(/^#\s*/, "").trim();
  const idx = title.indexOf("——");
  const desc = idx >= 0 ? title.slice(idx + 2).trim() : "";
  return desc || fallback;
}

/** 状态 → 界面文案（客户端另有一份同样的映射，这里给自测一个可断言的单一出处） */
export function statusLabel(status: BuiltinItemStatus): string {
  if (status === "missing") return "未安装";
  if (status === "installed") return "已安装";
  return "可更新";
}

// ============================ IO 区（只被 server 路由调用）============================

interface BuiltinSource {
  path: string;
  kind: BuiltinKind;
  name: string;
  description: string;
  sourceDir: string;
  targetDir: string;
  files: FileMap;
  /** 全部为文件时：目标里该删的"多余条目"的判断依据就是 files 的键 */
  installCommand: string;
  restartRequired: boolean;
  /** skills 专用：要递归复制的技能目录名 */
  childDirs: string[];
}

type NodeFs = typeof import("node:fs");
type NodePath = typeof import("node:path");
type NodeOs = typeof import("node:os");

async function loadNode(): Promise<{ fs: NodeFs; path: NodePath; os: NodeOs }> {
  const [fs, path, os] = await Promise.all([
    import("node:fs"),
    import("node:path"),
    import("node:os"),
  ]);
  return { fs, path, os };
}

/** 与 install.mjs 一致的 agent 根目录解析：PI_CODING_AGENT_DIR 优先，否则 ~/.pi/agent */
export async function resolveAgentRoot(): Promise<string> {
  const { path, os } = await loadNode();
  const override = process.env.PI_CODING_AGENT_DIR;
  return override ? path.resolve(override) : path.join(os.homedir(), ".pi", "agent");
}

/** 递归收集文件（只收文件，键用 `/` 分隔的相对路径） */
function collectFiles(fs: NodeFs, path: NodePath, dir: string, prefix: string, out: FileMap): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(fs, path, full, rel, out);
    else if (entry.isFile()) out[rel] = fs.readFileSync(full, "utf8");
  }
}

/** 目标侧（extensions）：顶层读取；文件取内容，目录记为 null（位置被占用） */
function readFlatTarget(fs: NodeFs, path: NodePath, dir: string): FileMap {
  const out: FileMap = {};
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile()) out[entry.name] = fs.readFileSync(full, "utf8");
    else out[entry.name] = null;
  }
  return out;
}

/** 目标侧（skills）：递归读取、只收文件（目录本身不算条目，否则会误判为多余） */
function readRecursiveTarget(fs: NodeFs, path: NodePath, dir: string): FileMap {
  const out: FileMap = {};
  if (!fs.existsSync(dir)) return out;
  collectFiles(fs, path, dir, "", out);
  return out;
}

function readDescription(fs: NodeFs, path: NodePath, sourceDir: string, fallback: string): string {
  const readme = path.join(sourceDir, "README.md");
  if (!fs.existsSync(readme)) return fallback;
  try {
    return descriptionFromReadme(fs.readFileSync(readme, "utf8"), fallback);
  } catch {
    return fallback;
  }
}

/** 枚举仓库里的内置扩展（`extensions/*` 里有 install.mjs 的目录） */
function readExtensionSources(
  fs: NodeFs,
  path: NodePath,
  repoRoot: string,
  agentRoot: string,
): BuiltinSource[] {
  const root = path.join(repoRoot, "extensions");
  if (!fs.existsSync(root)) return [];
  const names = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, "install.mjs")))
    .map((e) => e.name)
    .sort();
  return names.map((name) => {
    const sourceDir = path.join(root, name);
    const files = fs
      .readdirSync(sourceDir, { withFileTypes: true })
      .filter((e) => e.isFile() && isRuntimeExtensionFile(e.name))
      .map((e) => e.name)
      .sort();
    const map: FileMap = {};
    for (const file of files) map[file] = fs.readFileSync(path.join(sourceDir, file), "utf8");
    return {
      path: `extensions/${name}`,
      kind: "extension" as const,
      name,
      description: readDescription(fs, path, sourceDir, name),
      sourceDir,
      targetDir: path.join(agentRoot, "extensions", name),
      files: map,
      installCommand: `node extensions/${name}/install.mjs`,
      restartRequired: true,
      childDirs: [],
    };
  });
}

/** 枚举内置起步技能（`skills/<name>/SKILL.md`）；整体作为一个安装项 */
function readSkillsSource(
  fs: NodeFs,
  path: NodePath,
  repoRoot: string,
  agentRoot: string,
): BuiltinSource | null {
  const root = path.join(repoRoot, SKILLS_PATH);
  if (!fs.existsSync(root)) return null;
  const names = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, "SKILL.md")))
    .map((e) => e.name)
    .sort();
  if (names.length === 0) return null;
  const files: FileMap = {};
  for (const name of names) collectFiles(fs, path, path.join(root, name), name, files);
  return {
    path: SKILLS_PATH,
    kind: "skills",
    name: "内置起步技能",
    description: `仓库自带的起步技能（${names.join(" / ")}），随源码分发、一次性装到 agent 技能目录`,
    sourceDir: root,
    targetDir: path.join(agentRoot, "skills"),
    files,
    installCommand: "node skills/install.mjs",
    restartRequired: false,
    childDirs: names,
  };
}

async function enumerateBuiltinSources(
  repoRoot: string,
  agentRoot: string,
): Promise<BuiltinSource[]> {
  const { fs, path } = await loadNode();
  const sources = readExtensionSources(fs, path, repoRoot, agentRoot);
  const skills = readSkillsSource(fs, path, repoRoot, agentRoot);
  if (skills) sources.push(skills);
  return sources;
}

function statusForSource(
  fs: NodeFs,
  path: NodePath,
  source: BuiltinSource,
): BuiltinItemStatus {
  const target =
    source.kind === "skills"
      ? readRecursiveTarget(fs, path, source.targetDir)
      : readFlatTarget(fs, path, source.targetDir);
  const diff = diffTree(source.files, target);
  return statusFromDiff(diff, {
    targetFileCount: Object.keys(target).length,
    extraIsOutdated: source.kind === "extension",
  });
}

/** 依赖是否已装：agent 扩展目录 / pi 的 npm 包目录 / settings.json 的 packages 任一处命中 */
function dependencyInstalled(fs: NodeFs, path: NodePath, agentRoot: string, name: string): boolean {
  if (fs.existsSync(path.join(agentRoot, "extensions", name))) return true;
  if (fs.existsSync(path.join(agentRoot, name))) return true;
  if (fs.existsSync(path.join(agentRoot, "npm", "node_modules", name))) return true;
  const settingsPath = path.join(agentRoot, "settings.json");
  if (fs.existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { packages?: unknown };
      const packages = Array.isArray(parsed.packages) ? parsed.packages : [];
      if (packages.some((p) => typeof p === "string" && p.includes(name))) return true;
    } catch {
      /* settings 坏了不该让整页挂掉：当作未装，由界面提示 */
    }
  }
  return false;
}

function toItem(
  source: BuiltinSource,
  status: BuiltinItemStatus,
  dependencyOk: boolean,
): BuiltinCatalogItem {
  const dep = BUILTIN_DEPENDENCIES[source.path];
  return {
    path: source.path,
    kind: source.kind,
    name: source.name,
    description: source.description,
    status,
    targetPath: source.targetDir,
    installCommand: source.installCommand,
    restartRequired: source.restartRequired,
    ...(dep
      ? { needsDependency: !dependencyOk, dependencyName: dep.name, dependencyNote: dep.note }
      : {}),
  };
}

/** 目录树快照（自测用：把安装结果整棵树读成 FileMap，键为相对路径） */
export async function snapshotTree(dir: string): Promise<FileMap> {
  const { fs, path } = await loadNode();
  return readRecursiveTarget(fs, path, dir);
}

/**
 * 目标侧（extensions）的顶层快照：文件取内容，目录记为 null。与 lib 的状态判定口径一致。
 */
export async function snapshotFlat(dir: string): Promise<FileMap> {
  const { fs, path } = await loadNode();
  return readFlatTarget(fs, path, dir);
}

/**
 * 枚举 + 比对 + 依赖提示，产出一份可直接给界面的清单。
 * 显式收 `repoRoot` / `agentRoot`（路由传 process.cwd() 与解析出的 agent 目录），自测可注入临时目录。
 */
export async function computeBuiltinCatalog(
  repoRoot: string,
  agentRoot?: string,
): Promise<BuiltinCatalogResponse> {
  const { fs, path } = await loadNode();
  const root = agentRoot ?? (await resolveAgentRoot());
  const sources = await enumerateBuiltinSources(repoRoot, root);
  const items = sources.map((source) => {
    const dep = BUILTIN_DEPENDENCIES[source.path];
    const dependencyOk = dep ? dependencyInstalled(fs, path, root, dep.name) : true;
    return toItem(source, statusForSource(fs, path, source), dependencyOk);
  });
  return { items, agentRoot: root, restartNote: RESTART_NOTE };
}

export type InstallBuiltinResult =
  | { ok: true; item: BuiltinCatalogItem; response: BuiltinCatalogResponse }
  | { ok: false; error: string };

/**
 * 安装 / 更新一个内置项：**与 install.mjs 完全同语义的复制**。
 *
 * extensions：先删掉目标里不在清单中的条目（改名/删文件时不留幽灵模块），再逐文件覆盖写。
 * skills：逐技能目录 `cpSync(recursive, force)`——只覆盖、不删除，与脚本一致。
 */
export async function installBuiltin(
  repoRoot: string,
  target: string,
  agentRoot?: string,
): Promise<InstallBuiltinResult> {
  const { fs, path } = await loadNode();
  const root = agentRoot ?? (await resolveAgentRoot());
  const sources = await enumerateBuiltinSources(repoRoot, root);
  if (!isAllowedBuiltinPath(target, sources.map((s) => s.path))) {
    return { ok: false, error: `不在内置清单内：${target}` };
  }
  const source = sources.find((s) => s.path === target)!;

  if (source.kind === "skills") {
    fs.mkdirSync(source.targetDir, { recursive: true });
    for (const name of source.childDirs) {
      fs.cpSync(path.join(source.sourceDir, name), path.join(source.targetDir, name), {
        recursive: true,
        force: true,
      });
    }
  } else {
    fs.mkdirSync(source.targetDir, { recursive: true });
    const keep = new Set(Object.keys(source.files));
    for (const existing of fs.readdirSync(source.targetDir)) {
      if (!keep.has(existing)) {
        fs.rmSync(path.join(source.targetDir, existing), { recursive: true, force: true });
      }
    }
    for (const [rel, content] of Object.entries(source.files)) {
      fs.writeFileSync(path.join(source.targetDir, rel), content ?? "", "utf8");
    }
  }

  const response = await computeBuiltinCatalog(repoRoot, root);
  const item = response.items.find((i) => i.path === target);
  if (!item) return { ok: false, error: `安装后未找到 ${target}` };
  return { ok: true, item, response };
}
