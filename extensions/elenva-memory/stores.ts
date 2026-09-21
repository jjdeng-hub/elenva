/**
 * 记忆存储的读取层：定位四份记忆文件、解析条目、提取元数据。
 *
 * 与 pi-hermes-memory 的契约（只读，不改）：
 * - 文件位置：`<memoryDir>/MEMORY.md`、`USER.md`、`failures.md`；
 *   项目记忆 `<agentRoot>/projects-memory/<项目名>/MEMORY.md`；
 * - 条目格式：`条目文本 <!-- created=YYYY-MM-DD, last=YYYY-MM-DD -->`，条目之间用 `\n§\n` 分隔；
 * - 配置：`<agentRoot>/hermes-memory-config.json`（memoryDir / projectsMemoryDir / 三个配额）。
 *
 * 这里刻意**不 import pi-hermes-memory 的内部模块**（升级即碎），只按文件契约读。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const ENTRY_DELIMITER = "\n§\n";

export interface MemoryEntry {
  /** 归属：全局记忆 / 用户画像 / 失败教训 / 项目记忆 */
  scope: "memory" | "user" | "failure" | "project";
  /** 条目正文（已剥掉元数据注释） */
  text: string;
  created: string | null;
  last: string | null;
  /** 稳定标识：正文归一化后的哈希，用于访问计数与冲突标注 */
  id: string;
}

export interface StoreFile {
  scope: MemoryEntry["scope"];
  file: string;
  entries: MemoryEntry[];
  rawChars: number;
  /** 该文件的配额（字符），来自 hermes 配置 */
  limit: number;
}

export interface StoreSet {
  agentRoot: string;
  projectName: string | null;
  stores: StoreFile[];
}

export function agentRootDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) return path.join(os.homedir(), ".pi", "agent");
  return path.resolve(configured.startsWith("~") ? path.join(os.homedir(), configured.slice(1)) : configured);
}

interface HermesConfig {
  memoryDir: string;
  projectsMemoryDir: string;
  memoryCharLimit: number;
  userCharLimit: number;
  projectCharLimit: number;
}

