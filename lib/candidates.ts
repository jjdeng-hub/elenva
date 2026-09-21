import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { getAgentSession, startAgentSession } from "./agent-runtime";
import { addWorktree, removeWorktree, resolveProject } from "./worktree";

const execFileAsync = promisify(execFile);

/**
 * 并行候选（「试验田」）。
 *
 * 以前的编排只到「监控」为止：能看到子代理在跑、能插话，但没法回答
 * 「同一个任务哪个方案更好」—— 一个 prompt 只能得到一个答案，好坏的判断
 * 完全押在模型这一次的发挥上。
 *
 * 这里把同一句话同时发给 N 个各自独立 worktree 的会话，跑完并排比 diff，
 * 挑一个采用（把改动 apply 回主工作区）、其余丢弃（删 worktree）。
 *
 * 边界刻意划清：
 *  · 只在 git 仓库里可用，且要求已有提交（没有 HEAD 就没有基线可比对）。
 *  · 「采用」是把候选 worktree 相对基线的 diff 打到主工作区，不自动提交、
 *    不碰分支 —— 采用之后走原有的 git 视图审查与提交。
 *  · 候选会话是普通会话，能在会话列表里打开、继续追问、单独删除。
 */

export const MAX_CANDIDATES = 3;

export interface CandidateInfo {
  sessionId: string;
  worktreePath: string;
  branch: string;
  status: "running" | "idle" | "error";
  error?: string;
  changedFiles: number;
  additions: number;
  deletions: number;
  /** 候选产出的最后一段文字（截断），用于并排比较 */
  summary: string | null;
}

export interface CandidateGroup {
  id: string;
  cwd: string;
  baseCommit: string;
  prompt: string;
  createdAt: string;
  candidates: CandidateInfo[];
}

interface StoredCandidate {
  sessionId: string;
  worktreePath: string;
  branch: string;
  error?: string;
}

interface StoredGroup {
  id: string;
  cwd: string;
  baseCommit: string;
  prompt: string;
  createdAt: string;
  candidates: StoredCandidate[];
}

const MAX_GROUPS = 20;

async function git(cwd: string, args: string[], maxBuffer = 8 * 1024 * 1024): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer, windowsHide: true });
  return stdout;
}

export function getCandidatesPath(agentDir = getAgentDir()): string {
  return join(agentDir, "elenva-candidates.json");
}

function readGroups(path: string): StoredGroup[] {
  if (!existsSync(path)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object") return [];
    const groups = (parsed as { groups?: unknown }).groups;
    if (!Array.isArray(groups)) return [];
    return groups.filter((group): group is StoredGroup => (
      group !== null
      && typeof group === "object"
      && typeof (group as StoredGroup).id === "string"
      && Array.isArray((group as StoredGroup).candidates)
    ));
  } catch {
    return [];
  }
}

function writeGroups(groups: StoredGroup[], path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(path, JSON.stringify({ version: 1, groups }, null, 2));
}

/** `git diff --shortstat` 解析：`3 files changed, 12 insertions(+), 4 deletions(-)` */
function parseShortstat(output: string): { changedFiles: number; additions: number; deletions: number } {
  const files = /(\d+) files? changed/.exec(output);
  const additions = /(\d+) insertions?\(\+\)/.exec(output);
  const deletions = /(\d+) deletions?\(-\)/.exec(output);
  return {
    changedFiles: files ? Number(files[1]) : 0,
    additions: additions ? Number(additions[1]) : 0,
    deletions: deletions ? Number(deletions[1]) : 0,
  };
}

function lastAssistantText(sessionId: string): string | null {
  const session = getAgentSession(sessionId);
  if (!session?.isAlive()) return null;
  const entries = session.inner.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { type?: string; message?: { role?: string; content?: unknown } };
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((block): block is { type: "text"; text: string } => (
        block !== null && typeof block === "object" && (block as { type?: string }).type === "text"
      ))
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text) return text.length > 400 ? `${text.slice(0, 400)}…` : text;
  }
  return null;
}

async function describeCandidate(
  stored: StoredCandidate,
  baseCommit: string,
): Promise<CandidateInfo> {
  const info: CandidateInfo = {
    sessionId: stored.sessionId,
    worktreePath: stored.worktreePath,
    branch: stored.branch,
    status: "idle",
    changedFiles: 0,
    additions: 0,
    deletions: 0,
    summary: null,
  };
  if (stored.error) {
    info.status = "error";
    info.error = stored.error;
  }
  try {
    // 相对基线的改动，覆盖「agent 自己提交过」的情况
    const shortstat = await git(stored.worktreePath, ["diff", baseCommit, "--shortstat"]);
    Object.assign(info, parseShortstat(shortstat));
  } catch (error) {
    info.status = "error";
    info.error = info.error ?? (error instanceof Error ? error.message : String(error));
  }
  const session = getAgentSession(stored.sessionId);
  if (session?.isAlive()) {
    try {
      const state = await session.send({ type: "get_state" }) as { isStreaming?: boolean; isPromptRunning?: boolean };
      if (state?.isStreaming || state?.isPromptRunning) info.status = "running";
    } catch {
      /* 状态问不到就不标，避免误报失败 */
    }
  }
  info.summary = lastAssistantText(stored.sessionId);
  return info;
}

