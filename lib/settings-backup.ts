import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";

/**
 * `settings.json` 的写前备份（模块 6 修复轮 · B1）。
 *
 * 背景：`defaultProvider` / `defaultModel` 一旦写错（或被自动路径静默改掉），
 * **所有新会话**都会照它落选，而此前唯一的还原办法是手工编辑文件。这里给每次
 * 「写启动默认」留一份带时间的副本，全自动、容量有限。
 *
 * 位置：`<agentDir>/backups/settings/<YYYYMMDD-HHmmss>-<label>.json`
 * （与记忆页写前备份同族，放在 `backups/` 下，不进仓库）。
 * 保留：最近 `SETTINGS_BACKUP_KEEP` 份，超出按 mtime 丢最旧。
 *
 * 口径：**尽力而为**——备份失败只记日志、不阻断用户显式动作；失败与否则由
 * `tools/settings-backup-selftest.mjs` 覆盖。
 */

export const SETTINGS_BACKUP_DIR_NAME = "settings";
export const SETTINGS_BACKUP_KEEP = 20;

/** 备份目录（`<agentDir>/backups/settings`） */
export function getSettingsBackupDir(agentDir = getAgentDir()): string {
  return join(agentDir, "backups", SETTINGS_BACKUP_DIR_NAME);
}

/** 文件名里的 label 只留安全字符（其余折叠成 `-`），避免路径注入与怪名。 */
function sanitizeLabel(label: string): string {
  const cleaned = label.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return cleaned || "default";
}

/** 本地时间戳 `YYYYMMDD-HHmmss`（文件名按字典序即时间序） */
function timestamp(now = new Date()): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    + pad(now.getMilliseconds(), 3)
  );
}

/**
 * 删除超出上限的旧备份（按 mtime，最旧先删）。
 * 非 `.json` 文件不动（目录若被共用，别误删别人的东西）。
 */
function pruneBackups(dir: string, keep: number): void {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return;
  }
  if (names.length <= keep) return;
  const entries = names
    .map((name) => {
      try {
        return { name, mtimeMs: statSync(join(dir, name)).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { name: string; mtimeMs: number } => entry !== null)
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const entry of entries.slice(0, Math.max(0, entries.length - keep))) {
    try {
      unlinkSync(join(dir, entry.name));
    } catch {
      /* 删不掉就算了：备份多留一份不是错误 */
    }
  }
}

/**
 * 把当前 `settings.json` 复制进备份目录。返回备份路径；文件不存在或写入失败
 * 返回 `null`（只记日志，不抛）。
 */
export function backupSettingsFile(
  settingsPath: string,
  label = "default",
  options: { dir?: string; keep?: number; now?: Date } = {},
): string | null {
  try {
    if (!existsSync(settingsPath)) return null;
    const dir = options.dir ?? getSettingsBackupDir();
    mkdirSync(dir, { recursive: true });
    const target = join(dir, `${timestamp(options.now)}-${sanitizeLabel(label)}.json`);
    // 用 atomic 私有写（0600）：settings.json 可能不含密钥，但沿用同一写盘口径最省心。
    writePrivateFileAtomicSync(target, readFileSync(settingsPath, "utf8"));
    pruneBackups(dir, options.keep ?? SETTINGS_BACKUP_KEEP);
    return target;
  } catch (error) {
    console.error(
      "[elenva] settings backup failed:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
