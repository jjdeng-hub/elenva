"use client";

import { AlertTriangle, Bookmark, Bot, ChevronDown, Copy, Download, FileCode2, History, Loader2, Search, Square, Terminal, User, Wrench } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { cn } from "@/components/lib/utils";
import { CopyButton } from "@/components/ui/widgets";
import { Popover } from "@/components/ui/popover";
import { toast } from "@/components/ui/dialog";
import {
  markdownRehypePlugins,
  markdownRemarkPlugins,
  markdownUrlTransform,
  normalizeDisplayMath,
} from "@/lib/markdown";
import { copyText } from "@/lib/clipboard";
import { formatClock, formatDuration } from "@/lib/format";
import { stripControlSequences } from "@/lib/tool-execution-progress";
import { toolTiming } from "@/lib/tool-timing";
import type { AgentMessage, AssistantContentBlock, AssistantMessage, BashExecutionMessage, CustomMessage, TextContent, ToolCallContent, ToolResultMessage, UserMessage } from "@/lib/types";
import { imageBlockSrc } from "@/lib/image-block";
import { isEditToolName, isWriteToolName } from "@/lib/tool-names";

/* ---------------- content block renderers ---------------- */

function ThinkingBlock({
  text,
  streaming,
  deferred,
  sessionId,
  entryId,
  blockIndex,
}: {
  text: string;
  streaming?: boolean;
  /** 服务端为控制首屏体积只给了预览，完整内容需按需拉取 */
  deferred?: boolean;
  sessionId?: string | null;
  entryId?: string | null;
  blockIndex?: number;
}) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const canLoadFull = Boolean(deferred && sessionId && entryId && blockIndex !== undefined);
  const body = full ?? text;

  const loadFull = useCallback(async () => {
    if (!canLoadFull || loading) return;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId!)}/entries/${encodeURIComponent(entryId!)}/thinking?blockIndex=${blockIndex}`,
        { cache: "no-store" },
      );
      const d = (await res.json()) as { thinking?: string; error?: string };
      if (!res.ok) throw new Error(d.error || `读取失败（HTTP ${res.status}）`);
      setFull(d.thinking ?? "");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [canLoadFull, loading, sessionId, entryId, blockIndex]);

  return (
    <div className="my-1 overflow-hidden rounded-lg border border-line bg-panel-2/60">
      <button
        onClick={() => {
          const next = !open;
          setOpen(next);
          // 展开时自动补齐完整思考，省得用户再点一次
          if (next && canLoadFull && full === null) void loadFull();
        }}
        className="flex w-full cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-[12px] text-dim hover:text-muted"
      >
        <ChevronDown size={14} className={cn("transition-transform", open && "rotate-180")} />
        <span className={cn(streaming && "anim-pulse-dot")}>思考过程</span>
        {!open && <span className="truncate text-dim/70">{text.slice(0, 80)}</span>}
        {open && loading && <Loader2 size={10} className="anim-spin shrink-0 text-accent" />}
      </button>
      {open && (
        <div className="max-h-72 overflow-y-auto border-t border-line px-3 py-2 text-[12px] whitespace-pre-wrap text-muted">
          {body}
          {loadError && (
            <div className="mt-1.5 text-danger">
              {loadError}{" "}
              <button onClick={() => void loadFull()} className="cursor-pointer underline">
                重试
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ToolNameIcon({ name }: { name: string }) {
  if (/bash|shell|cmd/i.test(name)) return <Terminal size={12} />;
  if (/read|write|edit|file/i.test(name)) return <FileCode2 size={12} />;
  return <Wrench size={12} />;
}

function toolInputSummary(input: Record<string, unknown> | undefined, rawInput?: string): string {
  if (rawInput !== undefined && rawInput !== "") return rawInput;
  if (!input) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    parts.push(`${k}: ${s.length > 60 ? s.slice(0, 60) + "…" : s}`);
  }
  return parts.join("  ·  ");
}

/** 宿主自带工具的展示名（原始名字是英文标识符，直接摆出来不好认） */
const HOST_TOOL_LABELS: Record<string, string> = {
  present_plan: "计划",
};

/** 计划工具的参数就是计划正文（markdown），单独渲染，不当作普通参数摘要 */
function planTextOf(input: Record<string, unknown> | undefined): string {
  const plan = input?.plan;
  return typeof plan === "string" ? plan.trim() : "";
}

function ToolCallCard({
  block,
  result,
  startedAt,
  onOpenFile,
}: {
  block: ToolCallContent;
  result?: ToolResultMessage;
  /** 发起这次调用的 assistant 消息时间戳 —— 配合 result.timestamp 算出耗时 */
  startedAt?: number;
  /** 点击写入文件的路径时，在会话右侧打开文件预览 */
  onOpenFile?: (path: string) => void;
}) {
  const isPlan = block.toolName === "present_plan";
  const planText = isPlan ? planTextOf(block.input) : "";
  // 计划是「决策文档」：默认展开，且不再把 JSON 参数倒一遍（倒出来的就是同一段正文）
  const [open, setOpen] = useState(isPlan && planText.length > 0);
  const running = !result;
  const timing = toolTiming(startedAt, result);
  const summary = isPlan
    ? stripControlSequences(planText.split("\n").find((line) => line.trim()) ?? "")
    : stripControlSequences(toolInputSummary(block.input, block.rawInput));
  const planStatus = isPlan ? planStatusLabel((result?.details as { status?: unknown } | undefined)?.status) : null;
  /* write/edit 工具且成功返回：路径可点击，唤起右侧文件预览 */
  const rawPath = block.input ? (block.input.file_path ?? block.input.path) : undefined;
  const previewPath =
    onOpenFile && typeof rawPath === "string" && rawPath.length > 0 && !running && !result.isError
      && (isWriteToolName(block.toolName) || isEditToolName(block.toolName))
      ? (rawPath as string)
      : null;
  return (
    <div className="my-1.5 overflow-hidden rounded-lg border border-line bg-panel-2/70">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left cursor-pointer hover:bg-hover/60"
      >
        <ChevronDown size={14} className={cn("shrink-0 text-dim transition-transform", open && "rotate-180")} />
        <span className="shrink-0 text-dim">
          <ToolNameIcon name={block.toolName} />
        </span>
        <span className="shrink-0 font-mono text-[12px] text-fg/90">{HOST_TOOL_LABELS[block.toolName] ?? block.toolName}</span>
        {previewPath && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onOpenFile?.(previewPath);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.stopPropagation();
                onOpenFile?.(previewPath);
              }
            }}
            className="chip chip-accent shrink-0 cursor-pointer"
            title="在右侧预览该文件"
          >
            <FileCode2 size={10} /> {previewPath.split(/[\\/]/).pop()}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-dim">{summary}</span>
        {timing.durationMs !== undefined && (
          <span
            className="shrink-0 text-[11px] tabular-nums text-dim"
            title={
              timing.startedAt !== undefined && timing.endedAt !== undefined
                ? `${formatClock(timing.startedAt)} → ${formatClock(timing.endedAt)}`
                : undefined
            }
            data-testid="tool-duration"
          >
            {formatDuration(timing.durationMs)}
          </span>
        )}
        {running ? (
          <Loader2 size={12} className="shrink-0 anim-spin text-accent" />
        ) : result?.isError ? (
          <span className="chip chip-danger shrink-0">失败</span>
        ) : planStatus ? (
          <span className={cn("shrink-0", planStatus.tone)}>{planStatus.label}</span>
        ) : (
          <Check2 />
        )}
      </button>
      {open && (
        <div className="border-t border-line">
          {isPlan ? (
            planText && (
              <div className="max-h-[420px] overflow-auto px-3 py-2.5">
                <Markdown text={planText} />
              </div>
            )
          ) : (
            <>
              {Object.keys(block.input || {}).length > 0 && (
                <pre className="max-h-40 overflow-auto border-b border-line/60 px-3 py-2 font-mono text-[12px] whitespace-pre-wrap text-muted">
                  {JSON.stringify(block.input, null, 2)}
                </pre>
              )}
              {result && (
                <div className="max-h-64 overflow-auto px-3 py-2 font-mono text-[12px] whitespace-pre-wrap">
                  {resultText(result)}
                  {result.isError && <span className="ml-1 text-danger">(错误)</span>}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Check2() {
  return <span className="chip chip-success shrink-0">完成</span>;
}

/**
 * `!命令` 直接执行 shell 的结果卡片。
 *
 * 背景：内核把这类结果作为 role="bashExecution" 的消息返回（不是 toolResult），
 * 本组件此前会落到 MessageView 末尾的 `return null` 被静默丢弃 —— 用户敲 `!ls`
 * 后聊天区一片空白。这里按「命令 + 输出 + 退出码」还原，超大输出走
 * /api/agent/[id]/bash-output 按需读取（内核已把完整输出落盘并在消息里给出路径）。
 */
function BashExecutionCard({ message, sessionId }: { message: BashExecutionMessage; sessionId?: string | null }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState<string | null>(null);
  const [fullError, setFullError] = useState<string | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);

  const loadFull = useCallback(async () => {
    if (!sessionId || !message.fullOutputPath || loadingFull) return;
    setLoadingFull(true);
    setFullError(null);
    try {
      const res = await fetch(
        `/api/agent/${encodeURIComponent(sessionId)}/bash-output?path=${encodeURIComponent(message.fullOutputPath)}`,
        { cache: "no-store" },
      );
      const d = (await res.json()) as { output?: string; error?: string };
      if (!res.ok) throw new Error(d.error || `读取失败（HTTP ${res.status}）`);
      setFull(d.output ?? "");
      setOpen(true);
    } catch (e) {
      setFullError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingFull(false);
    }
  }, [sessionId, message.fullOutputPath, loadingFull]);

  const exitOk = message.exitCode === undefined || message.exitCode === 0;
  const output = full ?? message.output ?? "";

  return (
    <div className="my-1.5 overflow-hidden rounded-lg border border-line bg-panel-2/70">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left hover:bg-hover/60"
      >
        <ChevronDown size={14} className={cn("shrink-0 text-dim transition-transform", open && "rotate-180")} />
        <span className="shrink-0 text-dim">
          <Terminal size={12} />
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg/90">{"$ "}
          {message.command}
        </span>
        {message.excludeFromContext && <span className="chip shrink-0">不进上下文</span>}
        {message.cancelled ? (
          <span className="chip shrink-0">
            <Square size={10} /> 已取消
          </span>
        ) : exitOk ? (
          <span className="chip chip-success shrink-0">退出码 {message.exitCode ?? 0}</span>
        ) : (
          <span className="chip chip-danger shrink-0">退出码 {message.exitCode}</span>
        )}
      </button>
      {open && (
        <div className="border-t border-line">
          {output ? (
            <pre className="max-h-64 overflow-auto px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-muted">
              {output}
            </pre>
          ) : (
            <div className="px-3 py-2 text-[12px] text-dim">（无输出）</div>
          )}
          {message.truncated && message.fullOutputPath && !full && (
            <div className="flex flex-wrap items-center gap-2 border-t border-line-soft px-3 py-1.5 text-[11px] text-warn">
              <AlertTriangle size={12} className="shrink-0" />
              输出过长已在会话中截断
              {sessionId && (
                <button onClick={() => void loadFull()} disabled={loadingFull} className="btn btn-sm btn-ghost text-warn">
                  {loadingFull ? <Loader2 size={10} className="anim-spin" /> : <FileCode2 size={10} />} 查看完整输出
                </button>
              )}
              <a
                href={`/api/agent/${encodeURIComponent(sessionId ?? "")}/bash-output?download=1&path=${encodeURIComponent(message.fullOutputPath)}`}
                className="btn btn-sm btn-ghost text-warn"
              >
                <Download size={10} /> 下载
              </a>
            </div>
          )}
          {fullError && <div className="border-t border-line-soft px-3 py-1.5 text-[11px] text-danger">{fullError}</div>}
        </div>
      )}
    </div>
  );
}

function resultText(result: ToolResultMessage): string {
  // 工具输出常带 ANSI 转义序列（颜色/进度条）与孤立 \r；工具卡不做着色，直接剔掉，
  // 否则会显示成 [31m 之类的噪声。
  return stripControlSequences(
    result.content
      .filter((c): c is TextContent => c.type === "text")
      .map((c) => c.text)
      .join("\n"),
  ).slice(0, 4000);
}

/**
 * 聊天消息的 Markdown 渲染。
 *
 * 用 lib/markdown 的完整插件链而不仅是 remarkGfm，因为那套配置修了两个真问题：
 *  1. `singleTilde: false` —— GFM 默认把单个 `~` 当删除线，中文数字区间
 *     「100~200倍 300~400倍」会被渲染成删除线（上游 #385）。
 *  2. remark-math + rehype-katex —— 模型输出 LaTeX 公式时渲染成排版公式而不是源码。
 * 另外 frontmatter 单独成 yaml 节点、raw HTML 走 sanitize 白名单后放行。
 */
function Markdown({ text }: { text: string }) {
  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={markdownRemarkPlugins}
        rehypePlugins={markdownRehypePlugins}
        urlTransform={markdownUrlTransform}
      >
        {normalizeDisplayMath(text)}
      </ReactMarkdown>
    </div>
  );
}

/** 计划工具的结果状态 → 界面措辞 */
function planStatusLabel(status: unknown): { label: string; tone: string } | null {
  switch (status) {
    case "approved": return { label: "已批准", tone: "chip-success" };
    case "revise": return { label: "待修订", tone: "chip-warn" };
    case "rejected": return { label: "未执行", tone: "chip" };
    default: return null;
  }
}

/**
 * 对外导出：扩展弹窗（计划批准、危险操作确认）要用同一套 markdown 渲染链，
 * 否则同一段计划在弹窗与转录里长得不一样。
 */
export { Markdown };

function AssistantBlocks({
  blocks,
  results,
  streaming,
  startedAt,
  onOpenFile,
  entryId,
  sessionId,
}: {
  blocks: AssistantContentBlock[];
  results: Map<string, ToolResultMessage>;
  streaming?: boolean;
  /** 本消息时间戳：作为其下所有工具调用的耗时起点 */
  startedAt?: number;
  onOpenFile?: (path: string) => void;
  entryId?: string | null;
  sessionId?: string | null;
}) {
  const textChunks: string[] = [];
  const nodes: React.ReactNode[] = [];
  const flush = (key: string) => {
    if (textChunks.length === 0) return;
    const text = textChunks.join("");
    textChunks.length = 0;
    nodes.push(<Markdown key={key} text={text} />);
  };
  blocks.forEach((block, i) => {
    if (block.type === "text") {
      textChunks.push(block.text);
    } else if (block.type === "thinking") {
      flush(`t-${i}`);
      nodes.push(
        <ThinkingBlock
          key={`th-${i}`}
          text={block.thinking}
          streaming={streaming && i === blocks.length - 1}
          deferred={block.deferred}
          sessionId={sessionId}
          entryId={entryId}
          blockIndex={i}
        />,
      );
    } else if (block.type === "toolCall") {
      flush(`t-${i}`);
      nodes.push(<ToolCallCard key={`tc-${block.toolCallId || i}`} block={block} result={results.get(block.toolCallId)} startedAt={startedAt} onOpenFile={onOpenFile} />);
    }
  });
  flush("t-final");
  return <>{nodes}</>;
}

/* ---------------- messages ---------------- */

export function UserMessageView({ message, onRemember }: {
  message: UserMessage;
  /** 「记住这条」：把本轮里的纠正沉淀成项目/全局约定（写入 AGENTS.md） */
  onRemember?: (text: string, scope: "project" | "global") => void;
}) {
  const text = typeof message.content === "string"
    ? message.content
    : message.content.filter((c) => c.type === "text").map((c) => (c as TextContent).text).join("\n");
  const images = typeof message.content === "string" ? [] : message.content.filter((c) => c.type === "image");
  return (
    <div className="group flex justify-end anim-fade-up">
      <div className="max-w-[85%] min-w-0">
        <div className="rounded-card rounded-br-sm border border-line bg-bubble px-3.5 py-2.5">
          <div className="whitespace-pre-wrap break-words">{text}</div>
          {images.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {images.map((img, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={i}
                  src={imageBlockSrc(img)}
                  alt=""
                  className="max-h-40 rounded-md border border-line"
                />
              ))}
            </div>
          )}
        </div>
        <div className="mt-0.5 flex justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          {onRemember && text.trim() && (
            <Popover
              align="right"
              containerClassName="shrink-0"
              panelClassName="bottom-full mb-1.5"
              trigger={({ toggle }) => (
                <button
                  onClick={toggle}
                  className="flex h-6 cursor-pointer items-center gap-1 rounded-md border border-line bg-panel-2 px-1.5 text-[11px] text-muted t-fast hover:text-fg"
                  title="把这条要求记成长期约定（写入 AGENTS.md，新会话生效）"
                >
                  <Bookmark size={12} />
                  记住
                </button>
              )}
            >
              {(close) => (
                <div className="flex w-56 flex-col p-1">
                  <button
                    onClick={() => {
                      close();
                      onRemember(text, "project");
                    }}
                    className="cursor-pointer rounded-md px-2 py-1.5 text-left text-[12px] text-fg t-fast hover:bg-hover"
                  >
                    记进项目约定
                    <span className="block text-[10px] text-dim">写入当前项目的 AGENTS.md</span>
                  </button>
                  <button
                    onClick={() => {
                      close();
                      onRemember(text, "global");
                    }}
                    className="cursor-pointer rounded-md px-2 py-1.5 text-left text-[12px] text-fg t-fast hover:bg-hover"
                  >
                    记进全局约定
                    <span className="block text-[10px] text-dim">对所有项目生效</span>
                  </button>
                </div>
              )}
            </Popover>
          )}
          <CopyButton text={text} />
        </div>
      </div>
    </div>
  );
}

export function AssistantMessageView({
  message,
  results,
  streaming,
  onOpenFile,
  entryId,
  sessionId,
}: {
  message: AssistantMessage;
  results: Map<string, ToolResultMessage>;
  streaming?: boolean;
  onOpenFile?: (path: string) => void;
  /** 当前消息对应的 session entry id（懒加载完整思考内容用） */
  entryId?: string | null;
  sessionId?: string | null;
}) {
  const emptyTextOnly = message.content.every((b) => b.type === "text" && !b.text.trim());
  if (emptyTextOnly && !streaming) return null;
  const fullText = message.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n\n");
  return (
    <div className="group flex gap-2.5 anim-fade-up">
      <div
        className="mt-0.5 flex size-6.5 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent"
        title="Elen"
      >
        <Bot size={14} />
      </div>
      <div className="min-w-0 flex-1">
        <AssistantBlocks
          blocks={message.content}
          results={results}
          streaming={streaming}
          startedAt={message.timestamp}
          onOpenFile={onOpenFile}
          entryId={entryId}
          sessionId={sessionId}
        />
        {message.errorMessage && (
          <div className="mt-1 rounded-lg border border-danger/30 bg-danger/10 px-3 py-1.5 text-[12px] text-danger">
            {message.errorMessage}
          </div>
        )}
        {!streaming && fullText.trim() && (
          <div className="mt-1 flex opacity-0 transition-opacity group-hover:opacity-100">
            <button
              onClick={() => {
                // 非安全上下文（局域网 http 访问）下 navigator.clipboard 不可用，
                // 走 lib/clipboard 的 execCommand 回退，否则复制按钮静默失败。
                void copyText(fullText).then(() => toast("已复制回复内容"));
              }}
              className="flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[11px] text-dim t-fast hover:bg-hover hover:text-fg"
              title="复制回复内容"
            >
              <Copy size={12} /> 复制
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function MessageView({
  message,
  results,
  streaming,
  onOpenFile,
  sessionId,
  entryId,
  onRemember,
}: {
  message: AgentMessage;
  results: Map<string, ToolResultMessage>;
  streaming?: boolean;
  onOpenFile?: (path: string) => void;
  /** 供 `!命令` 的完整输出按需拉取（/api/agent/[id]/bash-output） */
  sessionId?: string | null;
  /** 供思考内容按需拉取（/api/sessions/[id]/entries/[entryId]/thinking） */
  entryId?: string | null;
  /** 「记住这条」：把用户的一句话说成约定（见 lib/context-files 的 append） */
  onRemember?: (text: string, scope: "project" | "global") => void;
}) {
  if (message.role === "user") return <UserMessageView message={message} onRemember={onRemember} />;
  if (message.role === "assistant") {
    return (
      <AssistantMessageView
        message={message}
        results={results}
        streaming={streaming}
        onOpenFile={onOpenFile}
        entryId={entryId}
        sessionId={sessionId}
      />
    );
  }
  if (message.role === "bashExecution") return <BashExecutionCard message={message} sessionId={sessionId} />;
  // custom 消息：显式声明 display:false 的不渲染（括号不可省，&& 优先级高于 ||）
  if (message.role === "custom" && message.display === false) return null;
  // toolResult messages render inline with their toolCall card
  return null;
}

export function collectToolResults(messages: AgentMessage[]): Map<string, ToolResultMessage> {
  const map = new Map<string, ToolResultMessage>();
  for (const m of messages) {
    if (m.role === "toolResult") map.set(m.toolCallId, m);
  }
  return map;
}

export function StreamingIndicator({ phaseLabel, waitKey }: { phaseLabel: string; waitKey?: string }) {
  /* 光写「等待模型…」分不出「在跑，只是慢」和「真卡住了」——
     大上下文的首字延迟本来就可能一两分钟，两者长得一模一样。
     给出已持续秒数，用户自己就能判断；超长时再补一句解释与逃逸手段。
     计时按阶段类型重置（waitKey），否则「工具执行中 300s」会直接续成「等待模型… 305s」。 */
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    setElapsed(0);
    const startedAt = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [waitKey, phaseLabel]);

  const isWaitingModel = phaseLabel.startsWith("等待模型");
  return (
    <div className="px-1 py-1">
      <div className="flex items-center gap-2 text-[12px] text-muted" data-testid="streaming-indicator">
        <Loader2 size={14} className="anim-spin text-accent" />
        <span className="anim-pulse-dot">{phaseLabel}</span>
        {elapsed >= 3 && <span className="text-[11px] tabular-nums text-dim">{elapsed}s</span>}
      </div>
      {isWaitingModel && elapsed >= 45 && (
        <div className="mt-0.5 pl-6 text-[11px] text-dim">
          上游首字延迟偏大（上下文越长越慢）。仍在等待 —— 如需中断，点输入框右侧的停止按钮。
        </div>
      )}
    </div>
  );
}

export function UserAvatarDot() {
  return (
    <div className="mt-0.5 flex size-6.5 shrink-0 items-center justify-center rounded-md bg-raised text-muted">
      <User size={14} />
    </div>
  );
}

export function useMemoResults(messages: AgentMessage[]) {
  return useMemo(() => collectToolResults(messages), [messages]);
}

export function SearchIcon() {
  return <Search size={14} />;
}
