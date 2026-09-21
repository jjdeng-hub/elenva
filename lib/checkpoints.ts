import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * 每轮改动快照 —— 项目里的「后悔药」。
 *
 * 以前唯一的撤销入口是 `git reset --soft HEAD~1`，前提是改动已经 commit 过；
 * 而工作区不一定是 git 仓库。agent 在工作区改散文件时，界面上没有任何
 * 「回到这一轮之前」的入口。
 *
 * 这里在每次 `edit`/`write` 真正执行前把原文件内容存一份，一轮结束时落盘成
 * manifest；需要时可以整轮还原。设计上刻意保守：
 *
 *  · 只覆盖 write/edit 工具的改动。bash 的副作用（重定向、安装、生成物）只
 *    记录命令原文，还原时不假装能回滚它们。
 *  · 还原时「删除新建文件」必须当前内容哈希与本轮写入后的哈希一致 —— 否则
 *    说明人在之后又改过，宁可跳过也不覆盖。
 *  · 单文件超过 2 MB、单轮超过 32 MB 的文件记为不可还原，不静默丢数据。
 */

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_TURN_BYTES = 32 * 1024 * 1024;

export interface CheckpointFileEntry {
  /** 绝对路径 */
  path: string;
  /** 首次改动它的工具名 */
  tool: string;
  /** 本轮第一次触碰前文件是否存在 */
  existed: boolean;
  /** 备份文件名（存在于本轮目录的 files/ 下）；缺失表示未备份 */
  preImage?: string;
  preHash?: string;
  /** 本轮最后一次写入后的内容哈希 */
  postHash?: string;
  bytes?: number;
  /** 未能备份的原因（超大文件等） */
  skippedReason?: string;
}

export interface CheckpointShellRun {
  command: string;
  /** null = 还没有结果（被审批拦下、或仍在执行） */
  failed: boolean | null;
}

export interface Checkpoint {
  id: string;
  sessionId: string;
  cwd: string;
  turnIndex: number;
  createdAt: string;
  closedAt?: string;
  status: "open" | "closed";
  files: CheckpointFileEntry[];
  /** 本轮执行过的命令及其成败（观测栏的「本轮」区块直接用这份数据） */
  shellCommands: CheckpointShellRun[];
}

