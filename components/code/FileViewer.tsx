"use client";

import { AlertTriangle, Download, FileWarning, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { cn } from "@/components/lib/utils";
import {
  markdownRehypePlugins,
  markdownRemarkPlugins,
  markdownUrlTransform,
  normalizeDisplayMath,
} from "@/lib/markdown";

/**
 * 文件内容 / 改动 查看器。
 *
 * 三个此前缺失的能力：
 *  1. **按格式渲染**：Markdown 渲染成正文（可切源码），图片/音视频/PDF/DOCX 内嵌预览
 *  2. **明确告知不支持的格式**：压缩包、可执行文件等直接给「不支持预览 + 下载」，
 *     而不是把二进制当文本读成乱码（原来点 .tgz 会读 256KB 垃圾并卡住界面）
 *  3. **读取可中断**：切换文件立刻 abort 上一个请求，且用请求序号丢弃过期响应
 *     （原来是竞态：慢请求后到会覆盖掉新选中的文件）
 */

type ReadChunk = {
  content?: string;
  truncated?: boolean;
  nextOffset?: number;
  language?: string;
  size?: number;
  binary?: boolean;
  reason?: string;
  error?: string;
};

type Mode = "content" | "diff";

/** 由 MIME 分支处理的类型：不发文本请求，直接用流式 URL */
const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
const AUDIO_RE = /\.(mp3|wav|ogg|oga|opus|m4a|aac|flac|weba)$/i;
const VIDEO_RE = /\.(mp4|m4v|webm|mov|ogv)$/i;
const PDF_RE = /\.pdf$/i;
const DOCX_RE = /\.docx$/i;
const MARKDOWN_RE = /\.(md|mdx|markdown)$/i;

export function encodeFilePath(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean).map(encodeURIComponent).join("/");
  return `${path.startsWith("/") ? "/" : ""}${segments}`;
}

