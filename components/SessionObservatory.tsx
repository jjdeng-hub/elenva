"use client";

import {
  Activity,
  Bot,
  AlertTriangle,
  CheckCircle2,
  Coins,
  ChevronDown,
  Copy,
  GitBranch,
  Hash,
  History,
  Layers,
  Loader2,
  ListChecks,
  ListTodo,
  RotateCcw,
  Share,
  TrendingUp,
  X,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@/components/lib/utils";
import { toast } from "@/components/ui/dialog";
import { Resizer } from "@/components/ui/Resizer";
import { formatCost, formatDuration, formatTokens, relTime } from "@/lib/format";
import { copyText } from "@/lib/clipboard";
import { compactionTrigger, useCompactionSettings } from "@/hooks/useCompactionSettings";
import { useDeclaredVerifyCommands } from "@/hooks/useDeclaredVerifyCommands";
import { summarizeTurn, toneClass } from "@/lib/turn-evidence";
import { verificationKindLabel } from "@/lib/verification-kind";
import type { TurnCheckpointsState } from "@/hooks/useTurnCheckpoints";
import type { AgentMessage, ToolResultMessage } from "@/lib/types";
import type { TurnTrendsResult } from "@/lib/turn-trends";
import type { SessionStatsInfo } from "@/lib/pi-types";
import { TodoList } from "@/components/TodoList";
import { latestTodoState } from "@/lib/todo-view";
import { todoProgress } from "@/extensions/elenva-todo/state";

/**
 * 右侧观察栏 —— 把「这次会话到底动过什么」变成一眼可见的数据。
 *
 * 定位是**只读观测**：不在里做有副作用的操作，
 * 唯一例外是「本轮」区的回滚 —— 纠错动作跟着明细走：观测栏在场时看与动同处（明细在这里，
 * 回滚也在这里）；观测栏不在场时由输入框上方那一行兜底（两处互斥，不会同时出现）。
 * 提交类写操作仍在 Git 变更页 —— 那里能先看 diff 再决定。
 *
 * 与文件预览共用右侧同一个槽位：点文件列表进入预览，关闭预览自动回到观测栏。
 */

type GitInfo = { isRepo: boolean; branch: string | null; dirty: number } | null;

/**
 * 列表展示上限。观测栏是**摘要**，不是第二份日志 ——
 * 完整的命令与工具卡逐条都在聊天区可见，这里再全列一遍只会把栏目撞长、淹没真正要看的东西。
 */
const MAX_VISIBLE_FILES = 8;
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

function splitPath(p: string): { name: string; dir: string } {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return { name: parts[parts.length - 1] ?? p, dir: parts.length > 1 ? parts[parts.length - 2] : "" };
}

function Section({
  title,
  icon,
  meta,
  action,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  meta?: React.ReactNode;
  /** 标题行右侧的动作按钮（如「本轮」区的回滚）：与 meta 合成一个靠右组，
   *  这样没有 meta 时按钮也不会挤在标题旁 */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      data-section={title}
      className="min-w-0 border-b border-line-soft px-3.5 py-3"
    >
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 text-dim">{icon}</span>
        <span className="text-[11px] font-semibold text-muted">{title}</span>
        {(meta || action) && (
          <span className="ml-auto flex min-w-0 shrink-0 items-center gap-1.5">
            {meta && <span className="text-[11px] tabular-nums text-dim">{meta}</span>}
            {action}
          </span>
        )}
      </div>
      <div className="mt-2">{children}</div>
    </div>
  );
}

/**
 * 折叠区块（观测栏瘦身用）。
 *
 * 观测栏是「一屏看全」的摘要面板，长尾信息（完整 token 明细、运行环境、会话产物）
 * 默认收起，真要看时才展开；折叠头右侧那一行是这个区的摘要。
 * 交互与消息流里的思考块 / 工具卡折叠头一致：ChevronDown 旋转 + 点整行切换。
 */
function CollapsibleSection({
  title,
  icon,
  summary,
  testId,
  defaultOpen = false,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  /** 收起时显示在标题右侧的一行摘要 */
  summary?: React.ReactNode;
  testId?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div data-section={title} className="border-b border-line-soft">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid={testId}
        className="flex w-full cursor-pointer items-center gap-1.5 px-3.5 py-3 text-left t-fast hover:bg-hover/50"
      >
        <ChevronDown
          size={12}
          className={cn("shrink-0 text-dim transition-transform", open && "rotate-180")}
        />
        <span className="shrink-0 text-dim">{icon}</span>
        <span className="text-[11px] font-semibold text-muted">{title}</span>
        {summary && !open && (
          <span className="ml-auto min-w-0 truncate text-[11px] tabular-nums text-dim">{summary}</span>
        )}
      </button>
      {open && <div className="px-3.5 pb-3">{children}</div>}
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
 * 近 N 轮：观测栏里「本轮」与「整场累计」之间的那一层 ——
 * 回答「最近是不是越跑越稳、钱花在哪几轮、失败多不多」。
 *
 * 轮数 < 2 不渲染：一轮谈不上趋势（与上方「本轮」区重复），零轮同理。
 * 数据源是**活动消息列表**（被压缩掉的历史轮本就不在此列，这正是「近 N 轮」的语义）。
 */
function TrendsSection({ trends }: { trends: TurnTrendsResult }) {
  const { rounds, totals } = trends;
  if (rounds.length < 2) return null;

  const attempts = totals.toolCalls + totals.failures;
  const failureRate = attempts > 0 ? (totals.failures / attempts) * 100 : null;
  const summary = [
    `合计 ${formatCost(totals.cost)}`,
    totals.failures > 0 ? `${totals.failures} 次失败` : null,
  ]
    .filter((v): v is string => Boolean(v))
    .join(" · ");

  return (
    <CollapsibleSection
      title={`近 ${rounds.length} 轮`}
      icon={<TrendingUp size={12} />}
      summary={summary}
      testId="rail-trends-toggle"
    >
      <div
        className="flex flex-wrap items-baseline gap-x-1.5 rounded-md border border-line-soft bg-panel-2/50 px-2 py-1.5 text-[11px] tabular-nums text-dim"
        data-testid="trend-totals"
      >
        <span className="text-[10px] uppercase tracking-wide">合计</span>
        <span className="text-fg">{formatCost(totals.cost)}</span>
        <span>·</span>
        <span>{totals.toolCalls} 工具</span>
        <span>·</span>
        <span className={cn(totals.failures > 0 ? "text-danger" : "text-fg")}>{totals.failures} 失败</span>
        {failureRate !== null && <span className="text-dim/70">（{failureRate.toFixed(0)}%）</span>}
      </div>
      {/* 最新在最上：趋势问题关心的总是「最近怎么样」 */}
      <div className="mt-1.5 flex flex-col" data-testid="trend-rows">
        {[...rounds].reverse().map((round) => (
          <div
            key={round.index}
            data-testid="trend-row"
            title={round.label}
            className="flex items-baseline gap-1.5 px-0.5 py-0.5 text-[11px] tabular-nums text-dim"
          >
            <span className="shrink-0 text-dim/70">#{round.index}</span>
            {round.startedAt !== undefined && (
              <>
                <span className="shrink-0">·</span>
                <span className="shrink-0">{relTime(new Date(round.startedAt).toISOString())}</span>
              </>
            )}
            <span className="shrink-0">·</span>
            <span className="text-muted">{formatCost(round.cost)}</span>
            <span className="shrink-0">·</span>
            <span className="text-muted">{round.toolCalls} 工具</span>
            {round.failures > 0 && (
              <>
                <span className="shrink-0">·</span>
                <span className="shrink-0 font-semibold text-danger">{round.failures}✗</span>
              </>
            )}
          </div>
        ))}
      </div>
    </CollapsibleSection>
  );
}

/**
 * 本轮：这场会话里「刚才那一步到底动了什么」。
 *
 * 与下方「本会话文件」是**不同粒度**——那个回答「整场会话改过哪些文件」，
 * 这个回答「刚刚这一轮改了什么、跑过什么、验证过没有」。后者才是用户在
 * agent 说完「改完了」时真正想核对的东西。
 *
 * 本区默认只读，例外的**回滚按钮就放在区头右侧**：纠错是跟着明细走的动作，
 * 明细在这里（改了哪几个文件、哪个跳过），回滚就该在这里按，不必折回输入框。
 * 观测栏不在场时这个按钮随之消失，由输入框上方那行的回滚接手（两处互斥）。
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
  // 「本轮」= 合并后的用户轮（子轮次语义见 useTurnCheckpoints.mergeRound）
  const latest = turn.latestRound;
  // 项目声明的验证命令：让项目自定义脚本（如 style-converge）也能算「整体验证」
  const declaredPatterns = useDeclaredVerifyCommands(cwd);
  const summary = latest
    ? summarizeTurn(latest.fileCount, latest.createdCount, latest.commands, declaredPatterns)
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
      action={
        latest && latest.files.length > 0 ? (
          <button
            onClick={() => void turn.restore()}
            disabled={turn.restoring || latest.restorableCount === 0}
            className="flex h-6 cursor-pointer items-center gap-1 rounded-md border border-line bg-panel px-1.5 text-[11px] text-muted t-fast hover:border-danger/40 hover:text-danger disabled:opacity-50"
            title="把本轮写入的文件恢复原状"
            data-testid="rail-rollback-turn"
          >
            <RotateCcw size={12} />
            {turn.restoring ? "回滚中…" : "回滚本轮"}
          </button>
        ) : undefined
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
                      {file.changedSince && (
                        <span className="chip chip-warn shrink-0" title="本轮之后又被改动：回滚会跳过，不会覆盖">被改过</span>
                      )}
                      {file.restorable && (
                        <button
                          onClick={() => void turn.restoreFile(file.path)}
                          disabled={turn.restoring}
                          className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md border border-line bg-panel text-muted opacity-0 t-fast group-hover/turnfile:opacity-100 hover:border-danger/40 hover:text-danger focus-visible:opacity-100 disabled:opacity-50"
                          title="回滚此文件到本轮前"
                          data-testid="rail-file-restore"
                        >
                          <RotateCcw size={12} />
                        </button>
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
  trends,
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
  onOpenSettings,
  turn,
  /** 观测栏是否展开。收起走宽度过渡（与另外两个侧栏同一节奏），不卸载组件 */
  open = true,
  header,
  width: paneWidth,
  grow: growPane,
  reset: resetPane,
}: {
  /** 自定义面板头（右栏共用标签栏） */
  header?: ReactNode;
  /** 观测栏是否展开。收起走宽度过渡（与另外两个侧栏同一节奏），组件不卸载 */
  open?: boolean;
  /* ---- 宽度：由 ChatView 持有单一持久化状态后传入（三个面板共用）---- */
  width: number;
  grow: (deltaPx: number) => void;
  reset: () => void;
  messages: AgentMessage[];
  /** 近 N 轮趋势（逐轮 花费 / 工具 / 失败）。由 ChatView 用 computeTurnTrends 推导后传入 */
  trends: TurnTrendsResult;
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
  /** 跳转到设置页（调整压缩阈值用） */
  onOpenSettings?: () => void;
  /** 本轮证据（改动 / 执行 / 验证 + 回滚）。数据源与输入框上方那行是同一个 hook */
  turn?: TurnCheckpointsState | null;
}) {
  /** 当前任务清单（与输入框上方面板同一推导；成功的 todo_write 才更新） */
  const todos = useMemo(() => latestTodoState(messages, results), [messages, results]);
  const todoStats = todos && todos.items.length > 0 ? todoProgress(todos.items) : null;

  /* 运行统计收起时的摘要行：只留「耗时 · 调用 · 花费」三个最常看的数 */
  const statsSummary = sessionStats
    ? [
        sessionStats.totalActiveMs ? formatDuration(sessionStats.totalActiveMs) : null,
        `${sessionStats.toolCalls} 次工具`,
        formatCost(sessionStats.cost),
      ]
        .filter((v): v is string => Boolean(v))
        .join(" · ")
    : "等待首条消息";

  const tokens = sessionStats?.tokens;
  // percent 是浮点（433.4k/1.00M → 43.3375），展示层必须取整
  const pct = contextUsage?.percent != null ? Math.round(contextUsage.percent) : null;
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
      {header ?? (
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
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* ---------- 任务（任务拆解清单 · 实时，置顶）---------- */}
        {todos && todoStats && (
          <Section
            title="任务"
            icon={<ListTodo size={12} />}
            meta={
              <span>
                {todoStats.done}/{todoStats.total}
                {todoStats.active ? " · 进行中" : todoStats.done === todoStats.total ? " · 全部完成" : ""}
              </span>
            }
          >
            <TodoList items={todos.items} />
          </Section>
        )}

        {/* ---------- 本轮证据（通栏）---------- */}
        {turn && <TurnSection turn={turn} cwd={cwd} onOpenFile={onOpenFile} />}

        {/* 本会话文件区已移除：
            ① 聊天区工具栏的「📄 N」按钮本来就能列出同一份文件（右侧预览面板可比
               观测栏窄列容纳更多信息，还带内容预览）；
            ② 项目视角的改动清单在「代码」页，入口也不缺；
            ③ 观测栏实测总高 ~1520px（已需滚动），而本会话文件是其中最弱的一份
               重复信息（长会话里前几条总是共几个最新文件）。数据仍在 ChatView 里
               供头部按钮与预览面板使用。 */}

        {/* 子代理（仅运行中渲染）：位置紧跟「本轮」，不破高频在前原则 */}
        <SubagentSection parentSessionId={sessionStats?.sessionId} onOpenSubagents={onOpenSubagents} />

        {/* ---------- 上下文窗口（独立区块）---------- */}
        {contextUsage ? (
          <Section
            title="上下文窗口"
            icon={<Layers size={12} />}
            meta={pct !== null ? `${pct}%` : undefined}
          >
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
          <Section title="上下文窗口" icon={<Layers size={12} />}>
            <Empty>暂无上下文数据。</Empty>
          </Section>
        )}

        {/* ---------- Git（压成一行：分支 · 状态 + 打开入口）---------- */}
        {gitInfo?.isRepo ? (
          <div
            data-section="Git"
            title="观测栏只读。提交与撤销提交在「Git 变更」页完成 —— 那里能先看 diff 并逐个勾选文件。"
            className="flex items-center gap-1.5 border-b border-line-soft px-3.5 py-3"
          >
            <span className="shrink-0 text-dim">
              <GitBranch size={12} />
            </span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-muted">
              <span className="text-fg">{gitInfo.branch || "（未知分支）"}</span>
              {" · "}
              <span className={cn(gitInfo.dirty > 0 && "text-accent")}>
                {gitInfo.dirty > 0 ? `未提交 ${gitInfo.dirty}` : "干净"}
              </span>
            </span>
            {onOpenGit && cwd && (
              <button
                onClick={() => onOpenGit(cwd)}
                data-testid="observatory-open-git"
                className="shrink-0 cursor-pointer rounded-md px-1.5 py-0.5 text-[11px] text-accent t-fast hover:bg-accent-soft"
              >
                打开 Git 变更 →
              </button>
            )}
          </div>
        ) : (
          <Section title="Git" icon={<GitBranch size={12} />}>
            <Empty>当前工作区不是 Git 仓库。</Empty>
          </Section>
        )}

        {/* ---------- 运行统计（默认一行摘要，点开展开明细）---------- */}
        <CollapsibleSection
          title="运行统计"
          icon={<ListChecks size={12} />}
          summary={statsSummary}
          testId="rail-stats-toggle"
        >
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
        </CollapsibleSection>

        {/* ---------- 近 N 轮（运行统计与会话信息之间）：逐轮趋势，轮数 < 2 不渲染 ---------- */}
        <TrendsSection trends={trends} />

        {/* ---------- 会话信息（底部折叠区：运行环境 + 会话产物 + 会话文件）----------
            低频信息集中到最后：默认收起，要用时展开。 ---------- */}
        <CollapsibleSection title="会话信息" icon={<Hash size={12} />} testId="rail-session-info">
          <div className="text-[10px] uppercase tracking-wide text-dim">运行环境</div>
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

          {(onExportHtml || onClone) && (
            <div className="mt-3 border-t border-line-soft pt-2.5">
              <div className="text-[10px] uppercase tracking-wide text-dim">会话产物</div>
              <div className="mt-1.5 flex flex-col gap-1.5">
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
            </div>
          )}

          {sessionStats?.sessionFile && (
            <div className="mt-3 border-t border-line-soft pt-2.5">
              <div className="text-[10px] uppercase tracking-wide text-dim">会话文件</div>
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
        </CollapsibleSection>
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
  /** 由轮询 effect 注入的立即刷新函数：中止成功后用它拉真实状态，而不是乐观置 failed */
  const refreshRef = useRef<() => void>(() => {});

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
    refreshRef.current = load;
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
      const res = await fetch(`/api/subagents/${encodeURIComponent(sessionId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "abort" }),
      });
      if (!res.ok) {
        toast(`中止子代理失败（HTTP ${res.status}）`);
        return;
      }
      // 不乐观置 failed：服务端可能还在收尾，立即刷新以真实状态为准
      refreshRef.current();
    } catch {
      toast("中止子代理失败（网络错误）");
    } finally {
      setBusyId(null);
    }
  };

  /* 没有子代理运行时**不渲染**：零占位，避免给大多数不用子代理的会话添噪 */
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
