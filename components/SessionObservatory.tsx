"use client";

import {
  Activity,
  Bot,
  AlertTriangle,
  CheckCircle2,
  Coins,
  CornerDownRight,
  Copy,
  Download,
  GitBranch,
  Hash,
  History,
  Layers,
  Loader2,
  ListChecks,
  Share,
  Wrench,
  X,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/components/lib/utils";
import { Resizer, usePersistedWidth } from "@/components/ui/Resizer";
import { formatCost, formatDuration, formatTokens } from "@/lib/format";
import { copyText } from "@/lib/clipboard";
import { compactionTrigger, useCompactionSettings } from "@/hooks/useCompactionSettings";
import { summarizeTurn, toneClass } from "@/lib/turn-evidence";
import { verificationKindLabel } from "@/lib/verification-kind";
import type { TurnCheckpointsState } from "@/hooks/useTurnCheckpoints";
import type { AgentMessage, ToolResultMessage } from "@/lib/types";
import type { SessionStatsInfo } from "@/lib/pi-types";

/**
 * 右侧观察栏 —— 把「这次会话到底动过什么」变成一眼可见的数据。
 *
 * 定位是**只读观测**：不在里做任何有副作用的操作。
 * 真正的写操作（提交、回滚）留在 Git 变更页 —— 那里能先看 diff 再决定。
 *
 * 与文件预览共用右侧同一个槽位：点文件列表进入预览，关闭预览自动回到观测栏。
 */

type GitInfo = { isRepo: boolean; branch: string | null; dirty: number } | null;

/**
 * 列表展示上限。观测栏是**摘要**，不是第二份日志 ——
 * 完整的命令与工具卡逐条都在聊天区可见，这里再全列一遍只会把栏目撞长、淹没真正要看的东西。
 */
const MAX_VISIBLE_FILES = 8;
/** 工具种类一般不超 8 种（read/bash/edit/write/grep/find/ls…），列全不至于淹版面 */
const MAX_VISIBLE_TOOLS = 10;
/** 本轮命令上限：命令是要逐条比对的东西，超过一屏就失去「一眼扫完」的意义 */
const MAX_VISIBLE_COMMANDS = 12;

/**
 * 去掉工作区前缀，只留相对路径。
 * 观测栏只有 320px，绝对路径（`C:\Users\...\pi-web-ui\components\X.tsx`）
 * 一截断就完全分不出是哪个文件 —— 观察类界面里，公共前缀没有任何信息量。
 */
function relativize(target: string, cwd: string): string {
  if (!cwd) return target;
  const toSlashes = (v: string) => v.replace(/\\/g, "/");
  const root = toSlashes(cwd).replace(/\/+$/, "").toLowerCase();
  const cleaned = toSlashes(target);
  return cleaned.toLowerCase().startsWith(`${root}/`) ? cleaned.slice(root.length + 1) : cleaned;
}

/** 失败调用的错误摘要：工具结果里的第一行文字，截断展示 */
function toolErrorDetail(result: { content?: unknown }): string {
  const content = result.content;
  if (!Array.isArray(content)) return "调用失败";
  const text = content
    .filter((b): b is { type: string; text: string } =>
      Boolean(b) && typeof b === "object" && (b as { type?: string }).type === "text"
      && typeof (b as { text?: unknown }).text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (!text) return "调用失败";
  const firstLine = text.split("\n").find((l) => l.trim()) ?? text;
  return firstLine.length > 48 ? `${firstLine.slice(0, 48)}…` : firstLine;
}

/** 路径拆成「文件名 + 父目录」，与 Git 变更页的列表保持一致 */
function splitPath(p: string): { name: string; dir: string } {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return { name: parts[parts.length - 1] ?? p, dir: parts.length > 1 ? parts[parts.length - 2] : "" };
}

function Section({
  title,
  icon,
  meta,
  /** 在双列里时不画自己的下边框（边框由 SectionPair 统一给） */
  flush = false,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  meta?: React.ReactNode;
  flush?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      data-section={title}
      className={cn("min-w-0 px-3.5 py-3", !flush && "border-b border-line-soft")}
    >
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 text-dim">{icon}</span>
        <span className="text-[11px] font-semibold text-muted">{title}</span>
        {meta && <span className="ml-auto shrink-0 text-[11px] tabular-nums text-dim">{meta}</span>}
      </div>
      <div className="mt-2">{children}</div>
    </div>
  );
}

/**
 * 双列区块对。
 *
 * 为什么需要：观测栏里大部分区块内容很短（累计几行数字、上下文一条进度条），
 * 一条占一行的排版会把面板拉得很长，得频繁滚动——“两个短区块并排”比“拉长”好读。
 * 只给**确实短**的区块用（比如会话累计 + 上下文、Git + 运行环境）；
 * 列表型（工具调用、本会话文件）与带长文案的保持通栏。
 */
function SectionPair({ left, right }: { left: React.ReactNode; right: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 border-b border-line-soft">
      <div className="min-w-0 border-r border-line-soft">{left}</div>
      <div className="min-w-0">{right}</div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "accent" | "muted" }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5">
      <span className="shrink-0 text-[11px] text-dim">{label}</span>
      {/* 窄列（双列布局下只有 ~200px）里长值会被截断，所以 title 补全 */}
      <span
        title={value}
        className={cn(
          "min-w-0 truncate text-[12px] tabular-nums",
          tone === "accent" ? "font-semibold text-accent" : "text-fg",
        )}
      >
        {value}
      </span>
    </div>
  );
}

/** 缓存命中率：缓存读取 /（缓存读取 + 未命中输入）。新增输入是「没命中」的部分。 */
function CacheHitStat({ cacheRead, input }: { cacheRead: number; input: number }) {
  const denominator = cacheRead + input;
  const percent = denominator > 0 ? (cacheRead / denominator) * 100 : 0;
  /* 缓存性价比与命中率直接相关；低于 50% 说明前缀不稳定（如每轮都在改系统提示或早期消息）。 */
  const tone = percent >= 80 ? "text-success" : percent >= 50 ? "text-fg" : "text-warn";
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5">
      <span className="shrink-0 text-[11px] text-dim">缓存命中</span>
      <span className={cn("min-w-0 truncate text-[12px] tabular-nums", tone)}>
        {denominator > 0 ? `${percent.toFixed(1)}%` : "—"}
      </span>
    </div>
  );
}

