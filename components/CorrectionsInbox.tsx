"use client";

import { FileText, Inbox, Loader2, RefreshCw, Save, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/bits";
import { CopyButton } from "@/components/ui/widgets";
import { dialogPrompt, toast } from "@/components/ui/dialog";
import { Popover } from "@/components/ui/popover";
import { cn } from "@/components/lib/utils";
import { basename } from "@/lib/format";
import type { MemoryProject } from "@/components/MemoryPage";

/** 记忆来源账本里的一条（与 lib/memory-origins.ts 的 MemoryOrigin 对齐） */
type MemoryOrigin = {
  via: "agent" | "web-edit" | "remember" | "pending";
  at: string;
  sessionId?: string;
  cwd?: string;
};

/** 纠正的处理状态（sidecar；不在其中 = 待处理） */
type CorrectionStatus = "promoted" | "shelved" | "resolved";

const CORRECTION_STATUS_STYLE: Record<CorrectionStatus, { label: string; chip: string }> = {
  promoted: { label: "已升格", chip: "chip chip-success" },
  resolved: { label: "已处理", chip: "chip" },
  shelved: { label: "已搁置", chip: "chip chip-warn" },
};

type CorrectionState = {
  status: CorrectionStatus;
  at: string;
  ruleHash?: string;
  ruleCore?: string;
  ruleText?: string;
  memoryFile?: string;
};

/** 一次复发命中（与已升格规则的相似度 ≥ 阈值） */
type CorrectionRecurrence = { ruleHash: string; ruleCore: string; score: number; memoryFile?: string };

/** 一条捕获的纠正（GET /api/corrections 的一项） */
type CorrectionItem = {
  id: string;
  file: string;
  label: string;
  text: string;
  core: string;
  failureReason: string | null;
  createdAt: string | null;
  lastAt: string | null;
  origin: MemoryOrigin | null;
  ruleDraft: string;
  agentsDraft: string;
  state: CorrectionState | null;
  recurrence: CorrectionRecurrence | null;
};

/** 一条已升格规则 + 它之后的复发命中 */
type CorrectionRule = {
  ruleHash: string;
  ruleCore: string;
  ruleText: string;
  memoryFile: string | null;
  at: string;
  sourceCorrectionId: string;
  hits: { correctionId: string; score: number }[];
};

type CorrectionsResponse = {
  items: CorrectionItem[];
  rules: CorrectionRule[];
  stats: {
    total: number;
    pending: number;
    promoted: number;
    resolved: number;
    shelved: number;
    recurrences: number;
  };
  threshold: number;
  memoryFiles: { id: string; label: string; kind: string; chars: number; limit: number }[];
};

/**
 * 纠正收件箱：把 pi-hermes-memory 自动捕获的用户纠错（记忆文件里的 `[correction]` 条目）
 * 集中呈现，并提供「一键升格为规则 / 生成 AGENTS.md 草稿 / 标记处理状态」三个动作。
 *
 * 为什么落在记忆页：纠错的痕迹本来就是记忆文件（failures.md 一族），来这里看余量、看重复、
 * 落盘去向最自然；升格写记忆也复用既有的记忆写链（并发校验 / 配额 / 备份 / 原子写）。
 *
 * 边界：
 *  - AGENTS.md 是受保护文件，界面**只出草稿 + 一键复制**，任何路径都不自动写；
 *  - 「可能复发」只是相似度提示（bigram Jaccard ≥ 0.33），不自动改/撤已升格的规则。
 */
export function CorrectionsInboxView({ projects }: { projects: MemoryProject[] }) {
  const [data, setData] = useState<CorrectionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  /** 正在操作的纠正 id（防重复点击 + 行内转圈） */
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [draftOpen, setDraftOpen] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/corrections", { cache: "no-store" });
      const d = (await res.json()) as CorrectionsResponse & { error?: string };
      if (!res.ok) throw new Error(d.error || `加载失败（HTTP ${res.status}）`);
      setData(d);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  /** 项目级升格去向（项目名取路径 basename，与项目记忆目录口径一致） */
  const projectTargets = useMemo(
    () => projects.map((p) => ({ id: `project/${basename(p.path)}`, name: p.name, path: p.path })),
    [projects],
  );

  const targetLabel = useCallback(
    (id: string) => {
      if (id === "memory") return "全局 MEMORY.md";
      const p = projectTargets.find((t) => t.id === id);
      return p ? `${p.name} / MEMORY.md` : id;
    },
    [projectTargets],
  );

  /** 默认去向：纠正来源会话的 cwd 能对上项目就写项目记忆，否则写全局 */
  const defaultTarget = useCallback(
    (item: CorrectionItem) => {
      const cwd = item.origin?.cwd;
      if (cwd) {
        const hit = projectTargets.find((p) => cwd === p.path || cwd.startsWith(`${p.path}/`));
        if (hit) return hit.id;
      }
      return "memory";
    },
    [projectTargets],
  );

  const quotaOf = useCallback((id: string) => data?.memoryFiles.find((f) => f.id === id) ?? null, [data]);

  /** 统一 POST：成功后刷新，失败把服务端文案原样抛出（配额超限最需要看得见） */
  const act = useCallback(
    async (id: string, body: Record<string, unknown>, okMsg?: string) => {
      setBusyId(id);
      try {
        const res = await fetch("/api/corrections", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, ...body }),
        });
        const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; agentsDraft?: string };
        if (!res.ok || !d.ok) throw new Error(d.error || `操作失败（HTTP ${res.status}）`);
        if (okMsg) toast(okMsg);
        setReloadKey((k) => k + 1);
        return d;
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        setBusyId(null);
      }
    },
    [],
  );

  /** 升格：先在对话框里确认/修改规则正文（默认稿 = 确定性草稿），再写入所选记忆文件 */
  const promote = useCallback(
    async (item: CorrectionItem, fileId: string) => {
      const label = targetLabel(fileId);
      const edited = await dialogPrompt({
        title: "升格为规则",
        message: `把这次纠正改写成「今后怎么做」，确认后写入 ${label}。`,
        defaultValue: item.ruleDraft,
        confirmText: "升格",
      });
      if (!edited) return;
      await act(item.id, { action: "promote", file: fileId, text: edited }, `已升格为规则 · 写入 ${label}`);
    },
    [act, targetLabel],
  );

  /** 生成 AGENTS.md 草稿：文本由服务端已在 item.agentsDraft 里给出，这里只展开面板（绝不写 AGENTS.md） */
  const toggleDraft = useCallback((item: CorrectionItem) => {
    setDraftOpen((prev) => ({ ...prev, [item.id]: !prev[item.id] }));
  }, []);

  const setStatus = useCallback(
    async (item: CorrectionItem, action: "shelve" | "resolve" | "reopen") => {
      const msg = action === "reopen" ? "已恢复为待处理" : action === "shelve" ? "已搁置" : "已标记处理";
      await act(item.id, { action }, msg);
    },
    [act],
  );

  const items = data?.items ?? [];
  const pending = items.filter((i) => !i.state);
  const handled = items.filter((i) => i.state);
  const stats = data?.stats;

  /** 升格去向选择行：名字 + 提示 + 当前占用（超限时写不进去，先让人看见） */
  const renderTarget = (item: CorrectionItem, close: () => void, id: string, name: string, hint: string) => {
    const q = quotaOf(id);
    const pct = q && q.limit > 0 ? Math.round((q.chars / q.limit) * 100) : null;
    const over = q ? q.chars > q.limit : false;
    return (
      <button
        key={id}
        onClick={() => {
          close();
          void promote(item, id);
        }}
        disabled={busyId === item.id}
        className="cursor-pointer rounded-md px-2 py-1.5 text-left text-[12px] text-fg t-fast hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        {name}
        <span className="block text-[10px] text-dim">
          {hint}
          {pct !== null && (
            <>
              {" · 占用 "}
              {pct}%{over ? "（已超限，写入会被拒）" : ""}
            </>
          )}
        </span>
      </button>
    );
  };

  const renderItem = (item: CorrectionItem) => {
    const st = item.state;
    const busy = busyId === item.id;
    const long = item.text.length > 220 || item.text.split("\n").length > 3;
    const open = expanded[item.id] === true;
    const draftVisible = draftOpen[item.id] === true;
    const draft = item.agentsDraft;
    return (
      <div
        key={item.id}
        data-testid="correction-item"
        className="flex flex-col gap-2 rounded-md border border-line-soft bg-panel px-3 py-2.5"
      >
        <div className="flex flex-wrap items-center gap-2 text-[10px] tabular-nums text-dim">
          <span className="chip chip-accent">纠正</span>
          {item.createdAt && <span>{item.createdAt}</span>}
          <span className="font-mono">{item.label}</span>
          {item.origin?.cwd && (
            <span className="truncate font-mono" title={item.origin.cwd}>
              {basename(item.origin.cwd)}
            </span>
          )}
          {item.origin?.sessionId && (
            <span className="font-mono" title={item.origin.sessionId}>
              会话 {item.origin.sessionId.slice(0, 8)}
            </span>
          )}
          {item.recurrence && (
            <span
              className="chip chip-warn"
              title={`与已升格规则相似 ${Math.round(item.recurrence.score * 100)}%：${item.recurrence.ruleCore}`}
            >
              可能复发 {Math.round(item.recurrence.score * 100)}%
            </span>
          )}
          {st && <span className={CORRECTION_STATUS_STYLE[st.status].chip}>{CORRECTION_STATUS_STYLE[st.status].label}</span>}
        </div>

        <div
          className={cn(
            "break-words whitespace-pre-wrap text-[12px] leading-relaxed text-fg",
            long && !open && "line-clamp-3",
          )}
        >
          {item.core}
        </div>
        {item.failureReason && (
          <div className="break-words whitespace-pre-wrap text-[11px] leading-relaxed text-dim">
            由来：{item.failureReason}
          </div>
        )}
        {long && (
          <button
            onClick={() => setExpanded((prev) => ({ ...prev, [item.id]: !open }))}
            className="cursor-pointer self-start text-[11px] text-accent t-fast hover:underline"
          >
            {open ? "收起" : "展开全文"}
          </button>
        )}

        <div className="rounded-md border border-line-soft bg-panel-2 px-2.5 py-1.5 text-[11px] leading-relaxed text-muted">
          <span className="mr-1 text-dim">规则草稿</span>
          <span className="break-words">{item.ruleDraft}</span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {!st && (
            <>
              <Popover
                align="left"
                trigger={({ toggle }) => (
                  <button
                    onClick={toggle}
                    disabled={busy}
                    data-testid="correction-promote"
                    className="btn btn-primary btn-sm"
                  >
                    <Save size={12} /> 升格为记忆…
                  </button>
                )}
              >
                {(close) => (
                  <div className="flex w-64 flex-col p-1">
                    {projectTargets.length > 0 && <div className="px-2 py-1 text-[10px] text-dim">项目记忆</div>}
                    {projectTargets.map((t) => renderTarget(item, close, t.id, t.name, t.path))}
                    <div className="px-2 py-1 text-[10px] text-dim">全局记忆</div>
                    {renderTarget(item, close, "memory", "MEMORY.md", "所有项目共享")}
                    <div className="px-2 py-1.5 text-[10px] leading-relaxed text-dim">
                      默认去向：{targetLabel(defaultTarget(item))}。升格只写记忆文件；AGENTS.md 走「生成草稿」手动复制。
                    </div>
                  </div>
                )}
              </Popover>
              <button
                onClick={() => toggleDraft(item)}
                disabled={busy}
                data-testid="correction-agents-draft"
                className="btn btn-subtle btn-sm"
              >
                <FileText size={12} /> AGENTS.md 草稿
              </button>
              <button onClick={() => void setStatus(item, "resolve")} disabled={busy} className="btn btn-ghost btn-sm">
                已处理
              </button>
              <button onClick={() => void setStatus(item, "shelve")} disabled={busy} className="btn btn-ghost btn-sm">
                搁置
              </button>
            </>
          )}
          {st && (
            <button
              onClick={() => void setStatus(item, "reopen")}
              disabled={busy}
              data-testid="correction-reopen"
              className="btn btn-subtle btn-sm"
            >
              恢复待处理
            </button>
          )}
          {busy && <Loader2 size={12} className="anim-spin text-dim" />}
        </div>

        {draftVisible && (
          <div className="flex flex-col gap-1.5 rounded-md border border-line-soft bg-panel-2 p-2.5">
            <div className="flex items-center gap-2 text-[10px] text-dim">
              AGENTS.md 规则建议（草稿，不会自动写入）
              <span className="ml-auto flex items-center gap-1">
                <CopyButton text={draft} />
                <button
                  onClick={() => setDraftOpen((prev) => ({ ...prev, [item.id]: false }))}
                  className="btn btn-icon"
                  title="收起草稿"
                >
                  <X size={12} />
                </button>
              </span>
            </div>
            <pre className="max-h-48 overflow-auto break-words whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted">
              {draft}
            </pre>
          </div>
        )}
      </div>
    );
  };

  return (
    <div data-testid="corrections-inbox" className="flex flex-col gap-3">
      <Card>
        <CardHeader className="flex-wrap">
          <CardTitle>纠正收件箱</CardTitle>
          <span className="chip">{stats?.pending ?? 0} 待处理</span>
          <span className="chip chip-success">{stats?.promoted ?? 0} 已升格</span>
          {(stats?.recurrences ?? 0) > 0 && <span className="chip chip-warn">{stats?.recurrences} 可能复发</span>}
          <span className="ml-auto hidden truncate text-[10px] text-dim lg:block">
            来源：pi-hermes-memory 捕获的 [correction] 条目（只读；升格写记忆走既有链路）
          </span>
          <button
            onClick={() => setReloadKey((k) => k + 1)}
            disabled={loading}
            title="重新读取记忆文件与处理状态"
            className="btn btn-ghost btn-sm shrink-0"
          >
            <RefreshCw size={12} className={cn(loading && "anim-spin")} /> 刷新
          </button>
        </CardHeader>

        <div className="flex flex-col gap-2 p-3">
          {loading && !data ? (
            <div className="flex items-center gap-2 py-6 text-[12px] text-dim">
              <Loader2 size={14} className="anim-spin" /> 读取纠正记录…
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={<Inbox size={20} />}
              title="还没有捕获到纠正"
              hint={
                <>
                  记忆扩展会在你纠错时（如「不对」「我说的是…」「已经说过了」）自动把这条落成记忆文件里的{" "}
                  <span className="font-mono">[correction]</span> 条目，之后就会出现在这里。若确定纠过但没看到，
                  说明自动捕获漏了 —— 这是当前已知的缺口（只用规则命中，不落原文与会话号）。
                </>
              }
            />
          ) : (
            <>
              {pending.length > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="text-[11px] text-dim">待处理 · {pending.length}</div>
                  {pending.map(renderItem)}
                </div>
              )}
              {handled.length > 0 && (
                <div className="mt-1 flex flex-col gap-2">
                  <div className="text-[11px] text-dim">已处理 · {handled.length}</div>
                  {handled.map(renderItem)}
                </div>
              )}
            </>
          )}
        </div>

        <div className="border-t border-line-soft px-3 py-2 text-[11px] leading-relaxed text-dim">
          升格 = 把「那次纠正」改写成「今后怎么做」的规则，写进记忆文件（全局或某项目的 MEMORY.md）；记忆有字符上限，
          目标文件超限时会被硬拒，先合并或清理。AGENTS.md 是受保护文件，这里
          <strong className="font-medium text-fg">只生成草稿供你复制</strong>，绝不自动写入。
        </div>
      </Card>

      {data && data.rules.length > 0 && (
        <Card data-testid="correction-rules">
          <CardHeader className="flex-wrap">
            <CardTitle>已升格规则 · 复发对照</CardTitle>
            <span className="ml-auto text-[10px] text-dim">
              后续纠正与规则本体相似 ≥ {Math.round(data.threshold * 100)}% 记为可能复发
            </span>
          </CardHeader>
          <div className="flex flex-col gap-2 p-3">
            {data.rules.map((rule) => (
              <div
                key={rule.ruleHash}
                data-testid="correction-rule"
                className="flex flex-col gap-1 rounded-md border border-line-soft bg-panel-2 px-3 py-2"
              >
                <div className="flex flex-wrap items-center gap-2 text-[10px] tabular-nums text-dim">
                  <span className="font-mono">{rule.memoryFile ?? "—"}</span>
                  <span>{rule.at.slice(0, 10)}</span>
                  {rule.hits.length > 0 ? (
                    <span className="chip chip-warn">后续命中 {rule.hits.length} 条</span>
                  ) : (
                    <span className="chip chip-success">暂无复发</span>
                  )}
                </div>
                <div className="break-words text-[12px] leading-relaxed text-fg">{rule.ruleCore}</div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
