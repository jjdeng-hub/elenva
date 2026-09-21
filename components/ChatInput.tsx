"use client";

import {
  ArrowUp,
  Check,
  ChevronDown,
  CornerDownRight,
  FastForward,
  Folder,
  Gauge,
  Layers,
  ListChecks,
  Paperclip,
  Slash,
  Square,
  Undo2,
  Wrench,
  X,
} from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/components/lib/utils";
import { compactionTrigger, useCompactionSettings } from "@/hooks/useCompactionSettings";
import { Popover } from "@/components/ui/popover";
import type { AttachedImage, ChatInputHandle, ThinkingLevelOption } from "@/hooks/useAgentSession";
import { MAX_ATTACHED_IMAGE_BYTES, MAX_ATTACHED_IMAGES } from "@/lib/image-attachments";
import type { ToolPreset } from "@/lib/tool-presets";
import type { ReactNode } from "react";

type SlashCommandInfo = { name: string; description?: string; source: string };
type FileMatch = { path: string; isDir: boolean };
type QueueState = { steering: string[]; followUp: string[] };

/** 命令菜单最多列多少条（面板可滚动，但一次给太多反而难扫） */
const SLASH_MENU_MAX = 12;

const fileToAttachedImage = (file: File): Promise<AttachedImage | null> =>
  new Promise((resolve) => {
    if (!file.type.startsWith("image/") || file.size > MAX_ATTACHED_IMAGE_BYTES) return resolve(null);
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      const comma = url.indexOf(",");
      if (!url.startsWith("data:") || comma < 0) return resolve(null);
      resolve({
        data: url.slice(comma + 1),
        mimeType: file.type,
        previewUrl: URL.createObjectURL(file),
      });
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
  {
    onSend,
    onSteer,
    onFollowUp,
    onRecallQueue,
    queuedMessages,
    onNotice,
    onStop,
    running,
    disabled,
    placeholder,
    slashCommands,
    cwd,
    modelPicker,
    toolPreset,
    onToolPresetChange,
    planMode,
    onTogglePlanMode,
    contextUsage,
    onCompactContext,
    onAbortCompaction,
    compactingContext,
    contextHistory,
    thinkingLevel,
    thinkingLevels = [],
    onThinkingLevelChange,
    extensionAbove,
    extensionBelow,
    draftKey: draftKeyProp,
    footerLeft,
  },
  ref,
) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /* 草稿 key：可被 rekeyDraft 更新（新会话创建后迁移到正式会话 id） */
  const [draftKey, setDraftKey] = useState(draftKeyProp);
  const draftKeyRef = useRef(draftKeyProp);
  useEffect(() => {
    setDraftKey(draftKeyProp);
    draftKeyRef.current = draftKeyProp;
  }, [draftKeyProp]);

  // 草稿恢复：draftKey 变化（即会话切换重挂载）时读取
  useEffect(() => {
    if (!draftKey) return;
    try {
      setText(localStorage.getItem(`elenva-draft:${draftKey}`) ?? "");
    } catch { /* ignore */ }
  }, [draftKey]);

  // 写入草稿：显式走更新函数，避免挂载时空值 effect 覆盖已存草稿
  const updateText = useCallback((v: string) => {
    setText(v);
    const key = draftKeyRef.current;
    if (!key) return;
    try {
      localStorage.setItem(`elenva-draft:${key}`, v);
    } catch { /* ignore */ }
  }, []);

  /* ---------- 图片附件 ---------- */
  const addImages = useCallback(
    (files: File[] | FileList) => {
      const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
      if (list.length === 0) return;
      const room = MAX_ATTACHED_IMAGES - images.length;
      if (room <= 0) {
        onNotice?.(`一条消息最多附带 ${MAX_ATTACHED_IMAGES} 张图片`);
        return;
      }
      if (list.length > room) onNotice?.(`一次最多再添加 ${room} 张图片`);
      Promise.all(list.slice(0, room).map(fileToAttachedImage)).then((results) => {
        const ok = results.filter((x): x is AttachedImage => x !== null);
        const rejected = list.slice(0, room).length - ok.length;
        if (rejected > 0) {
          onNotice?.(`有 ${rejected} 张图片未添加（仅支持图片，且单张不超过 10MB）`);
        }
        if (ok.length > 0) setImages((prev) => [...prev, ...ok]);
      });
    },
    [images.length, onNotice],
  );

  const removeImage = (index: number) => {
    setImages((prev) => {
      URL.revokeObjectURL(prev[index].previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  };

  const clearImages = useCallback(() => {
    setImages((prev) => {
      prev.forEach((img) => URL.revokeObjectURL(img.previewUrl));
      return [];
    });
  }, []);

  useEffect(() => () => images.forEach((img) => URL.revokeObjectURL(img.previewUrl)), []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- 命令式句柄（hook 通过 chatInputRef 驱动） ---------- */
  const insertAtCaret = useCallback(
    (content: string) => {
      const el = areaRef.current;
      if (!el) {
        updateText(text + content);
        return;
      }
      const start = el.selectionStart ?? text.length;
      const end = el.selectionEnd ?? start;
      const next = text.slice(0, start) + content + text.slice(end);
      updateText(next);
      requestAnimationFrame(() => {
        el.focus();
        const caret = start + content.length;
        el.setSelectionRange(caret, caret);
      });
    },
    [text, updateText],
  );

  useImperativeHandle(
    ref,
    (): ChatInputHandle => ({
      insertText: (t) => insertAtCaret(t),
      insertIfEmpty: (content) => {
        setText((prev) => {
          if (prev.trim()) return prev;
          try {
            const key = draftKeyRef.current;
            if (key) localStorage.setItem(`elenva-draft:${key}`, content);
          } catch { /* ignore */ }
          return content;
        });
      },
      replaceMessage: (message) => {
        const content = message.content;
        let nextText = "";
        const nextImages: AttachedImage[] = [];
        if (typeof content === "string") {
          nextText = content;
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text") nextText += block.text;
            else if (block.type === "image" && block.source?.type === "base64" && block.source.data) {
              nextImages.push({
                data: block.source.data,
                mimeType: block.source.media_type || "image/png",
                previewUrl: `data:${block.source.media_type || "image/png"};base64,${block.source.data}`,
              });
            }
          }
        }
        updateText(nextText);
        clearImages();
        if (nextImages.length) setImages(nextImages);
        areaRef.current?.focus();
      },
      prependText: (t) => {
        setText((prev) => {
          const next = prev ? `${t}\n\n${prev}` : t;
          try {
            const key = draftKeyRef.current;
            if (key) localStorage.setItem(`elenva-draft:${key}`, next);
          } catch { /* ignore */ }
          return next;
        });
        areaRef.current?.focus();
      },
      addImages: (files) => addImages(files),
      rekeyDraft: (previousKey, nextKey) => {
        try {
          const stored = localStorage.getItem(`elenva-draft:${previousKey}`);
          if (stored !== null) {
            localStorage.setItem(`elenva-draft:${nextKey}`, stored);
            localStorage.removeItem(`elenva-draft:${previousKey}`);
          }
        } catch { /* ignore */ }
        draftKeyRef.current = nextKey;
        setDraftKey(nextKey);
      },
      restoreSubmission: (t, imgs, targetDraftKey) => {
        const key = targetDraftKey ?? draftKeyRef.current;
        if (key === draftKeyRef.current) {
          updateText(t);
          if (imgs?.length) {
            setImages(
              imgs.map((img) => ({
                ...img,
                previewUrl: `data:${img.mimeType};base64,${img.data}`,
              })),
            );
          }
        } else {
          try {
            localStorage.setItem(`elenva-draft:${key}`, t);
          } catch { /* ignore */ }
        }
        areaRef.current?.focus();
      },
    }),
    [insertAtCaret, updateText, addImages, clearImages],
  );

  /* ---------- 发送 / 队列 ---------- */
  const submit = (mode?: "steer" | "followUp") => {
    const t = text.trim();
    if (disabled) return;
    if (!t && images.length === 0) return;
    const imgs = images.length > 0 ? images : undefined;
    setSlashOpen(false);
    setMention(null);
    setFileMatches([]);
    if (running) {
      /* 原来这里是 `if (!t) return;` —— agent 运行中只贴了图片、没打文字时，
         整条消息（含附件）被静默丢弃。图片本身就是有效输入，不该被文字条件挡住。 */
      if (mode === "followUp") onFollowUp?.(t, imgs);
      else onSteer?.(t, imgs);
    } else {
      onSend(t, imgs);
    }
    updateText("");
    clearImages();
  };

  const hasQueue = (queuedMessages?.steering.length ?? 0) + (queuedMessages?.followUp.length ?? 0) > 0;
  const canSend = (text.trim().length > 0 || images.length > 0) && !disabled;

  /* ---------- slash 菜单状态 ---------- */
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);

  // @文件 状态
  const [mention, setMention] = useState<{ token: string; start: number } | null>(null);
  const [fileMatches, setFileMatches] = useState<FileMatch[]>([]);
  const [fileIndex, setFileIndex] = useState(0);
  const [filesLoading, setFilesLoading] = useState(false);
  const mentionAbort = useRef<AbortController | null>(null);

  const resize = () => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  };

  useEffect(resize, [text]);

  /* ---------- slash 菜单逻辑 ---------- */
  const slashQuery = slashOpen ? text.slice(1).split(/\s/)[0]?.toLowerCase() ?? "" : "";
  const slashMatches = slashOpen
    ? slashCommands.filter((c) => c.name.toLowerCase().startsWith(slashQuery)).slice(0, SLASH_MENU_MAX)
    : [];

  const applySlash = (name: string) => {
    updateText(`/${name} `);
    setSlashOpen(false);
    areaRef.current?.focus();
  };

  /* ---------- @文件 逻辑 ---------- */
  /*
   * 识别 @ 引用。
   *
   * 关键：token / start 未变时必须**返回原对象**，否则每次 keyup 都产生新引用 →
   * 下方拉取文件列表的 effect 重跑 → 里面的 setFileIndex(0) 把高亮重置回第一项，
   * 表现为「上下键按下去没反应」（实测如此）。
   */
  const detectMention = (value: string, caret: number) => {
    // @ 必须在开头或前面是空白（与 TUI 规则一致）
    const before = value.slice(0, caret);
    const m = /(?:^|\s)@([^\s@]*)$/.exec(before);
    if (m) {
      const token = m[1];
      const start = caret - token.length;
      setMention((prev) => (prev && prev.token === token && prev.start === start ? prev : { token, start }));
    } else {
      setMention((prev) => (prev === null ? prev : null));
      setFileMatches((prev) => (prev.length === 0 ? prev : []));
    }
  };

  useEffect(() => {
    if (!mention || !cwd) {
      setFileMatches((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const token = mention.token;
    if (token.length === 0) {
      // 空查询拉索引（前端展示前 20 个即可）
      setFilesLoading(true);
      fetch(`/api/file-index?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => {
          const list: FileMatch[] = d.matches
            ? d.matches.slice(0, 20)
            : (d.files ?? []).map((p: string) => ({ path: p, isDir: false })).slice(0, 20);
          setFileMatches(list);
          setFileIndex(0);
        })
        .catch(() => setFileMatches([]))
        .finally(() => setFilesLoading(false));
      return;
    }
    const t = setTimeout(() => {
      setFilesLoading(true);
      mentionAbort.current?.abort();
      mentionAbort.current = new AbortController();
      fetch(`/api/file-index?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(token)}`, {
        cache: "no-store",
        signal: mentionAbort.current.signal,
      })
        .then((r) => r.json())
        .then((d) => {
          setFileMatches(d.matches ?? []);
          setFileIndex(0);
        })
        .catch(() => {})
        .finally(() => setFilesLoading(false));
    }, 150);
    return () => clearTimeout(t);
  }, [mention, cwd]);

  const applyFile = (fm: FileMatch) => {
    if (!mention) return;
    const el = areaRef.current;
    const insert = fm.path.includes(" ") ? `@"${fm.path}" ` : `${fm.path} `;
    const newText = text.slice(0, mention.start) + insert + text.slice(mention.start + mention.token.length);
    updateText(newText);
    setMention(null);
    setFileMatches([]);
    const caret = mention.start + insert.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  };

  const showSlashMenu = slashOpen && slashMatches.length > 0;
  const showFileMenu = mention !== null && fileMatches.length > 0;

  return (
    <div className="relative pb-4">
      <div className="chat-col">
        <div className="relative">
          {/* slash 命令菜单 */}
          {showSlashMenu && (
            <div className="absolute bottom-full left-0 z-50 mb-2 w-80 overflow-hidden rounded-card border border-line bg-panel shadow-lg">
              <div className="flex items-center gap-1.5 border-b border-line-soft px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-dim">
                <Slash size={10} /> 命令
              </div>
              <div className="max-h-56 overflow-y-auto py-1">
                {slashMatches.map((c, i) => (
                  <button
                    key={`${c.source}-${c.name}`}
                    onClick={() => applySlash(c.name)}
                    onMouseEnter={() => setSlashIndex(i)}
                    className={cn(
                      "flex w-full cursor-pointer items-baseline gap-2 px-3 py-1.5 text-left t-fast",
                      i === slashIndex ? "bg-hover" : "",
                    )}
                  >
                    <span className="shrink-0 font-mono text-[12px] font-medium text-accent">/{c.name}</span>
                    {c.description && (
                      <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{c.description}</span>
                    )}
                    <span className="shrink-0 text-[10px] text-dim">{c.source}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* @文件 菜单 */}
          {showFileMenu && (
            <div className="absolute bottom-full left-0 z-50 mb-2 w-96 overflow-hidden rounded-card border border-line bg-panel shadow-lg">
              <div className="flex items-center gap-1.5 border-b border-line-soft px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-dim">
                <Folder size={10} /> 文件引用 {filesLoading && <Loader2Inline />}
              </div>
              <div className="max-h-56 overflow-y-auto py-1">
                {fileMatches.map((fm, i) => (
                  <button
                    key={fm.path}
                    onClick={() => applyFile(fm)}
                    onMouseEnter={() => setFileIndex(i)}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left t-fast",
                      i === fileIndex ? "bg-hover" : "",
                    )}
                  >
                    <Folder size={12} className={cn("shrink-0", fm.isDir ? "text-accent/70" : "text-dim/50")} />
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg">{fm.path}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 消息队列条 */}
          {hasQueue && (
            <div
              data-testid="queue-strip"
              className="mb-1.5 flex flex-wrap items-center gap-1.5 rounded-lg border border-accent/25 bg-accent-soft/40 px-2.5 py-1.5"
            >
              <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-accent">
                队列
              </span>
              {queuedMessages!.steering.map((t, i) => (
                <span
                  key={`s-${i}`}
                  title={`插话：${t}`}
                  className="chip chip-accent min-w-0 max-w-64"
                >
                  <CornerDownRight size={10} className="shrink-0 text-accent" />
                  <span className="truncate">{t}</span>
                </span>
              ))}
              {queuedMessages!.followUp.map((t, i) => (
                <span
                  key={`f-${i}`}
                  title={`跟发：${t}`}
                  className="chip min-w-0 max-w-64"
                >
                  <FastForward size={10} className="shrink-0 text-dim" />
                  <span className="truncate">{t}</span>
                </span>
              ))}
              {onRecallQueue && (
                <button
                  onClick={onRecallQueue}
                  title="取回队列消息到输入框（队列清空）"
                  className="btn btn-sm btn-subtle ml-auto shrink-0"
                >
                  <Undo2 size={12} /> 召回
                </button>
              )}
            </div>
          )}

          {/* 输入框 */}
          <div
            data-testid="chat-input-box"
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (e.dataTransfer.files.length) addImages(e.dataTransfer.files);
            }}
            className={cn(
              "flex flex-col gap-2 rounded-card border bg-panel px-4 py-3 shadow-sm t-fast",
              dragOver ? "border-accent bg-accent-soft/30" : "border-line",
              "focus-within:border-accent/60 focus-within:shadow-[0_0_0_3px_var(--accent-soft)]",
            )}
          >
            {/* 图片预览条（整行） */}
            {images.length > 0 && (
              <div className="flex w-full flex-wrap gap-1.5 pb-1" data-testid="image-previews">
                {images.map((img, i) => (
                  <div key={img.previewUrl} className="group relative">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={img.previewUrl}
                      alt={`附件 ${i + 1}`}
                      className="size-14 rounded-lg border border-line object-cover"
                    />
                    <button
                      onClick={() => removeImage(i)}
                      title="移除图片"
                      className="absolute -right-1.5 -top-1.5 flex size-4.5 cursor-pointer items-center justify-center rounded-full bg-danger text-white shadow-sm transition-transform hover:scale-110"
                    >
                      <X size={10} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex min-h-[44px] items-start">
              <textarea
                ref={areaRef}
                value={text}
                onChange={(e) => {
                  const v = e.target.value;
                  updateText(v);
                  setSlashOpen(v.startsWith("/") && !v.includes(" "));
                  const caret = e.target.selectionStart ?? v.length;
                  detectMention(v, caret);
                }}
                onKeyUp={(e) => {
                  const caret = e.currentTarget.selectionStart ?? text.length;
                  detectMention(text, caret);
                }}
                onPaste={(e) => {
                  if (e.clipboardData.files.length) {
                    e.preventDefault();
                    addImages(e.clipboardData.files);
                  }
                }}
                onKeyDown={(e) => {
                  // slash 菜单键盘导航
                  if (showSlashMenu) {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setSlashIndex((i) => Math.min(i + 1, slashMatches.length - 1));
                      return;
                    }
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setSlashIndex((i) => Math.max(i - 1, 0));
                      return;
                    }
                    if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing)) {
                      e.preventDefault();
                      applySlash(slashMatches[slashIndex].name);
                      return;
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setSlashOpen(false);
                      return;
                    }
                  }
                  // @文件 菜单键盘导航
                  if (showFileMenu) {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setFileIndex((i) => Math.min(i + 1, fileMatches.length - 1));
                      return;
                    }
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setFileIndex((i) => Math.max(i - 1, 0));
                      return;
                    }
                    if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing)) {
                      e.preventDefault();
                      applyFile(fileMatches[fileIndex]);
                      return;
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setMention(null);
                      setFileMatches([]);
                      return;
                    }
                  }
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    if (running && e.altKey) submit("followUp");
                    else submit(running ? "steer" : undefined);
                  }
                }}
                rows={1}
                placeholder={
                  placeholder ||
                  (running
                    ? "Agent 工作中：Enter 插话纠偏 · Alt+Enter 排队跟发"
                    : "让 agent 做点什么…（/ 命令 · @ 文件 · ! shell · Enter 发送）")
                }
                className="max-h-[220px] w-full resize-none bg-transparent py-0.5 text-[13px] leading-relaxed text-fg outline-none placeholder:text-dim"
              />
            </div>
            {/* 底部工具栏：功能在左、发送在右（与输入区同一容器） */}
            <div className="flex items-center gap-2">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="flex size-7 shrink-0 items-center justify-center rounded-md text-dim hover:bg-hover hover:text-fg cursor-pointer"
                  title="添加图片（可粘贴 / 拖拽到输入框）"
                >
                  <Paperclip size={14} />
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={(e) => {
                    if (e.target.files) addImages(e.target.files);
                    e.target.value = "";
                  }}
                />
                {onToolPresetChange && (
                  <ToolPresetPicker value={toolPreset ?? "default"} disabled={running} onChange={onToolPresetChange} />
                )}
                {onTogglePlanMode && (
                  <button
                    onClick={() => onTogglePlanMode(!planMode)}
                    className={cn(
                      "flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md border px-1.5 text-[11px] t-fast",
                      planMode
                        ? "border-accent/50 bg-accent-soft text-accent"
                        : "border-line bg-panel-2 text-dim hover:text-fg",
                    )}
                    title={planMode
                      ? "计划模式已开启：先只读勘察并提交计划，经你批准后才动手"
                      : "开启计划模式：先看方案再动手"}
                    data-testid="plan-mode-toggle"
                  >
                    <ListChecks size={12} />
                    计划
                  </button>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <ContextRing
                  usage={contextUsage ?? null}
                  onCompact={onCompactContext}
                  onAbortCompaction={onAbortCompaction}
                  compacting={compactingContext}
                  history={contextHistory}
                />
                {modelPicker}
                {onThinkingLevelChange && thinkingLevels.length > 0 && (
                  <ThinkingPicker
                    value={thinkingLevel ?? "auto"}
                    options={thinkingLevels}
                    disabled={running}
                    onChange={onThinkingLevelChange}
                  />
                )}
                {running && (
                  <button
                    onClick={() => submit("steer")}
                    disabled={!canSend}
                    className={cn(
                      "flex size-8 items-center justify-center rounded-full transition-all",
                      canSend
                        ? "cursor-pointer border border-accent/40 bg-accent-soft text-accent hover:bg-active"
                        : "text-dim/60",
                    )}
                    title="插话（Enter）— 立即送达当前回合；Alt+Enter 排队跟发"
                  >
                    <CornerDownRight size={14} />
                  </button>
                )}
                {running ? (
                  <button
                    onClick={onStop}
                    className="flex size-8 shrink-0 items-center justify-center rounded-full bg-danger/90 text-white transition-opacity hover:opacity-85 cursor-pointer"
                    title="停止"
                  >
                    <Square size={12} fill="currentColor" />
                  </button>
                ) : (
                  <button
                    onClick={() => submit()}
                    disabled={!canSend}
                    className={cn(
                      "flex size-8 shrink-0 items-center justify-center rounded-full transition-all cursor-pointer",
                      canSend
                        ? "bg-accent text-accent-fg hover:bg-accent-hover"
                        : "bg-panel-2 text-dim",
                    )}
                    title="发送"
                  >
                    <ArrowUp size={14} />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
        {extensionBelow}
        {footerLeft}
      </div>
    </div>
  );
});

/**
 * 最近一次上下文压缩的摘要信息。
 *
 * 上下文环形进度只能告诉你「用了多少」，回答不了「为什么变糊了」——
 * 压缩才是长会话质量下降的主因，而它以前只在状态栏一闪而过。
 */
export interface ContextHistory {
  /** 压缩发生前的 token 占用（内核记录） */
  tokensBefore: number | null;
  /** 压缩之后又累积的消息条数 */
  keptMessages: number;
}

interface ChatInputProps {
  onSend: (text: string, images?: AttachedImage[]) => void;
  /** agent 运行中发送 = 插话（steer） */
  onSteer?: (text: string, images?: AttachedImage[]) => void;
  /** agent 运行中 Alt+Enter = 跟发（followUp，全部工作结束后送达） */
  onFollowUp?: (text: string, images?: AttachedImage[]) => void;
  onRecallQueue?: () => void;
  queuedMessages?: QueueState;
  onNotice?: (message: string) => void;
  onStop: () => void;
  running: boolean;
  disabled?: boolean;
  placeholder?: string;
  slashCommands: SlashCommandInfo[];
  cwd: string | null;
  modelPicker?: ReactNode;
  /** 当前工具预设（hook 已维护状态与应用逻辑） */
  toolPreset?: ToolPreset;
  /** 切换工具预设（运行中会被后端拒绝，UI 此时禁用） */
  onToolPresetChange?: (preset: ToolPreset) => void;
  /** 计划模式：只做只读勘察，提交计划经用户批准后才允许改动 */
  planMode?: boolean;
  onTogglePlanMode?: (enabled: boolean) => void;
  /** 上下文占用（环形进度，工具行右侧常驻） */
  contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  /** 最近一次压缩（环形弹层里展示，解释上下文是怎么变成现在这样的） */
  contextHistory?: ContextHistory | null;
  /** 当前推理强度（随模型而异的档位；在工具行右侧常驻） */
  thinkingLevel?: string;
  /** 当前模型支持的推理档位；空数组 = 该模型不支持，不显示思考 chip */
  thinkingLevels?: string[];
  onThinkingLevelChange?: (level: ThinkingLevelOption) => void;
  /** 压缩上下文（渲染在上下文环的弹出菜单里；不传则环仅为展示） */
  onCompactContext?: () => void;
  /** 中止正在进行的压缩 */
  onAbortCompaction?: () => void;
  /** 是否正在压缩 */
  compactingContext?: boolean;
  /** 扩展挂件（编辑器上方：状态行 + aboveEditor 挂件） */
  extensionAbove?: ReactNode;
  /** 扩展挂件（编辑器下方：belowEditor 挂件） */
  extensionBelow?: ReactNode;
  /** 输入草稿的 localStorage 键（切换会话保留草稿） */
  draftKey?: string;
  /** 输入卡片底部左侧插槽（新会话的工作区选择器；空 = 不渲染该行） */
  footerLeft?: ReactNode;
}

/**
 * 工作模式（UI 三档，对应 lib/tool-presets 的四个值）：
 *   问答 = none        不用工具，纯对话
 *   只读 = read-only   能看不能改（read · grep · find · ls）
 *   Agent = full       读写执行全开
 * default（缺 grep/find/ls 的旧档）在 UI 上并入 Agent 显示，值保留做兼容。
 */
const TOOL_PRESET_OPTIONS: { value: ToolPreset; label: string; desc: string }[] = [
  { value: "none", label: "问答", desc: "不使用工具，仅对话" },
  { value: "read-only", label: "只读", desc: "能看不能改 · read · grep · find · ls" },
  { value: "full", label: "Agent", desc: "读写文件 · 执行命令 · 搜索代码" },
];

function ToolPresetPicker({
  value,
  disabled,
  onChange,
}: {
  value: ToolPreset;
  disabled?: boolean;
  onChange: (p: ToolPreset) => void;
}) {
  // default 是自定义组合的兜底归类，能力上视同 Agent
  const effective: ToolPreset = value === "default" ? "full" : value;
  const current = TOOL_PRESET_OPTIONS.find((o) => o.value === effective) ?? TOOL_PRESET_OPTIONS[2];
  return (
    <Popover
      containerClassName="shrink-0"
      panelClassName="bottom-full mb-1.5"
      trigger={({ open, toggle }) => (
        <button
          onClick={toggle}
          disabled={disabled}
          title={disabled ? "Agent 运行中，暂不能切换工具集" : "切换工具预设"}
          className="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-[12px] text-muted t-fast hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Wrench size={12} className="shrink-0 text-dim" />
          <span>{current.label}</span>
          <ChevronDown size={12} className={cn("shrink-0 text-dim transition-transform", open && "rotate-180")} />
        </button>
      )}
    >
      {(close) => (
        <div className="py-1" data-testid="tool-preset-menu">
          {TOOL_PRESET_OPTIONS.map((o) => (
            <button
              key={o.value}
              onClick={() => {
                close();
                if (o.value !== effective) onChange(o.value);
              }}
              className={cn(
                "flex w-full cursor-pointer flex-col items-start gap-0.5 px-3 py-1.5 text-left t-fast hover:bg-hover",
                o.value === effective && "bg-active",
              )}
            >
              <span className="flex w-full items-center gap-1.5 text-[12px] text-fg">
                {o.label}
                {o.value === effective && <Check size={12} className="ml-auto text-accent" />}
              </span>
              <span className="font-mono text-[10px] text-dim">{o.desc}</span>
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}

/** 推理强度：工具行右侧常驻；仅当前模型支持档位时渲染（auto = 跟随模型默认）。 */
function ThinkingPicker({
  value,
  options,
  disabled,
  onChange,
}: {
  value: string;
  options: string[];
  disabled?: boolean;
  onChange: (level: ThinkingLevelOption) => void;
}) {
  const levels = useMemo(() => ["auto", ...options.filter((o) => o !== "auto")], [options]);
  const current = levels.includes(value) ? value : "auto";
  return (
    <Popover
      containerClassName="shrink-0"
      panelClassName="bottom-full mb-1.5"
      trigger={({ open, toggle }) => (
        <button
          onClick={toggle}
          disabled={disabled}
          title={disabled ? "Agent 运行中，暂不能切换推理强度" : "切换推理强度"}
          className="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-[12px] text-muted t-fast hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
        >
          {/* 去掉「思考」标签，用 Gauge 表意「强度档位」。
              原先用 Brain 会和侧栏「记忆」的图标撞车 —— 同一图标指两个概念会误导。 */}
          <Gauge size={12} className="shrink-0 text-dim" />
          <span className="text-fg">{current}</span>
          <ChevronDown size={12} className={cn("shrink-0 text-dim transition-transform", open && "rotate-180")} />
        </button>
      )}
    >
      {(close) => (
        <div className="py-1" data-testid="thinking-menu">
          {levels.map((lv) => (
            <button
              key={lv}
              onClick={() => {
                close();
                if (lv !== value) onChange(lv as ThinkingLevelOption);
              }}
              className={cn(
                "flex w-full cursor-pointer items-center gap-1.5 px-3 py-1.5 text-left text-[12px] t-fast hover:bg-hover",
                lv === current ? "bg-active text-fg" : "text-muted",
              )}
            >
              {lv}
              {lv === current && <Check size={12} className="ml-auto text-accent" />}
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}

function Loader2Inline() {
  return <span className="inline-block size-2.5 animate-spin rounded-full border border-dim border-t-transparent" />;
}

/**
 * 上下文占用环形指示：进度 = 占用百分比（与顶栏 ctx chip 同语义）。
 * ≥75% 转警示色、≥90% 转危险色；无数据时不渲染。
 */
function ContextRing({
  usage,
  onCompact,
  onAbortCompaction,
  compacting,
  history,
}: {
  usage: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  /** 压缩上下文（与观测栏里的入口是同一动作，走同一份实现） */
  onCompact?: () => void;
  onAbortCompaction?: () => void;
  compacting?: boolean;
  /** 本会话最近一次压缩：让「上下文怎么变成现在这样」有处可查 */
  history?: ContextHistory | null;
}) {
  /* Hook 必须在提前 return 之前调用 —— 否则 usage 在 null/非 null 间切换时
     hook 调用顺序会变，React 会报错（实测踩到）。 */
  const compaction = useCompactionSettings();
  const trigger = compactionTrigger(usage?.contextWindow ?? 0, compaction.reserveTokens);

  if (!usage || (usage.percent === null && usage.tokens === null)) return null;
  const pct = Math.max(
    0,
    Math.min(100, Math.round(usage.percent ?? ((usage.tokens ?? 0) / Math.max(1, usage.contextWindow)) * 100)),
  );
  // 颜色档位与内核的真实触发点对齐，而不是固定的 75/90
  const tone = pct >= trigger.percent ? "text-danger" : pct >= trigger.percent - 10 ? "text-warn" : "text-dim";
  const title =
    `上下文已用 ${pct}% · ${(usage.tokens ?? 0).toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens`
    + (compaction.enabled ? `（约 ${trigger.percent}% 时内核自动压缩）` : "（自动压缩已关闭）");

  const R = 6.5;
  const C = 2 * Math.PI * R;
  const ring = (
    <svg width="16" height="16" viewBox="0 0 16 16" className={tone} aria-label={`上下文已用 ${pct}%`}>
        <circle cx="8" cy="8" r={R} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
        <circle
          cx="8"
          cy="8"
          r={R}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${(C * pct) / 100} ${C}`}
          transform="rotate(-90 8 8)"
        />
    </svg>
  );

  // 没有压缩入口时保持纯展示（避免多点一下毫无反馈）
  if (!onCompact) {
    return (
      <span className="flex size-7 shrink-0 items-center justify-center" title={title} data-testid="context-ring">
        {ring}
      </span>
    );
  }

  return (
    <Popover
      containerClassName="shrink-0"
      panelClassName="bottom-full mb-1.5 w-60"
      trigger={({ toggle }) => (
        <button
          onClick={toggle}
          title={title}
          aria-label={`上下文已用 ${pct}%，点击管理`}
          data-testid="context-ring"
          className="flex size-7 cursor-pointer items-center justify-center rounded-md t-fast hover:bg-hover"
        >
          {ring}
        </button>
      )}
    >
      {/* Popover 的 children 是「接收 close 的函数」——压缩后顺手关掉菜单 */}
      {(close) => (
      <div className="px-3 py-2">
        <div className="text-[12px] font-semibold text-fg">上下文窗口</div>
        <div className="mt-1 text-[11px] leading-relaxed text-dim">
          已用 <span className="tabular-nums text-fg">{pct}%</span> ·{" "}
          <span className="tabular-nums">{(usage.tokens ?? 0).toLocaleString()}</span> /{" "}
          <span className="tabular-nums">{usage.contextWindow.toLocaleString()}</span> tokens
        </div>
        {/* 把内核的真实阈值显示出来：用户不需要盯着百分比猜要不要动手 */}
        <div className="mt-1.5 text-[11px] leading-relaxed text-dim">
          {compaction.enabled ? (
            <>
              内核会在约 <span className="tabular-nums text-fg">{trigger.tokens.toLocaleString()}</span> tokens（
              <span className="tabular-nums">{trigger.percent}%</span>
              ）时自动压缩，无需手动处理。
            </>
          ) : (
            <span className="text-warn">自动压缩已在设置中关闭，接近上限时需手动压缩。</span>
          )}
        </div>
        <div className="mt-1.5 text-[11px] leading-relaxed text-dim">
          {history
            ? (
              <>
                上次压缩丟掉了压缩前的 <span className="tabular-nums text-fg">{(history.tokensBefore ?? 0).toLocaleString()}</span> tokens，
                之后又累积了 <span className="tabular-nums text-fg">{history.keptMessages}</span> 条消息。
                压缩摘要可以在对话里展开查看。
              </>
            )
            : (
              <span>本会话尚未压缩过。回答开始“变糊”时，多半是上下文被总结过或已经接近上限。</span>
            )}
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          {compacting ? (
            <button
              onClick={() => onAbortCompaction?.()}
              className="btn btn-sm btn-ghost text-danger"
            >
              停止压缩
            </button>
          ) : (
            <button
              onClick={() => {
                close();
                onCompact();
              }}
              data-testid="compact-context"
              className="btn btn-sm btn-ghost"
            >
              提前压缩（换话题 / 省 token）
            </button>
          )}
        </div>
        <div className="mt-1.5 text-[10px] leading-relaxed text-dim/70">
          压缩会把较早的历史总结掉（保留最近约 {Math.round(compaction.keepRecentTokens / 1000)}k tokens），
          原始记录仍完整保留在会话文件中。
        </div>
      </div>
      )}
    </Popover>
  );
}