function formatSize(n: number | undefined): string {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function FileViewer({
  path,
  cwd,
  changedCode,
  defaultMode = "content",
  diffText,
  diffLoading,
  diffUnsupported,
  onClose,
}: {
  /** 当前选中的文件绝对路径；null = 空态 */
  path: string | null;
  cwd: string;
  /** 该文件的 git 状态码（有值才显示「改动」页签） */
  changedCode?: string;
  /** 进入时默认显示哪个页签（「只看改动」模式下默认看 diff） */
  defaultMode?: Mode;
  /** 已由父级取好的 diff 文本 */
  diffText?: string;
  diffLoading?: boolean;
  diffUnsupported?: boolean;
  onClose?: () => void;
}) {
  const [mode, setMode] = useState<Mode>("content");
  const [chunk, setChunk] = useState<ReadChunk | null>(null);
  const [loading, setLoading] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const reqSeq = useRef(0);

  const name = useMemo(() => (path ? path.split(/[\\/]/).pop() ?? path : ""), [path]);
  const isImage = path ? IMAGE_RE.test(path) : false;
  const isAudio = path ? AUDIO_RE.test(path) : false;
  const isVideo = path ? VIDEO_RE.test(path) : false;
  const isPdf = path ? PDF_RE.test(path) : false;
  const isDocx = path ? DOCX_RE.test(path) : false;
  const isMarkdown = path ? MARKDOWN_RE.test(path) : false;
  const streamable = isImage || isAudio || isVideo || isPdf;
  /* 已删除的文件在工作区里不存在：内容页签没有意义，直接进改动视图，
     也不再发一次必然失败的读取（原来会显示「读取失败 / 文件找不到」） */
  const deleted = changedCode === "D";

  /* 选中或默认模式变了：重置页签（删除的文件强制看改动） */
  useEffect(() => {
    setMode(deleted ? "diff" : defaultMode);
    setChunk(null);
    setShowSource(false);
  }, [path, defaultMode, deleted]);

  /* 文本类才请求内容；流式类型交给浏览器直接加载 URL；已删除的文件无从读取 */
  useEffect(() => {
    if (!path || streamable || isDocx || deleted) return;
    const seq = ++reqSeq.current;
    const controller = new AbortController();
    setLoading(true);
    fetch(`/api/files/${encodeFilePath(path)}?type=read`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((r) => r.json())
      .then((d: ReadChunk) => {
        // 序号守卫：慢请求后到时不覆盖新选中文件的内容
        if (seq === reqSeq.current) setChunk(d);
      })
      .catch((e: unknown) => {
        if (seq !== reqSeq.current) return;
        if (e instanceof DOMException && e.name === "AbortError") return;
        setChunk({ error: e instanceof Error ? e.message : String(e) });
      })
      .finally(() => {
        if (seq === reqSeq.current) setLoading(false);
      });
    // 切换文件 / 卸载时中止上一个请求 —— 原来慢读取会挡住后续操作
    return () => controller.abort();
  }, [path, streamable, isDocx, deleted]);

  if (!path) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-bg text-dim">
        <div className="flex flex-col items-center gap-2">
          <FileWarning size={20} strokeWidth={1.5} />
          <div className="text-[13px]">在左侧选择文件查看内容或改动</div>
        </div>
      </div>
    );
  }

  const lines = chunk?.content ? chunk.content.split("\n") : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg">
      {/* 文件头：路径 + 模式切换 + 下载 */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-panel/95 px-4">
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-fg" title={path}>
          {name}
          <span className="ml-2 font-mono text-[10px] text-dim">
            {path.slice(0, path.length - name.length - 1)}
          </span>
        </span>
        {changedCode && !deleted && (
          <div className="flex shrink-0 items-center rounded-md border border-line bg-panel-2 p-0.5">
            {(["content", "diff"] as Mode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                data-testid={`file-mode-${m}`}
                className={cn(
                  "h-6 cursor-pointer rounded-sm px-2 text-[11px] t-fast",
                  mode === m ? "bg-active font-medium text-accent" : "text-muted hover:text-fg",
                )}
              >
                {m === "content" ? "内容" : "改动"}
              </button>
            ))}
          </div>
        )}
        {deleted && (
          <span className="chip chip-danger shrink-0">已删除</span>
        )}
        {isMarkdown && !chunk?.binary && mode === "content" && (
          <button
            onClick={() => setShowSource((v) => !v)}
            className="btn btn-sm btn-subtle shrink-0"
            data-testid="md-toggle"
          >
            {showSource ? "看渲染" : "看源码"}
          </button>
        )}
        <a
          href={`/api/files/${encodeFilePath(path)}?type=download`}
          className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-dim t-fast hover:bg-hover hover:text-fg"
          title="下载"
        >
          <Download size={14} />
        </a>
        {onClose && (
          <button
            onClick={onClose}
            className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-dim t-fast hover:bg-hover hover:text-fg"
            title="关闭"
          >
            ×
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {/* ---------- 改动视图 ---------- */}
        {mode === "diff" ? (
          <div className="p-4">
            {diffLoading && (
              <div className="flex items-center gap-2 text-[12px] text-dim">
                <Loader2 size={14} className="anim-spin" /> 读取改动…
              </div>
            )}
            {!diffLoading && diffUnsupported && (
              <div className="text-[12px] text-dim">该文件类型不支持 Diff（二进制或已删除）</div>
            )}
            {!diffLoading && !diffUnsupported && diffText && <DiffView patch={diffText} />}
            {!diffLoading && !diffUnsupported && !diffText && (
              <div className="text-[12px] text-dim">没有可显示的改动内容</div>
            )}
          </div>
        ) : (
          <>
            {/* 图片 / 音视频 / PDF：直接流式加载 */}
            {isImage && (
              <div className="flex items-center justify-center p-6">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/files/${encodeFilePath(path)}?type=read`}
                  alt={name}
                  className="max-h-[70vh] max-w-full rounded-card border border-line object-contain"
                />
              </div>
            )}
            {isAudio && (
              <div className="p-6">
                <audio controls src={`/api/files/${encodeFilePath(path)}?type=read`} className="w-full" />
              </div>
            )}
            {isVideo && (
              <div className="flex justify-center p-6">
                <video
                  controls
                  src={`/api/files/${encodeFilePath(path)}?type=read`}
                  className="max-h-[70vh] max-w-full rounded-card border border-line"
                />
              </div>
            )}
            {isPdf && (
              <iframe
                src={`/api/files/${encodeFilePath(path)}?type=read`}
                title={name}
                className="h-full min-h-[70vh] w-full border-0"
              />
            )}
            {isDocx && (
              <iframe
                src={`/api/files/${encodeFilePath(path)}?type=preview`}
                title={name}
                className="h-full min-h-[70vh] w-full border-0 bg-white"
              />
            )}

            {/* 文本类 */}
            {!streamable && !isDocx && (
              <>
                {loading && (
                  <div className="flex items-center gap-2 p-4 text-[12px] text-dim">
                    <Loader2 size={14} className="anim-spin" /> 读取中…
                  </div>
                )}

                {/* 二进制：明确说不支持，而不是把乱码丢出来 */}
                {!loading && chunk?.binary && (
                  <div className="flex flex-col items-center gap-3 p-10 text-center">
                    <div className="flex size-12 items-center justify-center rounded-card bg-warn/10 text-warn">
                      <FileWarning size={20} />
                    </div>
                    <div className="text-[13px] font-medium text-fg">该文件类型不支持预览</div>
                    <div className="max-w-sm text-[12px] leading-relaxed text-dim">
                      这是二进制文件（{formatSize(chunk.size)}）
                      {chunk.reason === "binary-extension" ? "，扩展名属于压缩包 / 可执行文件 / 字体等类别" : ""}
                      。可以下载后用本机工具打开。
                    </div>
                    <a
                      href={`/api/files/${encodeFilePath(path)}?type=download`}
                      className="btn btn-primary"
                      data-testid="binary-download"
                    >
                      <Download size={12} /> 下载文件
                    </a>
                  </div>
                )}

                {!loading && chunk?.error && (
                  <div className="flex items-center gap-2 p-4 text-[12px] text-danger">
                    <AlertTriangle size={14} /> 读取失败：{chunk.error}
                  </div>
                )}

                {!loading && chunk?.content !== undefined && (
                  <>
                    {chunk.truncated && (
                      <div className="border-b border-line-soft bg-warn/10 px-4 py-1.5 text-[11px] text-warn">
                        文件较大，仅显示前 256KB
                      </div>
                    )}
                    {isMarkdown && !showSource ? (
                      <div className="md-body max-w-[820px] px-5 py-4 text-[13px] leading-relaxed text-fg">
                        <ReactMarkdown
                          remarkPlugins={markdownRemarkPlugins}
                          rehypePlugins={markdownRehypePlugins}
                          urlTransform={markdownUrlTransform}
                        >
                          {normalizeDisplayMath(chunk.content)}
                        </ReactMarkdown>
                      </div>
                    ) : (
                      <div className="flex min-w-full font-mono text-[12px] leading-5">
                        {/* 行号：读代码没有行号很难引用具体位置 */}
                        <div className="shrink-0 select-none border-r border-line-soft bg-panel/60 px-3 py-3 text-right text-dim/60">
                          {lines.map((_, i) => (
                            <div key={i}>{i + 1}</div>
                          ))}
                        </div>
                        <pre className="min-w-0 flex-1 overflow-x-auto px-4 py-3 whitespace-pre text-fg">
                          {chunk.content}
                        </pre>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** unified diff 渲染（与 Git 变更页此前一致的语义配色） */
export function DiffView({ patch }: { patch: string }) {
  return (
    <div className="overflow-x-auto rounded-card border border-line bg-panel-2 font-mono text-[12px] leading-5">
      {patch.split("\n").map((line, i) => {
        let cls = "text-fg";
        if (line.startsWith("@@")) cls = "text-muted";
        else if (line.startsWith("+")) cls = "bg-success/10 text-success";
        else if (line.startsWith("-")) cls = "bg-danger/10 text-danger";
        else if (line.startsWith("diff ") || line.startsWith("index ")) cls = "text-dim";
        return (
          <div key={i} className={cn("px-3 whitespace-pre", cls)}>
            {line || " "}
          </div>
        );
      })}
    </div>
  );
}
