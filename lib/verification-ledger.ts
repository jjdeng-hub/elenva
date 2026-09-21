import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { VerificationKind, VerificationScope } from "./verification-kind";

/**
 * 验证证据账本 —— 「改完了」这句话的证据层。
 *
 * 灵感来自 Hermes Agent 的 verification_evidence（被动账本）+ verification_stop
 * （只出策略、不跑命令的收尾守卫），落成本项目的形态：纯 JSONL、零依赖。
 *
 * 三条自我约束：
 *  1. **被动**：只记录 agent 自己跑过的命令，宿主永远不替它跑检查 ——
 *     自己跑要多花钱、会把输出灌进上下文，还可能跑错检查。
 *  2. **不升级声称**：单点检查（`eslint src/a.ts`）通过 ≠ 全仓通过。
 *     scope 记在数据里，展示层才不会把窄检查说成「验证通过」。
 *  3. **有界**：30 天过期、总量上限。账本是拿来少犯错的，不是拿来攒数据的。
 */

export interface VerificationRecord {
  id: string;
  sessionId: string;
  cwd: string;
  createdAt: string;
  command: string;
  kind: VerificationKind;
  scope: VerificationScope;
  targets: string[];
  ok: boolean;
  /** 执行时本轮已改动过的文件（相对 cwd） */
  changedPaths: string[];
  /** 输出尾部摘要（截断） */
  output?: string;
}

const MAX_OUTPUT_CHARS = 1200;
const MAX_AGE_DAYS = 30;
const MAX_RECORDS = 4000;

export function getVerificationLedgerPath(agentDir = getAgentDir()): string {
  return join(agentDir, "elenva-verification.jsonl");
}

export function appendVerificationRecord(
  record: Omit<VerificationRecord, "id" | "createdAt"> & { id?: string; createdAt?: string },
  agentDir?: string,
): VerificationRecord {
  const full: VerificationRecord = {
    ...record,
    id: record.id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: record.createdAt ?? new Date().toISOString(),
    output: record.output ? record.output.slice(-MAX_OUTPUT_CHARS) : undefined,
  };
  const path = getVerificationLedgerPath(agentDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(full)}\n`, "utf8");
  } catch (error) {
    console.error("[elenva] failed to append verification evidence:", error);
  }
  return full;
}

export function readVerificationRecords(agentDir?: string, limit = MAX_RECORDS): VerificationRecord[] {
  const path = getVerificationLedgerPath(agentDir);
  if (!existsSync(path)) return [];
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    const records: VerificationRecord[] = [];
    for (const line of lines.slice(-limit)) {
      try {
        const parsed = JSON.parse(line) as VerificationRecord;
        if (parsed && typeof parsed === "object" && typeof parsed.command === "string") records.push(parsed);
      } catch {
        /* 跳过损坏行 */
      }
    }
    return records;
  } catch {
    return [];
  }
}

/** 30 天前的记录在读取时过滤掉（不重写文件，省一次写盘） */
export function recentVerificationRecords(agentDir?: string): VerificationRecord[] {
  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  return readVerificationRecords(agentDir).filter((record) => {
    const at = Date.parse(record.createdAt);
    return Number.isFinite(at) ? at >= cutoff : true;
  });
}

export function verificationRecordsForSession(
  sessionId: string,
  agentDir?: string,
  limit = 20,
): VerificationRecord[] {
  return recentVerificationRecords(agentDir)
    .filter((record) => record.sessionId === sessionId)
    .slice(-limit);
}

export interface EvidenceSummary {
  /** 证据层级：none = 什么都没跑；targeted = 只有单点；suite = 跑过全量 */
  level: "none" | "targeted" | "suite";
  /** 全量成功的那条命令 */
  suiteCommand: string | null;
  /** 单点成功的命令 */
  targetedCommands: string[];
  /** 跑过但失败的（最近的在前） */
  failures: Array<{ command: string; kind: VerificationKind }>;
}

/** 汇总一段窗口内的证据。`since` 传本轮开始时间，避免拿上一轮的成功当本轮证据 */
export function summarizeEvidence(records: readonly VerificationRecord[], since: number): EvidenceSummary {
  const summary: EvidenceSummary = { level: "none", suiteCommand: null, targetedCommands: [], failures: [] };
  for (const record of records) {
    const at = Date.parse(record.createdAt);
    if (Number.isFinite(at) && at < since) continue;
    if (!record.ok) {
      summary.failures.push({ command: record.command, kind: record.kind });
      continue;
    }
    if (record.scope === "suite") {
      summary.suiteCommand = record.command;
      summary.level = "suite";
    } else if (summary.level !== "suite") {
      summary.level = "targeted";
      if (!summary.targetedCommands.includes(record.command)) summary.targetedCommands.push(record.command);
    }
  }
  summary.failures.reverse();
  return summary;
}

/** 账本总量兜底：超过上限时只保留最近 N 条（由收尾维护调用） */
export function pruneVerificationLedger(agentDir?: string, keep = MAX_RECORDS): number {
  const path = getVerificationLedgerPath(agentDir);
  if (!existsSync(path)) return 0;
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    if (lines.length <= keep) return 0;
    mkdirSync(dirname(path), { recursive: true });
    // 同目录临时文件 + 重命名：崩在中途也不会留下半个账本
    const temp = `${path}.tmp`;
    writeFileSync(temp, `${lines.slice(-keep).join("\n")}\n`, "utf8");
    renameSync(temp, path);
    try {
      unlinkSync(temp);
    } catch {
      /* 已被 rename 掉 */
    }
    return lines.length - keep;
  } catch {
    return 0;
  }
}