export interface RestoreResult {
  restored: string[];
  deleted: string[];
  skipped: Array<{ path: string; reason: string }>;
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

export function checkpointsRoot(agentDir = getAgentDir()): string {
  return join(agentDir, "elenva-checkpoints");
}

function sessionDir(sessionId: string, agentDir?: string): string {
  return join(checkpointsRoot(agentDir), safeSegment(sessionId));
}

function turnDir(sessionId: string, turnId: string, agentDir?: string): string {
  return join(sessionDir(sessionId, agentDir), safeSegment(turnId));
}

function manifestPath(sessionId: string, turnId: string, agentDir?: string): string {
  return join(turnDir(sessionId, turnId, agentDir), "manifest.json");
}

/**
 * manifest 的读—改—写必须作为一个整体。本模块全部使用同步 fs：Node 单线程下
 * 一次调用不会被另一次打断，因此这里不需要真正的锁，包装只是标明这个约束
 * （并行工具调用不会互相踩踏，除非将来改成异步 IO —— 那时这里要换成真锁）。
 */
function withSessionLock<T>(_sessionId: string, task: () => T): T {
  return task();
}

function hashContent(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex").slice(0, 32);
}

function readManifest(sessionId: string, turnId: string, agentDir?: string): Checkpoint | null {
  const path = manifestPath(sessionId, turnId, agentDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Checkpoint & {
      shellCommands?: Array<string | CheckpointShellRun>;
    };
    // 兼容早期版本：shellCommands 曾是纯字符串数组
    parsed.shellCommands = (parsed.shellCommands ?? []).map((entry) => (
      typeof entry === "string" ? { command: entry, failed: null } : entry
    ));
    return parsed;
  } catch {
    return null;
  }
}

function writeManifest(checkpoint: Checkpoint, agentDir?: string): void {
  const path = manifestPath(checkpoint.sessionId, checkpoint.id, agentDir);
  mkdirSync(join(turnDir(checkpoint.sessionId, checkpoint.id, agentDir), "files"), { recursive: true });
  writeFileSync(path, JSON.stringify(checkpoint, null, 2), "utf8");
}

export function openCheckpoint(options: {
  sessionId: string;
  cwd: string;
  turnIndex: number;
  agentDir?: string;
}, agentDir?: string): Checkpoint {
  return withSessionLock(options.sessionId, () => {
    const id = `turn-${options.turnIndex}-${Date.now()}`;
    const checkpoint: Checkpoint = {
      id,
      sessionId: options.sessionId,
      cwd: options.cwd,
      turnIndex: options.turnIndex,
      createdAt: new Date().toISOString(),
      status: "open",
      files: [],
      shellCommands: [],
    };
    writeManifest(checkpoint, agentDir);
    return checkpoint;
  });
}

/**
 * 记录一次写入前的原文件内容。同轮内同一路径只备份一次（首次为准）。
 * 返回更新后的条目。
 */
export function recordFilePreImage(options: {
  sessionId: string;
  turnId: string;
  filePath: string;
  tool: string;
  agentDir?: string;
}, agentDir?: string): CheckpointFileEntry {
  return withSessionLock(options.sessionId, () => {
    const checkpoint = readManifest(options.sessionId, options.turnId, agentDir);
    if (!checkpoint) {
      return { path: options.filePath, tool: options.tool, existed: false, skippedReason: "快照记录不存在" };
    }
    const absolute = resolve(options.filePath);
    const key = absolute.toLowerCase();
    const existing = checkpoint.files.find((entry) => entry.path.toLowerCase() === key);
    if (existing) return existing;

    const entry: CheckpointFileEntry = {
      path: absolute,
      tool: options.tool,
      existed: existsSync(absolute),
    };
    if (entry.existed) {
      try {
        const stat = statSync(absolute);
        entry.bytes = stat.size;
        if (stat.size > MAX_FILE_BYTES) {
          entry.skippedReason = "文件过大，未备份";
        } else {
          const buffer = readFileSync(absolute);
          const currentBytes = checkpoint.files.reduce((sum, item) => sum + (item.bytes ?? 0), 0);
          if (currentBytes + stat.size > MAX_TURN_BYTES) {
            entry.skippedReason = "本轮备份总量超限，未备份";
          } else {
            const dir = join(turnDir(options.sessionId, options.turnId, agentDir), "files");
            mkdirSync(dir, { recursive: true });
            const fileName = `${checkpoint.files.length}-${safeSegment(basename(absolute))}`;
            copyFileSync(absolute, join(dir, fileName));
            entry.preImage = fileName;
            entry.preHash = hashContent(buffer);
          }
        }
      } catch {
        entry.skippedReason = "备份失败";
      }
    }
    checkpoint.files.push(entry);
    writeManifest(checkpoint, agentDir);
    return entry;
  });
}

/** 工具执行完成后记录写入结果哈希，供还原时判断「文件后来是否被改过」 */
export function recordFilePostHash(options: {
  sessionId: string;
  turnId: string;
  filePath: string;
  agentDir?: string;
}, agentDir?: string): void {
  withSessionLock(options.sessionId, () => {
    const checkpoint = readManifest(options.sessionId, options.turnId, agentDir);
    if (!checkpoint) return;
    const absolute = resolve(options.filePath);
    const key = absolute.toLowerCase();
    const entry = checkpoint.files.find((item) => item.path.toLowerCase() === key);
    if (!entry || !existsSync(absolute)) return;
    try {
      entry.postHash = hashContent(readFileSync(absolute));
      entry.skippedReason = entry.preImage ? undefined : entry.skippedReason;
      writeManifest(checkpoint, agentDir);
    } catch {
      /* 读不到就保持原样 */
    }
  });
}

export function recordShellCommand(options: {
  sessionId: string;
  turnId: string;
  command: string;
  agentDir?: string;
}, agentDir?: string): void {
  withSessionLock(options.sessionId, () => {
    const checkpoint = readManifest(options.sessionId, options.turnId, agentDir);
    if (!checkpoint) return;
    const command = options.command.trim();
    if (!command) return;
    checkpoint.shellCommands.push({
      command: command.length > 500 ? `${command.slice(0, 500)}…` : command,
      failed: null,
    });
    writeManifest(checkpoint, agentDir);
  });
}

/** 命令跑完后回填成败；同一命令多次出现时取最早那个还没有结果的 */
export function recordShellResult(options: {
  sessionId: string;
  turnId: string;
  command: string;
  failed: boolean;
  agentDir?: string;
}, agentDir?: string): void {
  withSessionLock(options.sessionId, () => {
    const checkpoint = readManifest(options.sessionId, options.turnId, agentDir);
    if (!checkpoint) return;
    const command = options.command.trim();
    const stored = command.length > 500 ? `${command.slice(0, 500)}…` : command;
    const entry = checkpoint.shellCommands.find((item) => item.failed === null && item.command === stored);
    if (entry) entry.failed = options.failed;
    else checkpoint.shellCommands.push({ command: stored, failed: options.failed });
    writeManifest(checkpoint, agentDir);
  });
}

export function closeCheckpoint(options: {
  sessionId: string;
  turnId: string;
  agentDir?: string;
}, agentDir?: string): void {
  withSessionLock(options.sessionId, () => {
    const checkpoint = readManifest(options.sessionId, options.turnId, agentDir);
    if (!checkpoint) return;
    checkpoint.status = "closed";
    checkpoint.closedAt = new Date().toISOString();
    writeManifest(checkpoint, agentDir);
  });
}

export function listCheckpoints(sessionId: string, agentDir?: string, limit = 50): Checkpoint[] {
  const dir = sessionDir(sessionId, agentDir);
  if (!existsSync(dir)) return [];
  const out: Checkpoint[] = [];
  for (const name of readdirSync(dir)) {
    const checkpoint = readManifest(sessionId, name, agentDir);
    if (checkpoint) out.push(checkpoint);
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out.slice(0, limit);
}

/** 只保留最近 keep 轮的快照目录，避免无限增长 */
export function pruneCheckpoints(sessionId: string, keep = 20, agentDir?: string): void {
  const all = listCheckpoints(sessionId, agentDir, 1000);
  for (const checkpoint of all.slice(keep)) {
    try {
      rmSync(turnDir(sessionId, checkpoint.id, agentDir), { recursive: true, force: true });
    } catch {
      /* 清理失败不影响主流程 */
    }
  }
}

/**
 * 还原一轮的改动。
 *
 * 删除「本轮新建的文件」是最危险的一步，所以要求当前内容与本轮写入后的哈希
 * 完全一致；不一致说明有人在本轮之后又动过它，跳过并如实报告。
 */
export function restoreCheckpoint(options: {
  sessionId: string;
  turnId: string;
  agentDir?: string;
}, agentDir?: string): RestoreResult {
  return withSessionLock(options.sessionId, () => {
    const checkpoint = readManifest(options.sessionId, options.turnId, agentDir);
    const result: RestoreResult = { restored: [], deleted: [], skipped: [] };
    if (!checkpoint) {
      result.skipped.push({ path: "", reason: "快照不存在" });
      return result;
    }
    const dir = join(turnDir(options.sessionId, options.turnId, agentDir), "files");
    // 逆序还原：后写入的先撤销，避免同一文件多轮编辑时顺序错乱
    for (const entry of [...checkpoint.files].reverse()) {
      if (entry.existed) {
        if (!entry.preImage) {
          result.skipped.push({ path: entry.path, reason: entry.skippedReason ?? "没有备份内容" });
          continue;
        }
        try {
          copyFileSync(join(dir, entry.preImage), entry.path);
          result.restored.push(entry.path);
        } catch (error) {
          result.skipped.push({
            path: entry.path,
            reason: error instanceof Error ? error.message : "还原失败",
          });
        }
        continue;
      }
      if (!existsSync(entry.path)) continue;
      try {
        const currentHash = hashContent(readFileSync(entry.path));
        if (!entry.postHash || currentHash !== entry.postHash) {
          result.skipped.push({ path: entry.path, reason: "本轮之后内容又被改动，未删除" });
          continue;
        }
        rmSync(entry.path, { force: true });
        result.deleted.push(entry.path);
      } catch (error) {
        result.skipped.push({
          path: entry.path,
          reason: error instanceof Error ? error.message : "删除失败",
        });
      }
    }
    checkpoint.status = "closed";
    checkpoint.closedAt = checkpoint.closedAt ?? new Date().toISOString();
    writeManifest(checkpoint, agentDir);
    return result;
  });
}

/** 会话被删除时清掉它的快照目录 */
export function dropCheckpoints(sessionId: string, agentDir?: string): void {
  try {
    rmSync(sessionDir(sessionId, agentDir), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
