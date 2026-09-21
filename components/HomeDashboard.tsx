"use client";

import { Clock, Cpu, KeyRound, Loader2, Play, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/components/lib/utils";
import { basename, formatCost, formatTokens, relTime, timeLabel } from "@/lib/format";
import type { UsageReport } from "@/lib/usage-aggregate";
import type { AttentionItem } from "@/lib/attention";
import type { SessionInfo } from "@/lib/types";
import { UsageAnalysis } from "@/components/home/UsageAnalysis";
import { TodayOverview } from "@/components/home/TodayOverview";
import { RunningCards } from "@/components/home/RunningCards";
import { ModelSetupDialog } from "@/components/ModelSetupDialog";

/** 模型短名：provider/modelId → modelId */
function shortModel(model?: string): string {
  if (!model) return "";
  const [, id = model] = model.split("/");
  return id;
}

/** 展示用标题清洗：剥掉代码块 / 文件路径 / JSON 与 markdown 符号，压成一句可读的话。 */
function cleanTitle(raw: string | undefined, max = 28): string {
  if (!raw) return "";
  let t = raw;
  t = t.replace(/```[\s\S]*?```/g, " "); // 代码围栏
  t = t.replace(/`([^`]*)`/g, "$1"); // 行内代码（保留内容）
  t = t.replace(/[\w./\\-]+\.(tsx?|jsx?|mjs|json|css|html?|md|py|sql|ya?ml)\b/gi, " "); // 文件名
  t = t.replace(/(?:\/|\\)[\w.\-\\]{2,}/g, " "); // 路径片段
  t = t.replace(/[{}[\]":,]/g, " "); // JSON 符号
  t = t.replace(/[#*_>~|]+/g, " "); // markdown 符号
  t = t.replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 列表 / 头像展示标题：优先已命名，其次清洗后的首条消息。 */
function displayTitle(s: SessionInfo): string {
  return s.name || cleanTitle(s.firstMessage) || "(无标题)";
}

/** 问候语随小时切换；入参用调用方的时间，避免与首屏渲染不一致。 */
function greeting(now: Date): string {
  const h = now.getHours();
  if (h < 6) return "凌晨好";
  if (h < 12) return "早上好";
  if (h < 14) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}

/** 会话名首字母头像 */
function Avatar({ session, running }: { session: SessionInfo; running: boolean }) {
  const name = session.name || cleanTitle(session.firstMessage);
  const letter = (name.trim()[0] || "?").toUpperCase();
  return (
    <div
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold",
        running ? "bg-accent text-accent-fg" : "bg-panel-2 text-muted",
      )}
    >
      {letter}
    </div>
  );
}

type TabKey = "all" | "running" | "attention" | "idle";

const TABS: { key: TabKey; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "running", label: "运行中" },
  { key: "attention", label: "需关注" },
  { key: "idle", label: "空闲" },
];

export function HomeDashboard({
  sessions,
  runningIds,
  unreadIds,
  onOpenSession,
  onViewAll,
  contentResults,
  contentSearching,
  contentTruncated,
}: {
  sessions: SessionInfo[];
  runningIds: Set<string>;
  /** 已完成但未查看的会话（表格里显示绿点） */
  unreadIds?: Set<string>;
  onOpenSession: (s: SessionInfo) => void;
  onViewAll: () => void;
  defaultCwd?: string | null;
  contentResults?: { session: SessionInfo; before: string; match: string; after: string }[];
  contentSearching?: boolean;
  contentTruncated?: boolean;
}) {
  const [tab, setTab] = useState<TabKey>("all");

  /*
   * 无凭据引导：一个凭据都没配时，工作台上是一片空白，却没有任何地方
   * 说明要去哪里填 Key —— 这是最容易卡住的第一步。这里主动把「接入模型」
   * 推到面前。
   */
  const [setupOpen, setSetupOpen] = useState(false);
  const [hasCredential, setHasCredential] = useState<boolean | null>(null);
  const checkCredentials = useMemo(
    () => async () => {
      try {
        const d = (await fetch("/api/auth", { cache: "no-store" }).then((r) => r.json())) as {
          providers?: { auth: unknown; envSet: boolean }[];
        };
        setHasCredential((d.providers ?? []).some((p) => p.auth || p.envSet));
      } catch {
        setHasCredential(null);
      }
    },
    [],
  );
  useEffect(() => {
    void checkCredentials();
  }, [checkCredentials]);

  // 时钟：每 30s 刷新（分钟级精度足够）。
  // 初值必须是 null：若在 SSR 里渲染真实时间，服务端与客户端几乎必然差 1 分钟，
  // React 会判定水合失败并整树重建（Hydration failed）。
  // 占位首帧不可见 —— Hero 带 anim-fade-up（fill-mode: both，起始即透明）。
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  // 技能调用排行（离线扫描全部会话，数据随使用积累）
  const [skillUsage, setSkillUsage] = useState<{ total: number; skills: { name: string; count: number }[] } | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/skill-usage", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { total: number; skills: { name: string; count: number }[] } | null) => {
        if (!cancelled && d) setSkillUsage(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sessions]);

  // 离线 token/费用汇总（跨会话全量扫描，服务端带 mtime 缓存）
  const [usage, setUsage] = useState<UsageReport | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/usage", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: UsageReport | null) => {
        if (!cancelled && data) setUsage(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sessions]);

  // 需关注（被中断 / 工具报错）
  const [attention, setAttention] = useState<AttentionItem[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/attention", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { items?: AttentionItem[] } | null) => {
        if (!cancelled && data?.items) setAttention(data.items);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sessions]);

  const runningSessions = useMemo(() => sessions.filter((s) => runningIds.has(s.id)), [sessions, runningIds]);
  const attentionById = useMemo(() => {
    const map = new Map<string, AttentionItem>();
    for (const a of attention) map.set(a.sessionId, a);
    return map;
  }, [attention]);

  // 近 7 日每日新会话数（总会话卡 spark 已移除，保留给状态条无用；省略）
  const stats = useMemo(() => {
    const projects = new Set(sessions.map((s) => s.cwd));
    return { total: sessions.length, running: runningIds.size, projects: projects.size };
  }, [sessions, runningIds]);

  const tabbed = useMemo(() => {
    const sorted = [...sessions].sort((a, b) => (b.modified || "").localeCompare(a.modified || ""));
    if (tab === "running") return sorted.filter((s) => runningIds.has(s.id));
    if (tab === "attention") return sorted.filter((s) => attentionById.has(s.id));
    if (tab === "idle") return sorted.filter((s) => !runningIds.has(s.id));
    // 全部：运行中的会话已由上方「实时卡」承载（带 5s 轮询的最新动态），
    // 这里不再重复成行 —— 同一会话在同一屏出现两次会被当成 bug。
    return sorted.filter((s) => !runningIds.has(s.id));
  }, [sessions, runningIds, tab, attentionById]);

  const tabCount = (key: TabKey) => {
    if (key === "all") return sessions.length;
    if (key === "running") return runningIds.size;
    if (key === "attention") return attention.length;
    return sessions.length - runningIds.size;
  };

  // 模型用量排行（token 降序，取前 5）
  const topModels = useMemo(() => {
    if (!usage) return [];
    return Object.entries(usage.models)
      .map(([model, u]) => ({ model, tokens: u.tokens.total, cost: u.cost }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 5);
  }, [usage]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="page-col py-5">
        {/* Hero：时钟卡 + 问候 */}
        <div className="anim-fade-up flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="card flex items-center gap-3 px-5 py-3">
            <span className="text-[32px] font-bold leading-none tabular-nums" style={{ fontFamily: "var(--font-app-mono)" }}>
              {now ? now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }) : "--:--"}
            </span>
            <span className="text-[12px] leading-5 text-dim">
              {now ? now.toLocaleDateString("zh-CN", { month: "long", day: "numeric" }) : "—"}
              <br />
              {now ? now.toLocaleDateString("zh-CN", { weekday: "long" }) : "—"}
            </span>
          </div>
          <div className="min-w-0">
            <h1 className="text-[20px] font-bold tracking-tight">{now ? greeting(now) : "\u00a0"}</h1>
          </div>
        </div>
        <div
          className="anim-fade-up mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-line pb-3 text-[12px]"
          style={{ animationDelay: "70ms" }}
        >
            <span className={cn("inline-flex items-center gap-1.5", stats.running > 0 ? "font-semibold text-accent" : "text-dim")}>
              {stats.running > 0 && <span className="size-1.5 rounded-full bg-accent anim-pulse-dot" />}
              运行中 {stats.running}
            </span>
            <span className={cn(attention.length > 0 ? "font-semibold text-warn" : "text-dim")}>需关注 {attention.length}</span>
            {/* 今日/累计 token 与成本不在此重复 —— 它们是右栏「今日概览」卡的职责 */}
            <span className="ml-auto text-dim">
              {stats.total} 会话 · {stats.projects} 项目
            </span>
          </div>

        {/* 首次使用引导：未接入任何模型时主动提示，而非给一片空工作台 */}
        {hasCredential === false && (
          <div
            className="anim-fade-up mt-4 flex flex-wrap items-center gap-3 rounded-card border border-accent/30 bg-accent-soft/50 px-4 py-3.5"
            data-testid="setup-guide"
          >
            <div className="flex size-9 shrink-0 items-center justify-center rounded-card bg-accent text-accent-fg">
              <KeyRound size={16} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-semibold text-fg">还没有接入模型</div>
              <div className="mt-0.5 text-[12px] leading-relaxed text-muted">
                选一个厂商填入 API Key（或用订阅账号登录），再挑一个默认模型就能开始。
                凭据只存在本机 <code className="font-mono text-[11px]">~/.pi/agent/auth.json</code>。
              </div>
            </div>
            <button
              onClick={() => setSetupOpen(true)}
              data-testid="guide-setup"
              className="btn btn-primary h-9 shrink-0 px-3.5"
            >
              接入模型 →
            </button>
          </div>
        )}

        {/* 内容搜索结果 */}
        {(contentSearching || (contentResults && contentResults.length > 0)) && (
          <div className="card mt-4 overflow-hidden">
            <div className="flex items-center gap-2 px-4 pt-3.5 pb-2">
              <h2 className="text-[14px] font-semibold">内容匹配</h2>
              {contentSearching && <Loader2 size={12} className="anim-spin text-accent" />}
              {contentTruncated && <span className="text-[11px] text-dim">（结果已截断）</span>}
            </div>
            <div className="max-h-72 overflow-y-auto pb-2">
              {contentSearching && (!contentResults || contentResults.length === 0) && (
                <div className="px-4 py-4 text-[12px] text-dim">正在搜索消息内容…</div>
              )}
              {contentResults?.map((r, i) => (
                <button
                  key={`${r.session.id}-${r.match}-${i}`}
                  onClick={() => onOpenSession(r.session)}
                  className="flex w-full cursor-pointer items-start gap-2.5 border-t border-line-soft px-4 py-2.5 text-left t-fast first:border-t-0 hover:bg-hover"
                >
                  <Avatar session={r.session} running={runningIds.has(r.session.id)} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] font-semibold">{displayTitle(r.session)}</div>
                    <div className="mt-0.5 truncate text-[12px] text-muted">
                      …{r.before}
                      <mark className="rounded-sm bg-accent-soft px-0.5 text-accent">{r.match}</mark>
                      {r.after}…
                    </div>
                  </div>
                  <span className="chip chip-mono mt-0.5 shrink-0">
                    {basename(r.session.cwd)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 主体两栏：会话流 | 概览侧栏。
            整排固定等高（lg:h），右列两卡平分高度 —— 卡片尺寸不再随会话条数、
            动态条数变化；会话多于可视行数时在卡内滚动，不把整页顶长。 */}
        <div className="mt-4 flex flex-wrap gap-3.5 lg:h-[780px] lg:flex-nowrap">
          {/* 左：会话流 */}
          <div className="card flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden lg:min-w-[420px]">
            <div className="flex shrink-0 items-center justify-between px-4 pt-3.5">
              <h2 className="text-[14px] font-semibold">会话流</h2>
              <button
                onClick={onViewAll}
                className="flex items-center gap-1 text-[12px] font-medium text-accent cursor-pointer hover:text-accent-hover"
              >
                查看全部 →
              </button>
            </div>
            {/* 标签页 */}
            <div className="mt-2 flex shrink-0 gap-1 border-b border-line px-4">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={cn(
                    "-mb-px flex items-center gap-1.5 border-b-2 px-3 pb-2 pt-1 text-[12px] t-fast cursor-pointer",
                    tab === t.key
                      ? "border-accent font-semibold text-accent"
                      : "border-transparent text-dim hover:text-fg",
                  )}
                >
                  {t.label}
                  <span
                    className={cn(
                      "rounded-full px-1.5 text-[11px] leading-4",
                      tab === t.key ? "bg-active text-accent" : "bg-panel-2 text-dim",
                      t.key === "attention" && attention.length > 0 && tab !== t.key && "bg-warn/10 text-warn",
                    )}
                  >
                    {tabCount(t.key)}
                  </span>
                </button>
              ))}
            </div>
            {/* 运行中实时卡：与下方表格互斥（「运行中」页签改用表格展示，
                其余页签用实时卡），保证同一会话只出现一次 */}
            {tab !== "running" && (
              <div className="shrink-0">
                <RunningCards running={runningSessions} usage={usage} onOpenSession={onOpenSession} />
              </div>
            )}
            {/* 表格区：卡内滚动。固定高度由外层决定，条数少了空着、多了滚，卡片本身不变形 */}
            <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full table-fixed border-collapse">
              <thead>
                <tr>
                  <th className="border-b border-line px-3 pb-2 pt-2 text-left text-[12px] font-normal text-dim">会话</th>
                  <th className="hidden w-[176px] border-b border-line px-3 pb-2 pt-2 text-left text-[12px] font-normal text-dim min-[1800px]:table-cell">模型</th>
                  <th className="w-[132px] border-b border-line px-3 pb-2 pt-2 text-left text-[12px] font-normal text-dim">用量</th>
                  <th className="w-[112px] border-b border-line px-3 pb-2 pt-2 text-left text-[12px] font-normal text-dim">状态</th>
                  <th className="hidden w-[84px] border-b border-line px-3 pb-2 pt-2 text-left text-[12px] font-normal text-dim min-[1800px]:table-cell">更新</th>
                  <th className="w-16 border-b border-line px-3 pb-2 pt-2"></th>
                </tr>
              </thead>
              <tbody>
                {tabbed.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-[13px] text-dim">
                      {tab === "attention" ? "没有需要关注的会话" : "暂无会话，点击右上角「新建会话」开始"}
                    </td>
                  </tr>
                )}
                {/* 不再截断 10 条：表格区已可滚动，固定的是卡片高度而不是可见条数 */}
                {tabbed.map((s) => {
                  const running = runningIds.has(s.id);
                  const attn = attentionById.get(s.id);
                  return (
                    <tr key={s.id} className="cursor-pointer t-fast hover:bg-hover" onClick={() => onOpenSession(s)}>
                      <td className="border-b border-line-soft px-3 py-2.5">
                        <div className="flex items-center gap-2.5">
                          <Avatar session={s} running={running} />
                          <div className="min-w-0">
                            <div className="truncate text-[13px] font-semibold">{displayTitle(s)}</div>
                            <div className="truncate text-[12px] text-dim">{s.name ? cleanTitle(s.firstMessage) : ""}</div>
                          </div>
                        </div>
                      </td>
                      <td className="hidden border-b border-line-soft px-3 py-2.5 min-[1800px]:table-cell">
                        {(() => {
                          const u = usage?.sessions[s.id];
                          const model = shortModel(u?.model);
                          if (!model) return <span className="text-dim">—</span>;
                          return (
                            <span
                              className="chip chip-mono inline-block max-w-[120px] truncate"
                              title={`${u?.model ?? model} · ${s.messageCount} 条消息`}
                            >
                              {model}
                            </span>
                          );
                        })()}
                      </td>
                      <td className="whitespace-nowrap border-b border-line-soft px-3 py-2.5 text-[12px] tabular-nums text-muted">
                        {(() => {
                          const u = usage?.sessions[s.id];
                          if (!u || u.tokens.total === 0) return <span className="text-dim">—</span>;
                          return (
                            <span
                              title={`输入 ${formatTokens(u.tokens.input)} · 输出 ${formatTokens(u.tokens.output)} · 缓存 ${formatTokens(u.tokens.cacheRead + u.tokens.cacheWrite)} · 费用 ${formatCost(u.cost)} · ${s.messageCount} 条消息`}
                            >
                              {formatTokens(u.tokens.total)}
                              <span className="ml-1.5 text-[12px] text-dim">{formatCost(u.cost)}</span>
                            </span>
                          );
                        })()}
                      </td>
                      <td className="whitespace-nowrap border-b border-line-soft px-3 py-2.5">
                        {running ? (
                          <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-accent">
                            <Loader2 size={12} className="anim-spin" /> 运行中
                          </span>
                        ) : attn ? (
                          <span
                            className="inline-flex items-center gap-1.5 text-[12px] font-medium text-warn"
                            title={attn.detail}
                          >
                            <span className="size-1.5 rounded-full bg-warn anim-pulse-dot" />
                            {attn.reasons.includes("interrupted") ? "被中断" : "工具报错"}
                          </span>
                        ) : unreadIds?.has(s.id) ? (
                          /* 跑完但还没看的：实心绿点（静态，不用闪烁） */
                          <span
                            className="inline-flex items-center gap-1.5 text-[12px] font-medium text-success"
                            title="已完成，尚未查看"
                          >
                            <span className="size-1.5 rounded-full bg-success" /> 已完成
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-[12px] text-dim">
                            <span className="size-1.5 rounded-full bg-dim/50" /> 空闲
                          </span>
                        )}
                      </td>
                      <td className="hidden whitespace-nowrap border-b border-line-soft px-3 py-2.5 text-[12px] text-dim min-[1800px]:table-cell" title={relTime(s.modified)}>
                        {timeLabel(s.modified)}
                      </td>
                      <td className="border-b border-line-soft px-3 py-2.5">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenSession(s);
                          }}
                          className="flex size-6.5 items-center justify-center rounded-md text-dim t-fast hover:bg-active hover:text-accent cursor-pointer"
                          title="打开会话"
                        >
                          <Play size={12} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          </div>

          {/* 右：今日概览 + 热力图。两卡 flex-1 平分高度，与左列底边对齐。
              宽度取 min(620, 40%)：内容（数字块 / 14 根柱 / 12 周格阵）是定宽尺度，
              跟着容器无限拉伸只会把内容摊薄；但在 1024~1440 这类中等屏上
              固定 620 会把左列表格挤扁，所以用百分比兜底。 */}
          <div className="flex min-h-0 w-full shrink-0 flex-col gap-3.5 lg:w-[min(620px,40%)]">
            {usage && <TodayOverview report={usage} className="min-h-0 flex-1" />}
            {/* 用量分析搬到原来热力图的位置（用户：热力图没用，把用量分析压进来）。
                它原先在底部通栏占满整行，三列布局；现在是右列紧凑版。 */}
            {usage && (
              <UsageAnalysis
                report={usage}
                sessions={sessions}
                onOpenSession={onOpenSession}
                className="min-h-0 flex-1"
              />
            )}
          </div>
        </div>

        {/* 中部两列：模型排行 | 技能（两卡各固定 5 槽，数据量不同也对齐） */}
        <div className="mt-3.5 grid gap-3.5 lg:grid-cols-2">
          <div className="card px-4 py-3.5">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-1.5 text-[14px] font-semibold">
                <Cpu size={14} className="text-accent" /> 模型用量排行
              </h2>
              <span className="text-[12px] text-dim">按 token</span>
            </div>
            <div className="mt-2.5 flex flex-col">
              {Array.from({ length: 5 }).map((_, i) => {
                const m = topModels[i];
                return (
                  <div key={m?.model ?? `m-${i}`} className="flex items-center gap-2.5 border-b border-line-soft py-2 last:border-b-0">
                    <span className={cn("w-5 text-center text-[11px] font-bold", m && i === 0 ? "text-accent" : "text-dim/40")}>{i + 1}</span>
                    {m ? (
                      <>
                        {/* chip 不加 flex-1：一拉长就成了“横跨整行的进度条”长相（背景色跟着铺开），
                            而它只是个模型名标签 */}
                        <span className="chip chip-mono min-w-0 truncate" title={m.model}>
                          {m.model}
                        </span>
                        <span className="ml-auto whitespace-nowrap text-[12px] tabular-nums text-muted">
                          {formatTokens(m.tokens)}
                          <span className="ml-1.5 text-[12px] text-dim">{formatCost(m.cost)}</span>
                        </span>
                      </>
                    ) : (
                      <span className="text-[12px] text-dim/40">—</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="card px-4 py-3.5">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-1.5 text-[14px] font-semibold">
                <Sparkles size={14} className="text-accent" /> 技能调用排行
              </h2>
              <span className="text-[12px] text-dim">累计 {skillUsage ? skillUsage.total : "…"} 次</span>
            </div>
            <div className="mt-2.5 flex flex-col">
              {Array.from({ length: 5 }).map((_, i) => {
                const sk = skillUsage?.skills[i];
                return (
                  <div key={sk?.name ?? `s-${i}`} className="flex items-center gap-2.5 border-b border-line-soft py-2 last:border-b-0">
                    <span className={cn("w-5 text-center text-[11px] font-bold", sk && i === 0 ? "text-accent" : "text-dim/40")}>{i + 1}</span>
                    {sk ? (
                      <>
                        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{sk.name}</span>
                        <span className="whitespace-nowrap text-[12px] tabular-nums text-muted">{sk.count} 次</span>
                      </>
                    ) : (
                      <span className="text-[12px] text-dim/40">—</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

      </div>

      {/* 接入模型向导（对应 pi CLI /login） */}
      <ModelSetupDialog
        open={setupOpen}
        onClose={() => setSetupOpen(false)}
        onDone={() => void checkCredentials()}
        reason="第一次使用？三步接入模型，之后就可开始对话"
      />
    </div>
  );
}
