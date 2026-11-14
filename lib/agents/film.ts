/**
 * 片子的工程扫描（仅服务端）。
 *
 * 视频类内容的产物不是「一篇文章」，而是 `movies/<slug>/` 这个工程：
 * 分镜（storyboard.md）、页面（film.html）、成片（out.mp4）、静帧（check/ 或 stills/）。
 * 工作台要能一眼看到「这条片子长什么样、跑到哪一步」，所以这里把目录读成结构化数据。
 *
 * 只读、只认包内路径；读不到就返回空，不抛给调用方（一条坏工程不该让整个视图消失）。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { isInsideDir } from "./data-store";

export interface FilmStill {
  path: string;
  name: string;
}

export interface FilmProgress {
  stage: "render" | "encode" | "done";
  /** 已渲染帧数 */
  frame?: number;
  total?: number;
  /** 0..100 */
  percent: number;
  /** 预计剩余秒数（只有 render 阶段有意义） */
  etaSec?: number;
  updatedAt: string;
  /** 更新时间距今超过阈值 → 视为已中断，不展示 */
  stale: boolean;
}

export interface FilmProject {
  slug: string;
  title: string;
  /** 分镜里的一句话落点（storyboard.md 的「主题：」行，或首个非标题行） */
  logline?: string;
  /** 成片（相对包根） */
  video?: { path: string; bytes: number };
  /** 静帧（相对包根，最多 8 张） */
  stills: FilmStill[];
  /** 工程根下的文件清单（不含核心帧缓存） */
  files: { name: string; bytes: number }[];
  /** 最新修改时间（ISO） */
  updatedAt: string;
  /** 是否还缺成片 */
  missingVideo: boolean;
  /** 渲染进度（渲染脚本写 _render.json，这里读出来） */
  progress?: FilmProgress;
}

const MAX_PROJECTS = 24;
const MAX_STILLS = 8;
const VIDEO_EXT = [".mp4", ".webm"];
const STILL_DIRS = ["check", "stills", "_stills"];
const CORE_FILES = new Set(["storyboard.md", "film.html", "out.mp4", "soundtrack.wav", "README.md", "README_8s.md"]);

function readStoryboard(file: string): { title: string; logline?: string } {
  try {
    const text = readFileSync(file, "utf8").slice(0, 4000);
    const title = /^\s{0,3}#\s+(.+)$/m.exec(text)?.[1]?.trim();
    const logline = /^\s*(?:主题|一句话)[:：]\s*(.+)$/m.exec(text)?.[1]?.trim();
    const firstLine = text.split("\n").map((line) => line.trim()).find((line) => line && !line.startsWith("#"));
    return { title: title || "", logline: logline || firstLine };
  } catch {
    return { title: "" };
  }
}

function listStills(root: string, dir: string): FilmStill[] {
  for (const name of STILL_DIRS) {
    const abs = join(dir, name);
    if (!existsSync(abs)) continue;
    try {
      const items = readdirSync(abs)
        .filter((file) => /\.(png|jpe?g|webp)$/i.test(file))
        .sort()
        .slice(0, MAX_STILLS)
        .map((file) => ({ path: relative(root, join(abs, file)).split("\\").join("/"), name: file }));
      if (items.length > 0) return items;
    } catch {
      /* 换个目录继续找 */
    }
  }
  return [];
}

const PROGRESS_FILE = "_render.json";
const PROGRESS_STALE_MS = 10 * 60 * 1000;

function readProgress(dir: string): FilmProgress | undefined {
  const file = join(dir, PROGRESS_FILE);
  if (!existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const total = Number(raw.total ?? 0);
    const frame = Number(raw.frame ?? 0);
    const elapsedMs = Number(raw.elapsedMs ?? 0);
    const stage = raw.stage === "done" || raw.stage === "encode" ? raw.stage : "render";
    const percent =
      stage === "done" ? 100 : total > 0 ? Math.min(99, Math.round((frame / total) * 100)) : 0;
    const etaSec =
      stage === "render" && frame > 0 && total > frame && elapsedMs > 0
        ? Math.max(1, Math.round(((elapsedMs / frame) * (total - frame)) / 1000))
        : undefined;
    const updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(statSync(file).mtimeMs).toISOString();
    return {
      stage,
      frame,
      total,
      percent,
      etaSec,
      updatedAt,
      stale: Date.now() - new Date(updatedAt).getTime() > PROGRESS_STALE_MS,
    };
  } catch {
    return undefined;
  }
}

function findVideo(root: string, dir: string): { path: string; bytes: number } | undefined {
  try {
    for (const file of readdirSync(dir)) {
      if (!VIDEO_EXT.includes(file.slice(file.lastIndexOf(".")).toLowerCase())) continue;
      const abs = join(dir, file);
      const stat = statSync(abs);
      if (!stat.isFile()) continue;
      if (file !== "out.mp4" && file.startsWith("out")) {
        // 优先 out.mp4，其它 mp4 作为兜底
      }
      return { path: relative(root, abs).split("\\").join("/"), bytes: stat.size };
    }
  } catch {
    /* 忽略 */
  }
  return undefined;
}

/** 扫描 movies/<slug>/ 下的片子工程（按更新时间倒序）。 */
export function listFilms(root: string, relDir: string): FilmProject[] {
  const dir = resolve(root, relDir);
  if (!isInsideDir(resolve(root), dir) || !existsSync(dir)) return [];

  let entries: string[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_") && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const projects: FilmProject[] = [];
  for (const slug of entries.slice(0, MAX_PROJECTS)) {
    const projectDir = join(dir, slug);
    const storyboardPath = join(projectDir, "storyboard.md");
    const video = findVideo(root, projectDir);
    const hasPage = existsSync(join(projectDir, "film.html"));
    if (!video && !hasPage) continue;

    const meta = existsSync(storyboardPath) ? readStoryboard(storyboardPath) : { title: "" };
    let files: { name: string; bytes: number }[] = [];
    let updatedAt = new Date(0).toISOString();
    try {
      files = readdirSync(projectDir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => {
          const abs = join(projectDir, entry.name);
          const stat = statSync(abs);
          return { name: entry.name, bytes: stat.size, mtime: stat.mtimeMs };
        })
        .sort((a, b) => (CORE_FILES.has(a.name) ? -1 : 0) - (CORE_FILES.has(b.name) ? -1 : 0) || b.mtime - a.mtime)
        .slice(0, 8)
        .map(({ name, bytes }) => ({ name, bytes }));
      updatedAt = new Date(Math.max(...[storyboardPath, join(projectDir, "film.html"), projectDir]
        .filter((p) => existsSync(p))
        .map((p) => statSync(p).mtimeMs))).toISOString();
    } catch {
      /* 文件清单读不到不影响播放 */
    }

    projects.push({
      slug,
      title: meta.title || basename(slug),
      logline: meta.logline,
      video,
      stills: listStills(root, projectDir),
      files,
      updatedAt,
      missingVideo: !video,
      progress: readProgress(projectDir),
    });
  }

  return projects.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}