export async function listCandidateGroups(cwd?: string, agentDir?: string): Promise<CandidateGroup[]> {
  const path = getCandidatesPath(agentDir);
  const groups = readGroups(path);
  const filtered = cwd ? groups.filter((group) => group.cwd === cwd) : groups;
  const out: CandidateGroup[] = [];
  for (const group of filtered) {
    const candidates = await Promise.all(
      group.candidates.map((candidate) => describeCandidate(candidate, group.baseCommit)),
    );
    out.push({ ...group, candidates });
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out;
}

export async function startCandidateGroup(options: {
  cwd: string;
  prompt: string;
  count: number;
  agentDir?: string;
}): Promise<CandidateGroup> {
  const prompt = options.prompt.trim();
  if (!prompt) throw new Error("任务描述不能为空");
  const count = Math.max(2, Math.min(MAX_CANDIDATES, Math.floor(options.count || 2)));

  const project = await resolveProject(options.cwd);
  if (!project.isGitRepo) throw new Error("并行试验需要 git 仓库");
  let baseCommit: string;
  try {
    baseCommit = (await git(options.cwd, ["rev-parse", "HEAD"])).trim();
  } catch {
    throw new Error("仓库还没有任何提交，无法建立并行工作区");
  }

  const groupId = `try-${Date.now().toString(36)}`;
  const path = getCandidatesPath(options.agentDir);
  const groups = readGroups(path);
  const stored: StoredGroup = {
    id: groupId,
    cwd: options.cwd,
    baseCommit,
    prompt,
    createdAt: new Date().toISOString(),
    candidates: [],
  };

  for (let index = 1; index <= count; index++) {
    const branch = `elenva/${groupId}-${index}`;
    try {
      const worktree = await addWorktree(options.cwd, branch);
      const { session, realSessionId } = await startAgentSession(
        `candidate-${groupId}-${index}`,
        "",
        worktree.path,
        {},
      );
      stored.candidates.push({
        sessionId: realSessionId,
        worktreePath: worktree.path,
        branch: worktree.branch,
      });
      // 后台跑，不等待：调用方要的是「都开起来了」
      void session.send({ type: "prompt", message: prompt }).catch((error) => {
        console.error("[elenva] candidate prompt failed:", error instanceof Error ? error.message : error);
      });
    } catch (error) {
      stored.candidates.push({
        sessionId: "",
        worktreePath: "",
        branch,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  groups.unshift(stored);
  writeGroups(groups.slice(0, MAX_GROUPS), path);

  const created = (await listCandidateGroups(options.cwd, options.agentDir)).find((item) => item.id === groupId);
  return created ?? { ...stored, candidates: [] };
}

export async function discardCandidate(options: {
  groupId: string;
  sessionId: string;
  agentDir?: string;
}): Promise<{ removedWorktree: boolean }> {
  const path = getCandidatesPath(options.agentDir);
  const groups = readGroups(path);
  const group = groups.find((item) => item.id === options.groupId);
  if (!group) throw new Error("找不到该试验组");
  const candidate = group.candidates.find((item) => item.sessionId === options.sessionId);
  if (!candidate) throw new Error("找不到该候选");

  let removedWorktree = false;
  if (candidate.worktreePath && existsSync(candidate.worktreePath)) {
    try {
      await removeWorktree(group.cwd, candidate.worktreePath, true);
      removedWorktree = true;
    } catch (error) {
      // 工作区已经被手工删掉时，git worktree remove 会失败但目录已不存在，
      // 此时仍然把它从登记表里摘掉，否则界面会一直显示一个僵尸候选。
      if (existsSync(candidate.worktreePath)) {
        throw error;
      }
      removedWorktree = true;
    }
    // 兜底：git 有时留下空目录
    if (existsSync(candidate.worktreePath)) {
      try {
        rmSync(candidate.worktreePath, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  group.candidates = group.candidates.filter((item) => item.sessionId !== options.sessionId);
  const next = group.candidates.length > 0 ? groups : groups.filter((item) => item.id !== options.groupId);
  writeGroups(next, path);
  return { removedWorktree };
}

export async function adoptCandidate(options: {
  groupId: string;
  sessionId: string;
  agentDir?: string;
}): Promise<{ files: string[]; patchPath: string }> {
  const path = getCandidatesPath(options.agentDir);
  const groups = readGroups(path);
  const group = groups.find((item) => item.id === options.groupId);
  if (!group) throw new Error("找不到该试验组");
  const candidate = group.candidates.find((item) => item.sessionId === options.sessionId);
  if (!candidate) throw new Error("找不到该候选");
  if (!candidate.worktreePath) throw new Error("该候选没有可用的工作区");

  const patch = await git(candidate.worktreePath, ["diff", group.baseCommit, "--binary"]);
  if (!patch.trim()) throw new Error("该候选没有任何改动");

  const patchPath = join(getAgentDir(), "elenva-candidates", `${group.id}-${options.sessionId}.patch`);
  mkdirSync(dirname(patchPath), { recursive: true });
  writeFileSync(patchPath, patch, "utf8");

  const files = [...patch.matchAll(/^diff --git a\/(.+?) b\//gm)].map((match) => match[1]).filter(Boolean);
  try {
    await git(group.cwd, ["apply", "--whitespace=nowarn", patchPath]);
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr;
    throw new Error(
      `打补丁失败（主工作区可能已有冲突改动）：${(stderr ?? (error instanceof Error ? error.message : String(error))).trim()}`,
    );
  }
  return { files, patchPath };
}
