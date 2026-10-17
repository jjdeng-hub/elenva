/**
 * `/memory-reindex` —— 索引可重建（记忆 2.0 R3）。
 *
 * ## 为什么需要它
 *
 * `sessions.db` 是**派生物**：会话 JSONL 与四份记忆 Markdown 才是 source of truth。
 * 但派生物会坏：FTS5 索引行与 `messages` 表失步（外部改写 / 崩溃 / 误删）、
 * 记忆镜像行比文件少、`session_files` 元数据说「已索引」而 `sessions` 行没了。
 * 以前只有 `/memory-index-sessions`（只补会话，不重建 FTS、不对账、不重扫记忆），
 * 索引坏了没有一条「一键修好并告诉我修没修好」的路。
 *
 * ## 做什么（幂等、可重复）
 *
 * 1. **先备份**：把 `sessions.db`（含 `-wal` / `-shm`）复制到 `<memoryDir>/backups/sessions.db.reindex-<时间戳>`；
 * 2. **重建 FTS**：`message_fts` / `memory_fts` 用 FTS5 的 `'rebuild'` 指令从内容表重建；
 * 3. **重扫记忆**：把四份 Markdown（含项目记忆）强制对账进 `memories` 镜像；
 * 4. **重扫会话**：从会话 JSONL 全量补齐 `sessions` / `messages`（遵守 retention 窗口）；
 * 5. **对账**：文件数 vs 行数、FTS 行数 vs 内容表行数、Markdown 条目 vs 镜像行数，
 *    不一致逐条列出（`reconcile.ok` 是机器可读判据）。
 *
 * 依据《深入理解 AI Agent》ch3 L482（索引必须能被显式维护与重建 —— 否则知识越多越难检索）；
 * ch2 L1079（模型没有维护习惯时，用命令 + 提示把维护动作变成可执行的一步）。
 *
 * ## 不做
 *
 * 不删任何 Markdown 条目、不改记忆文件字节、不触碰 `.recovery-` / `.retired-` 快照。
 * 备份只增不减（手动清即可）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseManager } from "./vendor/pi-hermes-memory/src/store/db.js";
import {
  getSessionStats,
  indexAllSessions,
  retentionCutoffMs,
} from "./vendor/pi-hermes-memory/src/store/session-indexer.js";
import { getSessionFiles, parseSessionFile } from "./vendor/pi-hermes-memory/src/store/session-parser.js";
import { syncMarkdownMemoriesToSqlite } from "./vendor/pi-hermes-memory/src/handlers/sync-markdown-memories.js";
import { loadConfig } from "./vendor/pi-hermes-memory/src/config.js";
import { agentRootDir, readAllStores, readHermesConfig } from "./stores.js";

export interface ReindexOptions {
  agentRoot?: string;
  memoryDir?: string;
  sessionsDir?: string;
  /** 项目记忆扫描时的 cwd（只影响「当前项目」判定，不影响全局对账） */
  cwd?: string;
  /** 跳过备份（仅测试用；正常命令永远先备份） */
  skipBackup?: boolean;
}

export interface ReindexReport {
  agentRoot: string;
  memoryDir: string;
  sessionsDir: string;
  backups: string[];
  ftsRebuilt: string[];
  sessions: {
    files: number;
    expiredSkipped: number;
    indexed: number;
    skipped: number;
    messagesIndexed: number;
    errors: string[];
  };
  markdown: {
    files: number;
    entries: number;
    imported: number;
    removed: number;
    warnings: string[];
  };
  totals: { sessions: number; messages: number };
  fts: { messages: number; memories: number; messageIndexOk: boolean; memoryIndexOk: boolean };
  reconcile: {
    ok: boolean;
    missingSessionFiles: string[];
    orphanSessions: string[];
    markdownEntries: number;
    markdownMirrorRows: number;
    mismatches: string[];
  };
}

/** 备份命名沿用「派生物可丢、快照可回」的思路；与 `.recovery-` / `.retired-` 分开，便于识别来源。 */
export function backupDatabaseFiles(memoryDir: string, stamp = new Date()): string[] {
  const base = path.join(memoryDir, "sessions.db");
  if (!fs.existsSync(base)) return [];
  const dir = path.join(memoryDir, "backups");
  fs.mkdirSync(dir, { recursive: true });
  const label = stamp.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out: string[] = [];
  for (const suffix of ["", "-wal", "-shm"]) {
    const source = `${base}${suffix}`;
    if (!fs.existsSync(source)) continue;
    const dest = path.join(dir, `sessions.db.reindex-${label}${suffix}`);
    fs.copyFileSync(source, dest);
    out.push(dest);
  }
  return out;
}

