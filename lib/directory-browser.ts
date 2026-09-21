import { readdir, realpath, stat } from "fs/promises";
import { homedir } from "os";
import path from "path";

export interface BrowsableDirectory {
  name: string;
  path: string;
}

export function shouldShowWindowsDrivePicker(
  directory?: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" && !directory;
}

export function getBrowseStartDirectory(directory?: string): string {
  return directory || homedir();
}

export function getWindowsDriveCandidates(): BrowsableDirectory[] {
  return "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((letter) => ({
    name: `${letter}:`,
    path: `${letter}:\\`,
  }));
}

export async function listWindowsDrives(): Promise<BrowsableDirectory[]> {
  const candidates = await Promise.all(getWindowsDriveCandidates().map(async (drive) => {
    try {
      const driveStat = await stat(drive.path);
      return driveStat.isDirectory() ? drive : null;
    } catch {
      return null;
    }
  }));

  return candidates.filter((drive): drive is BrowsableDirectory => drive !== null);
}

export function normalizeDirectory(directory: string): string {
  if (directory === "~") return homedir();
  if (directory.startsWith("~/")) return path.resolve(homedir(), directory.slice(2));
  return path.resolve(directory);
}

export function getParentDirectory(directory: string): string | null {
  const pathApi = /^[a-zA-Z]:[\\/]/.test(directory) || directory.startsWith("\\\\")
    ? path.win32
    : path.posix;
  const normalized = pathApi.normalize(directory);
  const parent = pathApi.dirname(normalized);
  return parent === normalized ? null : parent;
}

export async function resolveDirectory(directory: string): Promise<string> {
  return realpath(normalizeDirectory(directory));
}

export async function listDirectories(directory: string): Promise<BrowsableDirectory[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  // 忽略损坏、不可访问或不指向目录的符号链接。
  const candidates = await Promise.all(entries.map(async (entry) => {
    if (entry.isDirectory()) {
      return { name: entry.name, path: path.join(directory, entry.name) };
    }
    if (!entry.isSymbolicLink()) return null;

    try {
      const entryPath = path.join(directory, entry.name);
      const realEntryPath = await realpath(entryPath);
      const entryStat = await stat(realEntryPath);
      if (!entryStat.isDirectory()) return null;
      return { name: entry.name, path: entryPath };
    } catch {
      return null;
    }
  }));

  return candidates
    .filter((entry): entry is BrowsableDirectory => entry !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * 常用位置（桌面 / 主目录 / 文档 / 下载）。
 *
 * 存在的理由：Windows 上目录树从「此电脑」开始，选桌面上的某个文件夹要点
 * C: → Users → <用户名> → Desktop 四层。常用位置把这段路缩成一次点击。
 * 只返回**真实存在**的目录，避免列出用户机器上不存在的项。
 */
export async function listCommonPlaces(): Promise<BrowsableDirectory[]> {
  const home = homedir();
  const candidates: BrowsableDirectory[] = [
    { name: "主目录", path: home },
    { name: "桌面", path: path.join(home, "Desktop") },
    { name: "文档", path: path.join(home, "Documents") },
    { name: "下载", path: path.join(home, "Downloads") },
  ];
  const checked = await Promise.all(candidates.map(async (place) => {
    try {
      const placeStat = await stat(place.path);
      return placeStat.isDirectory() ? place : null;
    } catch {
      return null;
    }
  }));
  return checked.filter((place): place is BrowsableDirectory => place !== null);
}

/** Windows 上非法的文件名字符（也顺带挡住 POSIX 路径分隔符与前后空白） */
const INVALID_DIRECTORY_NAME = /[\/:*?"<>|\u0000-\u001f]/;

/**
 * 校验「新建文件夹」的名字。
 *
 * 只接受**单个路径段**：一旦允许分隔符或 `..`，这个接口就变成「在任意位置建目录」，
 * 越过了「用户当前浏览到哪儿」这个隐含边界。
 */
export function validateNewDirectoryName(name: string): { ok: true; name: string } | { ok: false; error: string } {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "请输入文件夹名称" };
  if (trimmed.length > 255) return { ok: false, error: "名称过长" };
  if (trimmed === "." || trimmed === "..") return { ok: false, error: "名称不合法" };
  if (INVALID_DIRECTORY_NAME.test(trimmed)) return { ok: false, error: "名称不能包含 \ / : * ? \" < > |" };
  // Windows 下以点或空格结尾的名字会被系统悄悄改写，提前拒绝更诚实
  if (/[. ]$/.test(trimmed)) return { ok: false, error: "名称不能以空格或点结尾" };
  return { ok: true, name: trimmed };
}
