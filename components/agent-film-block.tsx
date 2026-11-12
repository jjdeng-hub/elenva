"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/components/lib/utils";
import type { BlockPayload } from "@/lib/agents/workspace";

/**
 * 片子（film）—— 视频类内容的主区域。
 *
 * 一篇稿子的主语是正文，一条片子的主语是**成片本身**：所以这里先给播放器，
 * 再给静帧墙（点一张跳到那一刻）与工程清单（分镜 / 页面 / 音频）。
 * 静帧是审片用的：不看帧就交付，是这类作品最常见的翻车方式。
 */

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

function formatSeconds(total: number): string {
  if (!Number.isFinite(total) || total <= 0) return "—";
  const minutes = Math.floor(total / 60);
  const seconds = Math.round(total % 60);
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, "0")}` : `${seconds}s`;
}

export function AgentFilmBlock({ agentId, block }: { agentId: string; block: BlockPayload }) {
  const [films, setFilms] = useState(block.films ?? []);
  const [active, setActive] = useState(0);
  const [duration, setDuration] = useState<number | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const source = (block.source ?? "").replace(/\/$/, "");

  // 有片子正在渲染时，3 秒刷一次进度（渲染脚本每 15 帧写 _render.json）
  const reload = useCallback(async () => {
    if (!source) return;
    try {
      const res = await fetch(
        `/api/agents/films?id=${encodeURIComponent(agentId)}&dir=${encodeURIComponent(source)}`,
        { cache: "no-store" },
      );
      const data = (await res.json().catch(() => ({}))) as { films?: BlockPayload["films"] };
      if (Array.isArray(data.films)) setFilms(data.films);
    } catch {
      /* 刷新失败就保持上一份 */
    }
  }, [agentId, source]);

  useEffect(() => {
    if (!source) return;
    const timer = setInterval(() => {
      const rendering = films.some((film) => film.progress && !film.progress.stale && film.progress.stage !== "done");
      if (rendering) void reload();
    }, 3000);
    return () => clearInterval(timer);
  }, [films, reload, source]);

  useEffect(() => {
    setDuration(null);
  }, [active]);

  if (films.length === 0) {
    return (
      <div className="p-6 text-[12px] text-dim">
        还没有片子。让 Agent 在这个目录下建一个工程（分镜 + film.html + 导出 mp4）。
      </div>
    );
  }

  const film = films[Math.min(active, films.length - 1)];
  const media = (path: string) =>
    `/api/agents/media?id=${encodeURIComponent(agentId)}&path=${encodeURIComponent(path)}`;

  const jumpTo = (index: number) => {
    const el = video.current;
    if (!el || !duration || film.stills.length === 0) return;
    el.currentTime = Math.min(duration - 0.05, (index / Math.max(1, film.stills.length)) * duration);
    void el.play().catch(() => {});
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 片子切换 */}
      {films.length > 1 && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line-soft px-6 py-2">
          {films.map((item, index) => (
            <button
              key={item.slug}
              type="button"
              className={cn("btn btn-sm", index === active ? "btn-primary" : "btn-subtle")}
              onClick={() => setActive(index)}
            >
              {item.title}
            </button>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        <div className="mx-auto flex max-w-5xl flex-col gap-4">
          {/* 标题与元信息 */}
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-[20px] font-semibold tracking-tight">{film.title}</h2>
            <span className="chip">{formatSeconds(duration ?? 0)}</span>
            {film.video && <span className="chip">{formatBytes(film.video.bytes)}</span>}
            <span className="text-[11px] text-dim">{film.slug}</span>
            {film.missingVideo && <span className="chip chip-warn">还没有成片</span>}
          </div>
          {film.logline && <p className="text-[13px] leading-relaxed text-muted">{film.logline}</p>}

          {film.progress && !film.progress.stale && film.progress.stage !== "done" && (
            <div className="rounded-md border border-line bg-panel-2 px-3 py-2" data-testid="film-progress">
              <div className="flex items-center gap-2 text-[11px] text-dim">
                <span className="chip chip-accent">{film.progress.stage === "encode" ? "编码中" : "渲染中"}</span>
                <span className="text-fg">
                  {film.progress.frame ?? 0} / {film.progress.total ?? "?"} 帧
                </span>
                <span>{film.progress.percent}%</span>
                {film.progress.etaSec !== undefined && <span>约剩 {film.progress.etaSec}s</span>}
              </div>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-line">
                <div className="h-full bg-accent transition-all t-base" style={{ width: `${film.progress.percent}%` }} />
              </div>
            </div>
          )}

          {/* 成片 */}
          {film.video ? (
            <div className="overflow-hidden rounded-card border border-line bg-black">
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <video
                ref={video}
                key={film.video.path}
                src={media(film.video.path)}
                controls
                playsInline
                preload="metadata"
                poster={film.stills[0] ? media(film.stills[0].path) : undefined}
                className="mx-auto max-h-[62vh] w-auto"
                onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
              />
            </div>
          ) : (
            <div className="rounded-card border border-dashed border-line px-4 py-8 text-center text-[12px] text-dim">
              这个工程还没有 out.mp4 —— 让 Agent 用渲染脚本导出。
            </div>
          )}

          {/* 静帧墙：审片用 */}
          {film.stills.length > 0 && (
            <div>
              <div className="mb-1.5 text-[10px] tracking-wide text-dim">静帧（点一张跳到那一刻）</div>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                {film.stills.map((still, index) => (
                  <button
                    key={still.path}
                    type="button"
                    className="group overflow-hidden rounded-md border border-line bg-panel-2"
                    onClick={() => jumpTo(index)}
                    title={still.name}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={media(still.path)}
                      alt={still.name}
                      loading="lazy"
                      className="aspect-[9/16] w-full object-cover transition-opacity t-fast group-hover:opacity-80"
                    />
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 工程清单 */}
          {film.files.length > 0 && (
            <div className="text-[11px] text-dim">
              工程：
              {film.files.map((file) => (
                <span key={file.name} className="ml-2">
                  {file.name} <span className="text-dim/70">{formatBytes(file.bytes)}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