/** 从内容表重建两个 FTS5 索引（幂等：重复执行结果一致）。 */
export function rebuildFtsIndexes(dbManager: DatabaseManager): string[] {
  const done: string[] = [];
  dbManager.withCorruptionRecovery(() => {
    const db = dbManager.getDb();
    for (const table of ["message_fts", "memory_fts"]) {
      db.exec(`INSERT INTO ${table}(${table}) VALUES('rebuild')`);
      done.push(table);
    }
  });
  return done;
}

function countOf(dbManager: DatabaseManager, sql: string): number {
  const row = dbManager.getDb().prepare(sql).get() as { count: number } | undefined;
  return Number(row?.count ?? 0);
}

/**
 * FTS5 完整性检查（外部内容表要带 `rank=1` 才会校对索引与内容表）。
 *
 * 为什么不用「FTS 行数 vs 内容表行数」：`SELECT COUNT(*) FROM message_fts` 对外部内容表
 * 读的是 `messages`，索引被清空时它照样返回内容表行数（实测）——那个口径测不出坏索引。
 */
export function ftsIndexOk(dbManager: DatabaseManager, table: "message_fts" | "memory_fts"): boolean {
  try {
    dbManager.getDb().exec(`INSERT INTO ${table}(${table}, rank) VALUES('integrity-check', 1)`);
    return true;
  } catch {
    return false;
  }
}

/**
 * 执行一次完整重建 + 对账。**幂等**：第二次跑各项增量为 0、计数与第一次一致。
 */
export async function reindexIndexes(options: ReindexOptions = {}): Promise<ReindexReport> {
  const agentRoot = options.agentRoot ?? agentRootDir();
  const config = readHermesConfig(agentRoot);
  const memoryDir = options.memoryDir ?? config.memoryDir;
  const sessionsDir =
    options.sessionsDir ??
    process.env.PI_CODING_AGENT_SESSION_DIR ??
    path.join(agentRoot, "sessions");

  const backups = options.skipBackup ? [] : backupDatabaseFiles(memoryDir);
  const dbManager = new DatabaseManager(memoryDir);
  let ftsRebuilt: string[] = [];

  try {
    ftsRebuilt = rebuildFtsIndexes(dbManager);

    // 3) 记忆 Markdown → SQLite 镜像（force：绕过 sha 指纹短路，坏索引也能修）
    const markdown = await syncMarkdownMemoriesToSqlite(
      dbManager,
      memoryDir,
      config.projectsMemoryDir,
      agentRoot,
      { force: true },
    );

    // 4) 会话 JSONL → sessions / messages（遵守 retention，避免把已淘汰的会话又灌回来）
    let retention = 0;
    try {
      retention = retentionCutoffMs(loadConfig().sessionRetentionDays);
    } catch {
      retention = 0;
    }
    const sessionsResult = indexAllSessions(dbManager, sessionsDir, undefined, retention);
    const stats = getSessionStats(dbManager);

    // 5) 对账
    const sessionIds = new Set(
      (dbManager.getDb().prepare("SELECT id FROM sessions").all() as Array<{ id: string }>).map((row) => row.id),
    );
    const files = getSessionFiles(sessionsDir);
    const fileSessionIds = new Set<string>();
    for (const file of files) {
      if (retention > 0) {
        try {
          if (fs.statSync(file).mtimeMs < retention) continue;
        } catch {
          /* 读不到元数据就照常解析 */
        }
      }
      const parsed = parseSessionFile(file);
      if (parsed) fileSessionIds.add(parsed.id);
    }
    const missingSessionFiles = [...fileSessionIds].filter((id) => !sessionIds.has(id)).sort();
    const orphanSessions =
      retention > 0 ? [] : [...sessionIds].filter((id) => !fileSessionIds.has(id)).sort();

    // Markdown 全局条目（memory / user / failure，非失效）vs 镜像行
    const set = readAllStores(options.cwd ?? agentRoot, agentRoot);
    const markdownEntries = set.stores
      .filter((store) => store.scope !== "project")
      .reduce((sum, store) => sum + store.entries.filter((entry) => !entry.invalidated).length, 0);
    const markdownMirrorRows = countOf(
      dbManager,
      "SELECT COUNT(*) as count FROM memories WHERE project IS NULL AND target IN ('memory','user','failure')",
    );

    const fts = {
      messages: countOf(dbManager, "SELECT COUNT(*) as count FROM messages"),
      memories: countOf(dbManager, "SELECT COUNT(*) as count FROM memories"),
      messageIndexOk: ftsIndexOk(dbManager, "message_fts"),
      memoryIndexOk: ftsIndexOk(dbManager, "memory_fts"),
    };

    const mismatches: string[] = [];
    if (missingSessionFiles.length > 0) {
      mismatches.push(`${missingSessionFiles.length} 个会话文件未被索引`);
    }
    if (orphanSessions.length > 0) {
      mismatches.push(`${orphanSessions.length} 个索引会话在磁盘上已无文件`);
    }
    if (!fts.messageIndexOk) {
      mismatches.push("message_fts 索引与 messages 不一致（integrity-check 失败）");
    }
    if (!fts.memoryIndexOk) {
      mismatches.push("memory_fts 索引与 memories 不一致（integrity-check 失败）");
    }
    if (markdownEntries !== markdownMirrorRows) {
      mismatches.push(`Markdown 全局条目 ${markdownEntries} ≠ 镜像行 ${markdownMirrorRows}`);
    }
    if (sessionsResult.errors.length > 0) {
      mismatches.push(`${sessionsResult.errors.length} 个会话文件解析失败`);
    }

    return {
      agentRoot,
      memoryDir,
      sessionsDir,
      backups,
      ftsRebuilt,
      sessions: {
        files: files.length,
        expiredSkipped: sessionsResult.expiredSkipped ?? 0,
        indexed: sessionsResult.sessionsIndexed,
        skipped: sessionsResult.sessionsSkipped,
        messagesIndexed: sessionsResult.messagesIndexed,
        errors: sessionsResult.errors,
      },
      markdown: {
        files: markdown.filesScanned,
        entries: markdown.entriesScanned,
        imported: markdown.imported,
        removed: markdown.removed,
        warnings: markdown.warnings,
      },
      totals: { sessions: stats.totalSessions, messages: stats.totalMessages },
      fts,
      reconcile: {
        ok: mismatches.length === 0,
        missingSessionFiles,
        orphanSessions,
        markdownEntries,
        markdownMirrorRows,
        mismatches,
      },
    };
  } finally {
    dbManager.close();
  }
}