/**
 * 成本结算条。
 *
 * 为什么不是又一行 Stat：光看「累计成本 $0.73」回答不了「贵在哪里」。把输入/输出/缓存
 * 三个分项并成一排（窄列里只能上下两行：标签在上、金额在下），合计单独提亮。
 * 分项全为 0（未配置计价 / 本地模型）时不摆三个 $0，只留合计。
 */
function CostSettlement({
  total,
  input,
  output,
  cache,
}: {
  total: number;
  input: number;
  output: number;
  cache: number;
}) {
  const hasBreakdown = input > 0 || output > 0 || cache > 0;
  return (
    <div className="mt-1.5 rounded-md border border-line-soft bg-panel-2/50 px-2 py-1.5" data-testid="cost-settlement">
      <div className="text-[10px] text-dim">成本结算</div>
      {hasBreakdown && (
        <div className="mt-1 flex items-start gap-1">
          {([["输入", input], ["输出", output], ["缓存", cache]] as const).map(([label, value]) => (
            <span key={label} className="flex min-w-0 flex-1 flex-col">
              <span className="text-[10px] text-dim">{label}</span>
              <span className="truncate text-[11px] tabular-nums text-muted" title={formatCost(value)}>
                {formatCost(value)}
              </span>
            </span>
          ))}
        </div>
      )}
      <div
        className={cn(
          "flex items-baseline justify-between gap-2",
          hasBreakdown && "mt-1 border-t border-line-soft pt-1",
        )}
      >
        <span className="shrink-0 text-[10px] text-dim">合计</span>
        <span className="min-w-0 truncate text-[12px] font-semibold tabular-nums text-accent" title={formatCost(total)}>
          {formatCost(total)}
        </span>
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="py-1 text-[11px] leading-relaxed text-dim/80">{children}</div>;
}

/**
 * 本轮：这场会话里「刚才那一步到底动了什么」。
 *
 * 与下方「本会话文件」是**不同粒度**——那个回答「整场会话改过哪些文件」，
 * 这个回答「刚刚这一轮改了什么、跑过什么、验证过没有」。后者才是用户在
 * agent 说完「改完了」时真正想核对的东西。
 *
 * 本区只读：回滚按钮留在输入框上方那行（观测栏的定位是看，不是改）。
 */
function TurnSection({
  turn,
  cwd,
  onOpenFile,
}: {
  turn: TurnCheckpointsState;
  cwd: string;
  onOpenFile: (path: string) => void;
}) {
  const latest = turn.latest;
  const summary = latest
    ? summarizeTurn(latest.fileCount, latest.files.filter((file) => !file.existed).length, latest.commands)
    : null;
  /** 命令 → 它作为验证的种类，挂 chip 用 */
  const checkByCommand = new Map(summary?.checks.map((check) => [check.command, check]) ?? []);

  return (
    <Section
      title="本轮"
      icon={<History size={12} />}
      meta={
        latest && (latest.fileCount > 0 || latest.commands.length > 0)
          ? `${latest.fileCount} 文件 · ${latest.commands.length} 命令`
          : undefined
      }
    >
      {!latest || (latest.fileCount === 0 && latest.commands.length === 0) ? (
        <Empty>本轮没有写入文件，也没有执行命令。</Empty>
      ) : (
        <div className="flex flex-col gap-2.5">
          {latest.files.length > 0 && (
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-dim">改动 {latest.files.length}</div>
              <div className="flex flex-col" data-testid="rail-turn-files">
                {latest.files.slice(0, MAX_VISIBLE_FILES).map((file) => {
                  const rel = relativize(file.path, cwd);
                  const { name, dir } = splitPath(rel);
                  return (
                    <div
                      key={file.path}
                      className="group/turnfile flex items-center gap-1.5 rounded-md px-1.5 py-1 t-fast hover:bg-hover"
                    >
                      <button
                        onClick={() => onOpenFile(file.path)}
                        title={`在会话右侧预览：${rel}`}
                        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
                      >
                        <span
                          className={cn("size-1 shrink-0 rounded-full", file.existed ? "bg-accent/60" : "bg-success/70")}
                        />
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg">{name}</span>
                        {dir && <span className="shrink-0 font-mono text-[10px] text-dim/70">{dir}</span>}
                      </button>
                      {!file.existed && <span className="chip chip-success shrink-0">新建</span>}
                      {!file.restorable && (
                        <span className="chip chip-warn shrink-0" title={file.skippedReason ?? undefined}>未备份</span>
                      )}
                    </div>
                  );
                })}
                {latest.files.length > MAX_VISIBLE_FILES && (
                  <div className="px-1.5 pt-0.5 text-[11px] text-dim">
                    另有 {latest.files.length - MAX_VISIBLE_FILES} 个
                  </div>
                )}
              </div>
            </div>
          )}

          {latest.commands.length > 0 && (
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-dim">执行 {latest.commands.length}</div>
              <div className="flex flex-col gap-0.5" data-testid="rail-turn-commands">
                {latest.commands.slice(-MAX_VISIBLE_COMMANDS).map((run, index) => (
                  <div key={`${index}-${run.command}`} className="flex items-start gap-1.5 rounded-md px-1.5 py-0.5">
                    {run.failed === null ? (
                      <Loader2 size={10} className="mt-0.5 shrink-0 anim-spin text-dim" />
                    ) : run.failed ? (
                      <XCircle size={10} className="mt-0.5 shrink-0 text-danger" />
                    ) : (
                      <CheckCircle2 size={10} className="mt-0.5 shrink-0 text-success" />
                    )}
                    <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted" title={run.command}>
                      {run.command}
                    </span>
                    {(() => {
                      const check = checkByCommand.get(run.command);
                      if (!check) return null;
                      return (
                        <span
                          className="chip shrink-0"
                          title={check.scope === "suite" ? "覆盖整个项目" : "只覆盖显式给出的路径"}
                        >
                          {verificationKindLabel(check.kind)}
                          {check.scope === "targeted" ? " · 单点" : ""}
                        </span>
                      );
                    })()}
                  </div>
                ))}
                {latest.commands.length > MAX_VISIBLE_COMMANDS && (
                  <div className="px-1.5 pt-0.5 text-[11px] text-dim">
                    只显示最近 {MAX_VISIBLE_COMMANDS} 条
                  </div>
                )}
              </div>
            </div>
          )}

          {summary && (
            <div className="px-1.5 text-[11px]">
              <span className={toneClass(summary.tone)}>{summary.headline}</span>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

export function SessionObservatory({
  messages,
  results,
  cwd,
  gitInfo,
  sessionStats,
  contextUsage,
  displayModel,
  thinkingLevel,
  onOpenFile,
  onOpenGit,
  onClose,
  compacting,
  onCompact,
  onAbortCompaction,
  onExportHtml,
  onClone,
  onOpenSubagents,
  onJumpToMessage,
  onOpenSettings,
  turn,
  /** 观测栏是否展开。收起走宽度过渡（与另外两个侧栏同一节奏），不卸载组件 */
  open = true,
}: {
  /** 观测栏是否展开。收起走宽度过渡（与另外两个侧栏同一节奏），组件不卸载 */
  open?: boolean;
  messages: AgentMessage[];
  results: Map<string, ToolResultMessage>;
  cwd: string;
  gitInfo: GitInfo;
  sessionStats: SessionStatsInfo | null;
  contextUsage: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  displayModel: { provider: string; modelId: string } | null;
  thinkingLevel: string | null;
  onOpenFile: (path: string) => void;
  onOpenGit?: (cwd: string) => void;
  onClose: () => void;
  /* ---- 会话级动作（与标题栏、输入框上下文环共用同一份实现）---- */
  compacting?: boolean;
  onCompact?: () => void;
  onAbortCompaction?: () => void;
  onExportHtml?: () => void;
  onClone?: () => void;
  /** 跳转到「子代理」页 */
  onOpenSubagents?: () => void;
  /** 跳转到聊天区某条消息（失败清单用） */
  onJumpToMessage?: (index: number) => void;
  /** 跳转到设置页（调整压缩阈值用） */
  onOpenSettings?: () => void;
  /** 本轮证据（改动 / 执行 / 验证 + 回滚）。数据源与输入框上方那行是同一个 hook */
  turn?: TurnCheckpointsState | null;
}) {
  /** 当前轮（最后一个 user 消息之后）的活动 —— 观测栏默认聚焦「刚才这一步做了什么」 */
  /**
   * 工具调用聚合 + 失败清单（会话级）。
   *
   * 取代原来的「本轮活动」：那一块列的是**逐条命令日志**，而同样内容在聊天区本来
   * 就逐条可见 —— 观测栏再抄一份只是复读。真正只有聚合才能回答的是两件事：
   *   1. 这场会话主要在干什么（bash 多？edit 多？还是在读代码）
   *   2. 哪些调用失败了（需要人处理的东西）
   */
  const toolStats = useMemo(() => {
    const counts = new Map<string, { count: number; failed: number }>();
    const failures: { index: number; tool: string; detail: string }[] = [];
    let thinking = 0;

    const bump = (name: string, failed: boolean) => {
      const prev = counts.get(name) ?? { count: 0, failed: 0 };
      counts.set(name, { count: prev.count + 1, failed: prev.failed + (failed ? 1 : 0) });
    };

    messages.forEach((m, i) => {
      if (m.role === "assistant") {
        for (const b of m.content) {
          if (b.type === "thinking") thinking += 1;
          else if (b.type === "toolCall") {
            const result = b.toolCallId ? results.get(b.toolCallId) : undefined;
            bump(b.toolName, Boolean(result?.isError));
            if (result?.isError) {
              failures.push({ index: i, tool: b.toolName, detail: toolErrorDetail(result) });
            }
          }
        }
      } else if (m.role === "bashExecution") {
        const failed = (m.exitCode ?? 0) !== 0;
        bump("bash", failed);
        if (failed) failures.push({ index: i, tool: "bash", detail: `退出码 ${m.exitCode}` });
      }
    });

    const rows = [...counts.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const totalCalls = rows.reduce((n, r) => n + r.count, 0);
    const totalFailed = rows.reduce((n, r) => n + r.failed, 0);
    return { rows, failures, totalCalls, totalFailed, thinking };
  }, [messages, results]);

  const tokens = sessionStats?.tokens;
  // percent 是浮点（433.4k/1.00M → 43.3375），展示层必须取整
  const pct = contextUsage?.percent != null ? Math.round(contextUsage.percent) : null;
  /* 观测栏宽度可拖拽：它是「数据面板」，用户常需要更宽来读长路径与命令 */
  const { width: paneWidth, grow: growPane, reset: resetPane } = usePersistedWidth(
    "elenva-observatory-width",
    420,
    300,
    640,
  );
  const compaction = useCompactionSettings();
  const trigger = contextUsage
    ? compactionTrigger(contextUsage.contextWindow, compaction.reserveTokens)
    : null;
  /* 只在**确实接近内核的自动压缩阈值**时提醒，而不是到某个整数百分比就催 ——
     实测 76%（1M 窗口）离触发点还有 22 万 token，手动压缩为时过早。 */
  const nearTrigger = pct !== null && trigger !== null && pct >= trigger.percent - 2;

  return (
    <>
    {/* 收起时不渲染手柄：宽度为 0 时它既点不到，也会在边缘留一条 7px 的命中区 */}
    {open && <Resizer onDrag={growPane} onDoubleClick={resetPane} invert side="left" label="调整观测栏宽度" />}
    <aside
      className={cn(
        "flex shrink-0 flex-col overflow-hidden border-r border-line bg-panel t-pane",
        open ? "opacity-100" : "opacity-0",
      )}
      /* 宽度由组件自己收（外面再包一层容器会裁掉 resizer 的负边距，实测拖拽直接失效） */
      style={{ width: open ? paneWidth : 0 }}
      data-testid="observatory"
      aria-label="会话观测"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3.5">
        <Activity size={14} className="shrink-0 text-accent" />
        <span className="text-[13px] font-semibold text-fg">观测</span>
        <span className="text-[11px] text-dim">本会话实时数据</span>
        <button
          onClick={onClose}
          title="收起观测栏"
          aria-label="收起观测栏"
          className="ml-auto flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-dim t-fast hover:bg-hover hover:text-fg"
        >
          <X size={12} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* ---------- 本轮证据 ---------- */}
        {turn && <TurnSection turn={turn} cwd={cwd} onOpenFile={onOpenFile} />}

        {/* ---------- 工具调用（会话级聚合）---------- */}
        <Section
          title="工具调用"
          icon={<Wrench size={12} />}
          meta={
            toolStats.totalCalls > 0 ? (
              <span>
                {toolStats.totalCalls} 次
                {toolStats.totalFailed > 0 && (
                  <span className="text-danger"> · {toolStats.totalFailed} 失败</span>
                )}
              </span>
            ) : undefined
          }
        >
          {toolStats.totalCalls === 0 ? (
            <Empty>本会话还没有调用过工具。</Empty>
          ) : (
            <>
              <div className="flex flex-col" data-testid="rail-tools">
                {toolStats.rows.slice(0, MAX_VISIBLE_TOOLS).map((row) => {
                  /* 失败详情直接缩进挂在对应工具行下面，而不是另开一个「失败调用」区块 ——
                     两者本来就描述同一件事，分成两块会多占一行标题、还要来回对照。 */
                  const firstFailure = toolStats.failures.find((f) => f.tool === row.name);
                  return (
                    <div key={row.name}>
                      <div className="flex items-center gap-2 py-0.5" data-testid="rail-tool">
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg">{row.name}</span>
                        {row.failed > 0 && (
                          <span className="shrink-0 text-[10px] text-danger">{row.failed} 失败</span>
                        )}
                        <span className="shrink-0 text-[11px] tabular-nums text-muted">{row.count}</span>
                      </div>
                      {firstFailure && onJumpToMessage && (
                        <button
                          onClick={() => onJumpToMessage(firstFailure.index)}
                          title={`跳转到失败的那条消息：${firstFailure.detail}`}
                          data-testid="rail-failure"
                          className="mb-0.5 flex w-full cursor-pointer items-center gap-1.5 rounded-md bg-danger/5 px-1.5 py-0.5 text-left t-fast hover:bg-danger/10"
                        >
                          <CornerDownRight size={10} className="shrink-0 text-danger/70" />
                          <span className="min-w-0 flex-1 truncate text-[10px] text-danger">
                            {firstFailure.detail}
                          </span>
                        </button>
                      )}
                    </div>
                  );
                })}
                {toolStats.rows.length > MAX_VISIBLE_TOOLS && (
                  <div className="pt-0.5 text-[11px] text-dim">
                    另有 {toolStats.rows.length - MAX_VISIBLE_TOOLS} 种工具
                  </div>
                )}
              </div>
            </>
          )}
        </Section>

        {/* 本会话文件区已移除：
            ① 聊天区工具栏的「📄 N」按钮本来就能列出同一份文件（右侧预览面板可比
               观测栏窄列容纳更多信息，还带内容预览）；
            ② 项目视角的改动清单在「代码」页，入口也不缺；
            ③ 观测栏实测总高 ~1520px（已需滚动），而本会话文件是其中最弱的一份
               重复信息（长会话里前几条总是共几个最新文件）。数据仍在 ChatView 里
               供头部按钮与预览面板使用。 */}

        {/* ---------- 子代理 ---------- */}
        <SubagentSection parentSessionId={sessionStats?.sessionId} onOpenSubagents={onOpenSubagents} />

        {/* ---------- 计划模式（预留位置）----------
            pi 没有独立的「计划档位」（工具档位只有 none/minimal/default/full）；
            它的 plan 子代理就是厂家的计划模式。这里把这条路线写清楚并给出入口，
            而不是放一句「规划中」的路线图文案。 */}
        <Section title="计划模式" icon={<ListChecks size={12} />}>
          <div className="text-[11px] leading-relaxed text-dim">
            pi 的 <b className="font-medium text-fg">plan</b> 子代理：能调研仓库、产出可实施方案，
            但<strong className="text-fg">不改动任何文件</strong>。
          </div>
          <div className="mt-1.5 rounded-md bg-panel-2 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-muted">
            在对话里说：「用 plan 子代理制定 XX 的方案」
          </div>
          {onOpenSubagents && (
            <button
              onClick={onOpenSubagents}
              className="btn btn-sm btn-ghost mt-1.5 w-full"
              data-testid="rail-open-subagents"
            >
              <Bot size={10} /> 管理子代理配置
            </button>
          )}
        </Section>

        {/* ---------- 运行统计 | 上下文窗口（两列并排）----------
            两者都是「几行短数字」，各占一行会把面板拉得很长。
            内部顺序：先「干了什么」（消息 / 工具 / 时长 / 缓存命中），
            再「花了多少」（结算条），token 明细放最后 —— 它是结算的注脚。 ---------- */}
        <SectionPair
          left={
            <Section flush title="运行统计" icon={<ListChecks size={12} />}>
          {sessionStats ? (
            <>
              <Stat label="消息" value={`${sessionStats.userMessages} 问 · ${sessionStats.assistantMessages} 答`} />
              <Stat label="工具调用" value={String(sessionStats.toolCalls)} />
              {sessionStats.totalActiveMs !== undefined && sessionStats.totalActiveMs > 0 && (
                <Stat label="活跃时长" value={formatDuration(sessionStats.totalActiveMs)} />
              )}
              {tokens && <CacheHitStat cacheRead={tokens.cacheRead} input={tokens.input} />}

              <CostSettlement
                total={sessionStats.cost}
                input={sessionStats.costInput ?? 0}
                output={sessionStats.costOutput ?? 0}
                cache={sessionStats.costCache ?? 0}
              />

              {tokens && (
                <div className="mt-1.5">
                  <Stat label="输入 token" value={formatTokens(tokens.input)} />
                  <Stat label="输出 token" value={formatTokens(tokens.output)} />
                  {/* 缓存拆成读/写两行 —— 读写加起来没信息量，要看的命中比例已在上面 */}
                  <Stat label="缓存读取" value={formatTokens(tokens.cacheRead)} />
                  <Stat label="缓存写入" value={formatTokens(tokens.cacheWrite)} />
                  <Stat label="累计 token" value={formatTokens(tokens.total)} />
                </div>
              )}
            </>
          ) : (
            <Empty>统计随第一条消息开始累积。</Empty>
          )}
            </Section>
          }
          right={
            /* 右列两段叠放：上下文窗口 + Git（详见下方注释） */
            <div className="flex h-full flex-col">
            {contextUsage ? (
              <Section
                flush
                title="上下文窗口"
                icon={<Layers size={12} />}
                meta={pct !== null ? `${pct}%` : undefined}
              >
                {/* 窄列里进度条与数字不能同排（会把数字挤没），改成上下两行 */}
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-panel-2">
                  <div
                    className={cn(
                      "h-full rounded-full",
                      pct === null ? "bg-accent" : nearTrigger ? "bg-danger" : pct >= 60 ? "bg-warn" : "bg-accent",
                    )}
                    style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%` }}
                  />
                </div>
                <div className="mt-1 text-[11px] tabular-nums text-dim">
                  {contextUsage.tokens !== null ? formatTokens(contextUsage.tokens) : "—"} /{" "}
                  {formatTokens(contextUsage.contextWindow)}
                </div>
                {trigger && (
                  <div
                    className={cn(
                      "mt-1.5 flex items-start gap-1.5 text-[10px] leading-relaxed",
                      nearTrigger ? "text-warn" : "text-dim/70",
                    )}
                  >
                    {nearTrigger && <AlertTriangle size={10} className="mt-0.5 shrink-0" />}
                    <span className="min-w-0 flex-1">
                      {compaction.enabled
                        ? `约 ${trigger.percent}%（${trigger.tokens.toLocaleString()}）时内核自动压缩`
                        : "自动压缩已关闭"}
                    </span>
                    {/* 看到触发点想改，就地能跳过去（阈值在 设置 → Pi 行为 → 响应预留 Token） */}
                    {onOpenSettings && (
                      <button
                        onClick={onOpenSettings}
                        title="调整自动压缩的触发点（设置 → Pi 行为 → 响应预留 Token）"
                        data-testid="rail-compaction-settings"
                        className="shrink-0 cursor-pointer underline decoration-dotted underline-offset-2 t-fast hover:text-fg"
                      >
                        调整
                      </button>
                    )}
                  </div>
                )}
                {/* 压缩放在占用率旁边：动机与动作相邻，不必再去菜单里找 */}
                {(onCompact || onAbortCompaction) && (
                  <div className="mt-2">
                    {compacting ? (
                      <button onClick={onAbortCompaction} className="btn btn-sm btn-ghost w-full text-danger">
                        停止压缩
                      </button>
                    ) : (
                      <button onClick={onCompact} className="btn btn-sm btn-ghost w-full" data-testid="rail-compact">
                        压缩上下文
                      </button>
                    )}
                  </div>
                )}
              </Section>
            ) : (
              <Section flush title="上下文窗口" icon={<Layers size={12} />}>
                <Empty>暂无上下文数据。</Empty>
              </Section>
            )}
            {/* Git 叠在上下文窗口下面（两段都是「几行短信息」）：运行统计补了结算条与
                token 明细后高出一倍多（实测 366px vs 上下文 150px），右列底部原本会
                空出一大块；叠上去后两列高度接近，观测栏整体也不再被拉长。 */}
            <div className="border-t border-line-soft">
        <Section
              flush
          title="Git"
          icon={<GitBranch size={12} />}
          meta={gitInfo?.dirty ? `${gitInfo.dirty} 个变更` : undefined}
        >
          {gitInfo?.isRepo ? (
            <>
              <Stat label="分支" value={gitInfo.branch || "（未知）"} />
              <Stat
                label="未提交"
                value={gitInfo.dirty > 0 ? `${gitInfo.dirty} 个文件` : "工作区干净"}
                tone={gitInfo.dirty > 0 ? "accent" : undefined}
              />
              {onOpenGit && cwd && (
                <button
                  onClick={() => onOpenGit(cwd)}
                  className="btn btn-sm btn-ghost mt-2 w-full"
                  data-testid="observatory-open-git"
                >
                  {gitInfo.dirty > 0 ? `查看并提交这 ${gitInfo.dirty} 个变更 →` : "打开 Git 变更 →"}
                </button>
              )}
              <div className="mt-1.5 text-[10px] leading-relaxed text-dim/70">
                观测栏只读。提交与撤销提交在「Git 变更」页完成 —— 那里能先看 diff 并逐个勾选文件。
              </div>
            </>
          ) : (
            <Empty>当前工作区不是 Git 仓库。</Empty>
          )}
        </Section>
            </div>
            </div>
          }
        />

        {/* ---------- 运行环境（通栏）---------- */}
        <Section title="运行环境" icon={<Hash size={12} />}>
          {displayModel ? (
            <Stat label="模型" value={`${displayModel.provider}/${displayModel.modelId}`} />
          ) : (
            <Stat label="模型" value="跟随默认" />
          )}
          <Stat label="思考强度" value={thinkingLevel || "auto"} />
          <Stat label="工作区" value={cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() || cwd : "—"} />
          <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-dim/70">
            <Coins size={10} className="shrink-0" />
            用量为离线统计，不出本机
          </div>
        </Section>

        {/* ---------- 会话产物（导出 / 克隆 / 会话文件）---------- */}
        {(onExportHtml || onClone) && (
          <Section title="会话产物" icon={<Download size={12} />}>
            <div className="flex flex-col gap-1.5">
              {onExportHtml && (
                <button onClick={onExportHtml} className="btn btn-sm btn-ghost w-full" data-testid="rail-export">
                  <Share size={10} /> 导出 HTML
                </button>
              )}
              {onClone && (
                <button onClick={onClone} className="btn btn-sm btn-ghost w-full" data-testid="rail-clone">
                  <Copy size={10} /> 克隆会话
                </button>
              )}
            </div>
            {sessionStats?.sessionFile && (
              <div className="mt-2 border-t border-line-soft pt-2">
                <div className="text-[10px] text-dim">会话文件</div>
                <div className="mt-0.5 flex items-start gap-1.5">
                  <span
                    className="min-w-0 flex-1 break-all font-mono text-[10px] leading-relaxed text-dim/80"
                    title={sessionStats.sessionFile}
                  >
                    {sessionStats.sessionFile}
                  </span>
                  <button
                    onClick={() => void copyText(sessionStats.sessionFile!)}
                    title="复制路径"
                    aria-label="复制会话文件路径"
                    className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-dim t-fast hover:bg-hover hover:text-fg"
                  >
                    <Copy size={10} />
                  </button>
                </div>
              </div>
            )}
          </Section>
        )}
      </div>
    </aside>
    </>
  );
}

/**
 * 子代理区块：本会话（作为父会话）派生的子代理运行状态。
 *
 * 为什么放在观测栏而不是只在「子代理」页：子代理是**当前这轮工作在并行做的事**，
 * 属于会话现场的一部分；要跳到另一个页面才能看到它们，就违背了「随时看清 agent 在干什么」。
 * 管理页负责 profile 配置与全量视图，这里负责「主会话视角的正在发生」。
 */
function SubagentSection({
  parentSessionId,
  onOpenSubagents,
}: {
  parentSessionId?: string;
  onOpenSubagents?: () => void;
}) {
  const [runs, setRuns] = useState<SubagentRun[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const active = runs.filter((r) => r.status === "running" || r.status === "starting");

  useEffect(() => {
    if (!parentSessionId) return;
    let alive = true;
    const load = () => {
      fetch("/api/subagents/runs", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : { runs: [] }))
        .then((d: { runs?: SubagentRun[] }) => {
          if (!alive) return;
          // 只显示本会话派生出来的，避免把其它会话的子代理混进来
          setRuns((d.runs ?? []).filter((r) => r.parentSessionId === parentSessionId));
        })
        .catch(() => { /* 网络抖动保留上次快照 */ });
    };
    load();
    const timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [parentSessionId]);

  const abort = async (sessionId: string) => {
    setBusyId(sessionId);
    try {
      await fetch(`/api/subagents/${encodeURIComponent(sessionId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "abort" }),
      });
      setRuns((prev) => prev.map((r) => (r.sessionId === sessionId ? { ...r, status: "failed" } : r)));
    } finally {
      setBusyId(null);
    }
  };

  /* 没有子代理运行时**不渲染**：零占位，避免给大多数不瘸子代理的会话添噪 */
  if (runs.length === 0) return null;

  return (
    <Section
      title="子代理"
      icon={<Bot size={12} />}
      meta={active.length > 0 ? `${active.length} 个运行中` : `${runs.length} 个`}
    >
      <div className="flex flex-col gap-1.5" data-testid="rail-subagents">
        {runs.map((run) => {
          const running = run.status === "running" || run.status === "starting";
          return (
            <div key={run.sessionId} className="rounded-md bg-panel-2 px-2 py-1.5">
              <div className="flex items-center gap-1.5">
                {running && <Loader2 size={10} className="anim-spin shrink-0 text-accent" />}
                <span className="shrink-0 text-[11px] font-medium text-fg">{run.profile}</span>
                <span
                  className={cn(
                    "chip shrink-0",
                    run.status === "failed" ? "chip-danger" : running ? "chip-accent" : "chip-success",
                  )}
                >
                  {run.status === "failed" ? "失败" : running ? "运行中" : "完成"}
                </span>
                {running && (
                  <button
                    onClick={() => void abort(run.sessionId)}
                    disabled={busyId === run.sessionId}
                    title="中止该子代理"
                    className="ml-auto shrink-0 cursor-pointer rounded-sm px-1 text-[10px] text-dim t-fast hover:bg-hover hover:text-danger"
                  >
                    中止
                  </button>
                )}
              </div>
              <div className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-muted">
                {run.description || run.task}
              </div>
            </div>
          );
        })}
      </div>
      {onOpenSubagents && (
        <button onClick={onOpenSubagents} className="btn btn-sm btn-ghost mt-1.5 w-full">
          <Bot size={10} /> 全部子代理
        </button>
      )}
    </Section>
  );
}

type SubagentRun = {
  sessionId: string;
  parentSessionId: string;
  profile: string;
  description: string;
  task: string;
  status: "starting" | "running" | "completed" | "failed";
};