export function readHermesConfig(agentRoot = agentRootDir()): HermesConfig {
  const defaults: HermesConfig = {
    memoryDir: path.join(agentRoot, "pi-hermes-memory"),
    projectsMemoryDir: "projects-memory",
    memoryCharLimit: 4000,
    userCharLimit: 2500,
    projectCharLimit: 3000,
  };
  try {
    const raw = fs.readFileSync(path.join(agentRoot, "hermes-memory-config.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const expand = (value: unknown, fallback: string): string => {
      if (typeof value !== "string" || !value.trim()) return fallback;
      const trimmed = value.trim();
      if (trimmed.startsWith("~")) return path.join(os.homedir(), trimmed.slice(1));
      return path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(agentRoot, trimmed);
    };
    const num = (value: unknown, fallback: number): number =>
      typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
    return {
      memoryDir: expand(parsed.memoryDir, defaults.memoryDir),
      projectsMemoryDir:
        typeof parsed.projectsMemoryDir === "string" && parsed.projectsMemoryDir.trim()
          ? parsed.projectsMemoryDir.trim()
          : defaults.projectsMemoryDir,
      memoryCharLimit: num(parsed.memoryCharLimit, defaults.memoryCharLimit),
      userCharLimit: num(parsed.userCharLimit, defaults.userCharLimit),
      projectCharLimit: num(parsed.projectCharLimit, defaults.projectCharLimit),
    };
  } catch {
    return defaults;
  }
}

/** 归一化：去 markdown 装饰、压空白、小写（用于哈希与相似度）。 */
export function normalizeText(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/[*_`>#\-\[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function entryId(text: string): string {
  // 轻量稳定哈希：FNV-1a 32 位跑两轮（两个 offset basis）拼成 16 位十六进制。
  // 不用 BigInt / crypto：本仓库 tsconfig 的 target 是 ES2017，且要能在 pi 的加载器里直接跑。
  const normalized = normalizeText(text);
  const fnv = (seed: number): string => {
    let hash = seed;
    for (let i = 0; i < normalized.length; i += 1) {
      hash ^= normalized.charCodeAt(i);
      // hash * 16777619，用分步乘法避开 32 位溢出精度问题
      hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  };
  return `${fnv(0x811c9dc5)}${fnv(0x01000193)}`.slice(0, 12);
}

const METADATA_PATTERN = /^([\s\S]*?)\s*<!--\s*created=([^,]+),\s*last=([^,>]+)(?:,\s*project64=([A-Za-z0-9_-]+))?\s*-->\s*$/;

export function parseEntries(raw: string, scope: MemoryEntry["scope"]): MemoryEntry[] {
  return raw
    .split(ENTRY_DELIMITER)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const match = METADATA_PATTERN.exec(chunk);
      const text = (match ? match[1] : chunk).trim();
      const created = match ? match[2].trim() : null;
      const last = match ? match[3].trim() : null;
      return { scope, text, created, last, id: entryId(text) };
    })
    .filter((entry) => entry.text.length > 0);
}

function readStore(file: string, scope: MemoryEntry["scope"], limit: number): StoreFile {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    raw = "";
  }
  return { scope, file, entries: parseEntries(raw, scope), rawChars: raw.length, limit };
}

/** 找 git 仓库根（与 pi-hermes-memory 的 project.ts 同口径的精简版，不 spawn git）。 */
function findGitRepoRoot(dir: string): string | null {
  let current = path.resolve(dir);
  while (true) {
    const dotGit = path.join(current, ".git");
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      stat = undefined;
    }
    if (stat?.isDirectory()) return current;
    if (stat?.isFile()) {
      // 链接工作区（worktree）：.git 是指针文件，指向 <main>/.git/worktrees/<name>
      try {
        const pointer = fs.readFileSync(dotGit, "utf8");
        const match = /^gitdir:\s*(.+)$/m.exec(pointer);
        if (match) {
          const gitDir = path.resolve(current, match[1].trim());
          const parent = path.dirname(gitDir);
          if (path.basename(parent) === "worktrees") return path.dirname(parent);
        }
      } catch {
        /* 落回 cwd 名 */
      }
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function detectProjectName(projectsRoot: string, cwd: string): string | null {
  const resolved = path.resolve(cwd);
  const home = path.resolve(os.homedir());
  if (resolved === home || resolved === path.parse(resolved).root) return null;
  const cwdName = path.basename(resolved);
  if (!cwdName || cwdName === "." || cwdName === "..") return null;

  const repoRoot = findGitRepoRoot(resolved);
  if (!repoRoot || repoRoot === resolved || repoRoot === home) return cwdName;
  const repoName = path.basename(repoRoot);
  if (!repoName || repoName === cwdName) return cwdName;
  // 迁移桥：老身份（cwd 名）下已有记忆目录时继续用它
  if (!fs.existsSync(path.join(projectsRoot, repoName)) && fs.existsSync(path.join(projectsRoot, cwdName))) {
    return cwdName;
  }
  return repoName;
}

export function readAllStores(cwd: string, agentRoot = agentRootDir()): StoreSet {
  const config = readHermesConfig(agentRoot);
  const projectsRoot = path.isAbsolute(config.projectsMemoryDir)
    ? config.projectsMemoryDir
    : path.join(agentRoot, config.projectsMemoryDir);
  const projectName = detectProjectName(projectsRoot, cwd);

  const stores: StoreFile[] = [
    readStore(path.join(config.memoryDir, "MEMORY.md"), "memory", config.memoryCharLimit),
    readStore(path.join(config.memoryDir, "USER.md"), "user", config.userCharLimit),
    readStore(path.join(config.memoryDir, "failures.md"), "failure", config.memoryCharLimit * 2),
  ];
  if (projectName) {
    stores.push(
      readStore(path.join(projectsRoot, projectName, "MEMORY.md"), "project", config.projectCharLimit),
    );
  }
  return { agentRoot, projectName, stores };
}

export function allEntries(set: StoreSet): MemoryEntry[] {
  return set.stores.flatMap((store) => store.entries);
}

/** 原子写：先写临时文件再 rename，避免半截文件。 */
export function writeFileAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

/** 把条目数组写回文件，保持 pi-hermes-memory 的格式（尾部元数据 + § 分隔）。 */
export function serializeEntries(entries: MemoryEntry[]): string {
  return entries
    .map((entry) => {
      const created = entry.created ?? new Date().toISOString().slice(0, 10);
      const last = entry.last ?? created;
      return `${entry.text} <!-- created=${created}, last=${last} -->`;
    })
    .join(ENTRY_DELIMITER);
}

export function archiveEntries(store: StoreFile, entries: MemoryEntry[], reason: string): string | null {
  if (entries.length === 0) return null;
  const archiveDir = path.join(path.dirname(store.file), "archive");
  fs.mkdirSync(archiveDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(archiveDir, `${path.basename(store.file, ".md")}-${stamp}.md`);
  const body = [
    `# 归档（${reason}）`,
    "",
    `源文件：${store.file}`,
    `时间：${new Date().toISOString()}`,
    "",
    ...entries.map((entry) => `## ${entry.id}\n\n${entry.text}\n`),
  ].join("\n");
  fs.writeFileSync(file, body, "utf8");
  return file;
}