/** 命令输出（与 `/memory-index-sessions` 的树状风格一致，便于人读）。 */
export function renderReindexReport(report: ReindexReport): string {
  const lines: string[] = [];
  lines.push("\n✅ 索引重建完成（/memory-reindex）\n");
  lines.push("📦 备份：");
  if (report.backups.length === 0) {
    lines.push("└─ （没有 sessions.db，首次建库，无需备份）");
  } else {
    for (const file of report.backups) lines.push(`├─ ${file}`);
    lines.push("└─ 出问题可从上面任意一份回滚");
  }

  lines.push("\n🧱 FTS 重建：" + (report.ftsRebuilt.length > 0 ? report.ftsRebuilt.join(" / ") : "（无）"));

  lines.push("\n📁 会话索引：");
  lines.push(`├─ 磁盘会话文件：${report.sessions.files}${report.sessions.expiredSkipped > 0 ? `（retention 跳过 ${report.sessions.expiredSkipped}）` : ""}`);
  lines.push(`├─ 本次新增：${report.sessions.indexed} 个会话 / ${report.sessions.messagesIndexed} 条消息`);
  lines.push(`├─ 已是最新：${report.sessions.skipped} 个会话`);
  lines.push(`└─ 库内合计：${report.totals.sessions} 个会话 / ${report.totals.messages} 条消息`);

  lines.push("\n🧠 记忆镜像：");
  lines.push(`├─ 扫描文件：${report.markdown.files}，条目：${report.markdown.entries}`);
  lines.push(`├─ 新增行：${report.markdown.imported}，清孤儿行：${report.markdown.removed}`);
  lines.push(`└─ Markdown 条目 ${report.reconcile.markdownEntries} / 镜像行 ${report.reconcile.markdownMirrorRows}`);

  lines.push("\n🔎 对账：");
  lines.push(`├─ message_fts 完整性 ${report.fts.messageIndexOk ? "✅" : "❌"}（messages ${report.fts.messages} 条）`);
  lines.push(`├─ memory_fts 完整性 ${report.fts.memoryIndexOk ? "✅" : "❌"}（memories ${report.fts.memories} 条）`);
  lines.push(`└─ ${report.reconcile.ok ? "✅ 一致（索引可检索）" : `❌ ${report.reconcile.mismatches.length} 处不一致`}`);
  for (const item of report.reconcile.mismatches) lines.push(`   · ${item}`);
  for (const warning of [...report.markdown.warnings, ...report.sessions.errors]) lines.push(`   ⚠️ ${warning}`);

  lines.push("\n💡 检索验证：`session_search` 查会话、`memory_search` 查记忆镜像。");
  return lines.join("\n");
}
