/**
 * 工作记录的存储层：定位文件、解析条目、写入。
 *
 * ## 它与记忆的分工（《深入理解 AI Agent》ch3 L170 的三类记忆）
 *
 * | | 管什么 | 容量 | 生命周期 |
 * |---|---|---|---|
 * | pi-hermes-memory / elenva-memory | **语义记忆**：跨会话长期有效的事实、偏好、教训 | 有界（4000 字符） | 长期，满了要合并 |
 * | 本扩展 | **情景记忆的当前段**：进行中 / 刚完成的工作 | 滚动窗口（保留最近 N 条） | 短期，整理后提炼进记忆 |
 *
 * 两者是上下游：工作记录承载原始过程（含验证证据），整理时把值得长期留下的**提炼**进记忆，
 * 而不是把什么都往 4000 字符里塞。
 *
 * 文件：`<agentRoot>/worklog/<项目名>.md`，最新条目在最上面（注入只读第一条，成本恒定）。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type WorklogStatus = "done" | "doing" | "blocked";

export interface WorklogEntry {
  /** `YYYY-MM-DD HH:mm` */
  at: string;
  title: string;
  status: WorklogStatus;
  goal?: string;
  did?: string;
  evidence?: string;
  todo?: string;
}

export interface WorklogFile {
  path: string;
  projectName: string | null;
  entries: WorklogEntry[];
}

/** 默认保留条数（滚动窗口；更早的进 archive/） */
export const DEFAULT_KEEP = 20;

export function agentRootDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) return path.join(os.homedir(), ".pi", "agent");
  return path.resolve(configured.startsWith("~") ? path.join(os.homedir(), configured.slice(1)) : configured);
}

export function worklogDir(agentRoot = agentRootDir()): string {
  const configured = process.env.ELENVA_WORKLOG_DIR?.trim();
  if (configured) return path.resolve(configured.startsWith("~") ? path.join(os.homedir(), configured.slice(1)) : configured);
  return path.join(agentRoot, "worklog");
}

/** 找 git 仓库根（与 elenva-memory 的 detectProjectName 同口径的精简版，不 spawn git）。 */
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
    if (stat?.isFile()) return current; // worktree 指针文件
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** 项目名：优先 git 仓库名，否则用目录名（与记忆的项目目录同口径）。 */
export function detectProjectName(cwd: string): string | null {
  const resolved = path.resolve(cwd);
  const home = path.resolve(os.homedir());
  if (resolved === home || resolved === path.parse(resolved).root) return null;
  const repoRoot = findGitRepoRoot(resolved);
  const name = path.basename(repoRoot ?? resolved);
  return name && name !== "." && name !== ".." ? name : null;
}

export function worklogPath(cwd: string, agentRoot = agentRootDir()): { path: string; projectName: string | null } {
  const projectName = detectProjectName(cwd);
  const file = path.join(worklogDir(agentRoot), `${projectName ?? "_unknown"}.md`);
  return { path: file, projectName };
}

const HEAD_PATTERN = /^##\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s+·\s+(.+?)\s+·\s+(done|doing|blocked)\s*$/;

function parseEntryBlock(block: string): WorklogEntry | null {
  const lines = block.split("\n");
  const head = HEAD_PATTERN.exec(lines[0].trim());
  if (!head) return null;
  const entry: WorklogEntry = { at: head[1], title: head[2], status: head[3] as WorklogStatus };
  for (const line of lines.slice(1)) {
    const match = /^(目标|做了什么|证据|待办)[:：]\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const value = match[2].trim();
    if (!value) continue;
    if (match[1] === "目标") entry.goal = value;
    else if (match[1] === "做了什么") entry.did = value;
    else if (match[1] === "证据") entry.evidence = value;
    else if (match[1] === "待办") entry.todo = value;
  }
  return entry;
}

/** 解析整份工作记录（最新在前） */
export function parseWorklog(raw: string): WorklogEntry[] {
  return raw
    .split(/\n(?=##\s)/)
    .map((block) => block.trim())
    .filter((block) => block.startsWith("##"))
    .map(parseEntryBlock)
    .filter((entry): entry is WorklogEntry => entry !== null);
}

export function serializeEntry(entry: WorklogEntry): string {
  const lines = [`## ${entry.at} · ${entry.title} · ${entry.status}`];
  if (entry.goal) lines.push(`目标：${entry.goal}`);
  if (entry.did) lines.push(`做了什么：${entry.did}`);
  if (entry.evidence) lines.push(`证据：${entry.evidence}`);
  if (entry.todo) lines.push(`待办：${entry.todo}`);
  return lines.join("\n");
}

export function renderWorklog(file: WorklogFile, keep = DEFAULT_KEEP): string {
  const header = `# 工作记录 · ${file.projectName ?? "未命名项目"}\n`;
  const body = file.entries.slice(0, keep).map(serializeEntry).join("\n\n");
  return `${header}\n${body}${body ? "\n" : ""}`;
}

export function readWorklog(cwd: string, agentRoot = agentRootDir()): WorklogFile {
  const { path: file, projectName } = worklogPath(cwd, agentRoot);
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    raw = "";
  }
  return { path: file, projectName, entries: parseWorklog(raw) };
}

function writeFileAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

/** 归档溢出条目（保留文件不无限增长；归档是给人看的，不自动清理） */
function archiveOverflow(file: WorklogFile, overflow: WorklogEntry[]): string | null {
  if (overflow.length === 0) return null;
  try {
    const dir = path.join(path.dirname(file.path), "archive");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const target = path.join(dir, `${path.basename(file.path, ".md")}-${stamp}.md`);
    const body = [`# 归档（工作记录滚动窗口）`, "", `源文件：${file.path}`, `时间：${new Date().toISOString()}`, "", ...overflow.map(serializeEntry)].join("\n\n");
    fs.writeFileSync(target, body, "utf8");
    return target;
  } catch {
    return null;
  }
}

export function nowStamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export interface AppendResult {
  file: WorklogFile;
  archived: string | null;
}

/** 追加一条（最新在前）；超过 keep 条时把最旧的归档 */
export function appendEntry(
  cwd: string,
  entry: WorklogEntry,
  options: { keep?: number; agentRoot?: string } = {},
): AppendResult {
  const agentRoot = options.agentRoot ?? agentRootDir();
  const keep = options.keep ?? DEFAULT_KEEP;
  const file = readWorklog(cwd, agentRoot);
  const next: WorklogFile = { ...file, entries: [entry, ...file.entries] };
  const overflow = next.entries.slice(keep);
  const archived = archiveOverflow(next, overflow);
  next.entries = next.entries.slice(0, keep);
  fs.mkdirSync(path.dirname(next.path), { recursive: true });
  writeFileAtomic(next.path, renderWorklog(next, keep));
  return { file: next, archived };
}
