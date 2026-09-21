"use client";

import { Download, FileCode2, FileText, Image as ImageIcon, Loader2, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "@/components/lib/utils";
import { Resizer, usePersistedWidth } from "@/components/ui/Resizer";

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;
const MEDIA_RE = /\.(mp4|webm|mp3|wav|ogg|pdf|docx?)$/i;

/** 打开时最多核对这么多个文件的存亡 —— 列表本就是滚动区，再多也没人往下看 */
const EXISTENCE_CHECK_LIMIT = 40;

type ReadChunk = { content: string; truncated?: boolean; language?: string; size?: number };

/**
 * 会话右侧文件预览面板：展示本会话中 Agent 通过 write/edit 工具写入的文件，
 * 点击即可内嵌预览（文本 / 图片），无需下载。
 */
export function FilePreviewPanel({
  files,
  selected,
  onSelect,
  onClose,
  onOpenCode,
}: {
  /** 本会话写入过的文件（绝对路径，最新在前） */
  files: string[];
  selected: string | null;
  onSelect: (path: string) => void;
  onClose: () => void;
  /** 在「代码」页打开该文件（带定位）。观测栏不再列本会话文件后，入口收到这里 ——
   *  文件列表和这个动作本来就该待在一起。 */
  onOpenCode?: (path: string) => void;
}) {
  const [content, setContent] = useState<ReadChunk | null>(null);
  const [loading, setLoading] = useState(false);
  /**
   * 已不存在的文件。
   *
   * 这份列表是从**消息历史**推出来的（agent 写过哪些文件），删掉/改名的文件会留在里面，
   * 直到点开才发现读不到 —— 面板会显示「读取失败」，控制台还留一条 404。
   * 所以打开时先问一遍 `?type=meta`，把这类文件标出来（灰掉 + 「已删除」）。
   */
  const [missing, setMissing] = useState<Set<string>>(new Set());
  /** 存亡核对是否已回来 —— 核对前不自动选中、不读内容，否则会先对已删除的文件发一次读请求（404） */
  const [checked, setChecked] = useState(false);
  const { width: paneWidth, grow: growPane, reset: resetPane } = usePersistedWidth(
    "elenva-preview-panel-width",
    340,
    260,
    560,
  );

  /* 面板打开（或列表变化）时核对存亡。网络错误不当成「已删除」—— 宁可漏标也不能误标。 */
  useEffect(() => {
    if (files.length === 0) {
      setMissing((prev) => (prev.size === 0 ? prev : new Set()));
      setChecked(true);
      return;
    }
    let cancelled = false;
    setChecked(false);
    void Promise.all(
      files.slice(0, EXISTENCE_CHECK_LIMIT).map(async (path) => {
        try {
          const res = await fetch(`/api/files/${encodePath(path)}?type=exists`, { cache: "no-store" });
          if (!res.ok) return null;
          const data = (await res.json().catch(() => ({}))) as { exists?: boolean };
          return data.exists === false ? path : null;
        } catch {
          return null;
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      setMissing(new Set(results.filter((item): item is string => item !== null)));
      setChecked(true);
    });
    return () => {
      cancelled = true;
    };
  }, [files]);

  /* 面板打开且未选文件时，默认选最新的一个（跳过已删除的） */
  useEffect(() => {
    if (!checked || files.length === 0) return;
    if (selected && !missing.has(selected)) return;
    const firstExisting = files.find((f) => !missing.has(f));
    if (firstExisting && firstExisting !== selected) onSelect(firstExisting);
  }, [checked, selected, files, missing, onSelect]);

  const load = useCallback(async (path: string) => {
    setLoading(true);
    setContent(null);
    try {
      let data: ReadChunk & { error?: string } | null = null;
      // 新会话的 cwd 可能尚未进入服务端 5s 授权根目录缓存，403 时自动重试一次
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await fetch(`/api/files/${encodePath(path)}?type=read`, { cache: "no-store" });
        data = (await res.json()) as ReadChunk & { error?: string };
        if (!(res.status === 403 && attempt === 0)) break;
        await new Promise((r) => setTimeout(r, 1200));
      }
      setContent(data?.error ? { content: `读取失败：${data.error}` } : data ?? { content: "" });
    } catch {
      setContent({ content: "读取失败（网络错误）" });
    } finally {
      setLoading(false);
    }
  }, []);

  const selectedMissing = selected !== null && missing.has(selected);

  useEffect(() => {
    if (!checked || !selected || selectedMissing) return;
    if (IMAGE_RE.test(selected) || MEDIA_RE.test(selected)) return;
    void load(selected);
  }, [checked, selected, selectedMissing, load]);

  const fileName = selected?.split(/[\\/]/).pop() ?? "";

  return (
    <>
    <Resizer onDrag={growPane} onDoubleClick={resetPane} invert side="left" label="调整预览面板宽度" />
    <aside
      className="flex shrink-0 flex-col border-r border-line bg-panel"
      style={{ width: paneWidth }}
    >
      {/* 面板头 */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3.5">
        <FileText size={14} className="shrink-0 text-accent" />
        <span className="text-[13px] font-semibold">会话文件</span>
        <span className="chip">{files.length}</span>
        <button
          onClick={onClose}
          className="ml-auto flex size-6 cursor-pointer items-center justify-center rounded-md text-dim t-fast hover:bg-hover hover:text-fg"
          title="收起预览面板"
        >
          <X size={14} />
        </button>
      </div>

      {/* 写入文件列表 */}
      <div className="max-h-56 shrink-0 overflow-y-auto border-b border-line p-1.5">
        {files.map((p) => {
          const gone = missing.has(p);
          return (
            <button
              key={p}
              onClick={() => onSelect(p)}
              disabled={gone}
              title={gone ? `${p}\n（文件已不存在：可能被删除或改名）` : p}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] t-fast",
                gone ? "cursor-not-allowed text-dim/70" : "cursor-pointer hover:bg-hover",
                selected === p && !gone ? "bg-active text-accent" : gone ? "" : "text-fg",
              )}
            >
              {IMAGE_RE.test(p) ? (
                <ImageIcon size={14} className="shrink-0 text-dim" />
              ) : (
                <FileText size={14} className="shrink-0 text-dim" />
              )}
              <span className="min-w-0 flex-1 truncate">{fileNameOf(p)}</span>
              {gone ? (
                <span className="chip shrink-0">已删除</span>
              ) : (
                <span className="max-w-24 shrink-0 truncate text-[10px] text-dim">{parentDirOf(p)}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* 内容预览 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!checked ? (
          <div className="flex items-center gap-2 p-3 text-[12px] text-dim">
            <Loader2 size={14} className="anim-spin" /> 核对文件…
          </div>
        ) : selectedMissing ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-dim">
            <FileText size={20} strokeWidth={1.5} />
            <div className="text-[12px]">文件已不存在</div>
            <div className="text-[10px] leading-relaxed text-dim/70">
              它在本会话里被写入过，之后被删除或改名了。
            </div>
          </div>
        ) : !selected ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-dim">
            <FileText size={20} strokeWidth={1.5} />
            <div className="text-[12px]">本会话还没有写入过文件</div>
          </div>
        ) : (
          <>
            <div className="sticky top-0 z-10 flex h-9 items-center gap-2 border-b border-line bg-panel/95 px-3">
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted" title={selected}>
                {selected}
              </span>
              {content?.truncated && <span className="shrink-0 text-[10px] text-dim">已截断</span>}
              {!IMAGE_RE.test(selected) && !MEDIA_RE.test(selected) && (
                <button
                  onClick={() => selected && load(selected)}
                  className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-dim t-fast hover:bg-hover hover:text-fg"
                  title="重新读取（Agent 可能已重写该文件）"
                >
                  <RefreshCw size={12} className={cn(loading && "anim-spin")} />
                </button>
              )}
              {onOpenCode && selected && (
                <button
                  onClick={() => onOpenCode(selected)}
                  className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-dim t-fast hover:bg-hover hover:text-fg"
                  title="在「代码」页打开（含改动与提交）"
                  data-testid="preview-open-code"
                >
                  <FileCode2 size={12} />
                </button>
              )}
              <a
                href={`/api/files/${encodePath(selected)}?type=download`}
                target="_blank"
                rel="noreferrer"
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-dim t-fast hover:bg-hover hover:text-fg"
                title="下载文件"
              >
                <Download size={12} />
              </a>
            </div>
            {IMAGE_RE.test(selected) ? (
              <div className="flex items-center justify-center p-4">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/files/${encodePath(selected)}?type=read`}
                  alt={fileName}
                  className="max-h-[60vh] max-w-full rounded-card border border-line object-contain"
                />
              </div>
            ) : MEDIA_RE.test(selected) ? (
              <div className="p-4 text-[12px] text-dim">该文件类型不支持内嵌预览，可点击右上角按钮下载查看。</div>
            ) : loading ? (
              <div className="flex items-center gap-2 p-3 text-[12px] text-dim">
                <Loader2 size={14} className="animate-spin" /> 读取中…
              </div>
            ) : content ? (
              <pre className="overflow-x-auto p-3 font-mono text-[12px] leading-5 text-fg">{content.content}</pre>
            ) : null}
          </>
        )}
      </div>
    </aside>
    </>
  );
}

function fileNameOf(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

function parentDirOf(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.length >= 2 ? parts[parts.length - 2] : "";
}

/** 将 Windows/POSIX 路径编码为 /api/files/[...path] 段（与 FileBrowser 同一实现） */
export function encodePath(p: string): string {
  const norm = p.replace(/\\/g, "/");
  return norm
    .split("/")
    .filter((s, i) => !(i === 0 && s === ""))
    .map(encodeURIComponent)
    .join("/");
}
