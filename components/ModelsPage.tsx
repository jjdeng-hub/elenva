"use client";

import { Check, ChevronDown, ChevronRight, Cpu, Download, KeyRound, Loader2, RefreshCw, Save, ShieldCheck, Star, X } from "lucide-react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { useCallback, useEffect, useState } from "react";
import { cn } from "@/components/lib/utils";
import { dialogConfirm, dialogPrompt, toast } from "@/components/ui/dialog";
import { relTime } from "@/lib/format";
import { EmptyState, PageHeader, Skeleton } from "@/components/ui/bits";
import { ModelScopeEditor, type ModelScopeSummary } from "@/components/ModelScopeEditor";
import { ModelSetupDialog } from "@/components/ModelSetupDialog";

type ProviderConfig = { baseUrl?: string; apiKey?: string; [k: string]: unknown };
type CatalogEntry = { providerName?: string; id: string; name?: string; provider?: string };
type ProviderAuthStatus = {
  id: string;
  label: string;
  modelCount: number;
  env?: string;
  oauthOnly?: boolean;
  note?: string;
  auth: { type: string; masked?: string } | null;
  envSet: boolean;
};

/* ---------------- 厂商与密钥（对应 pi CLI /login） ---------------- */
function ProviderAuthSection({ onOpenSetup }: { onOpenSetup: (providerId: string) => void }) {
  const [providers, setProviders] = useState<ProviderAuthStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    try {
      const d = await fetch("/api/auth", { cache: "no-store" }).then((r) => r.json());
      setProviders(d.providers ?? []);
    } catch {
      setProviders([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const status = (p: ProviderAuthStatus) => (p.auth ? "已配置" : p.envSet ? "环境变量" : "未配置");

  const saveKey = async (p: ProviderAuthStatus) => {
    if (!keyDraft.trim()) return;
    setSaving(p.id);
    try {
      const res = await fetch("/api/auth", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: p.id, key: keyDraft.trim() }),
      });
      const d = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(d.error || `保存失败（HTTP ${res.status}）`);
      toast(`${p.label} 密钥已保存，立即生效`);
      setExpanded(null);
      setKeyDraft("");
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  };

  /** 退出 OAuth 订阅登录（删除 auth.json 中的 oauth 凭据） */
  const oauthLogout = async (p: ProviderAuthStatus) => {
    const ok = await dialogConfirm({
      title: "退出登录",
      message: `确定退出「${p.label}」的订阅账号登录？退出后需要重新授权才能使用。`,
      confirmText: "退出登录",
      danger: true,
    });
    if (!ok) return;
    setSaving(p.id);
    try {
      const res = await fetch(`/api/auth/logout/${encodeURIComponent(p.id)}`, { method: "POST" });
      const d = (await res.json().catch(() => ({}))) as { error?: string; ok?: boolean };
      if (!res.ok) throw new Error(d.error || `退出失败（HTTP ${res.status}）`);
      toast("已退出登录");
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  };

  const removeKey = async (p: ProviderAuthStatus) => {
    const ok = await dialogConfirm({
      title: "删除凭据",
      message: `确定删除「${p.label}」保存在 auth.json 中的凭据？`,
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/auth?provider=${encodeURIComponent(p.id)}`, { method: "DELETE" });
      const d = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(d.error || "删除失败");
      toast("已删除");
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const sorted = [...providers].sort((a, b) => {
    const rank = (p: ProviderAuthStatus) => (p.auth ? 0 : p.envSet ? 1 : 2);
    return rank(a) - rank(b) || a.label.localeCompare(b.label);
  });
  const configuredCount = providers.filter((p) => p.auth || p.envSet).length;
  const unconfiguredCount = providers.length - configuredCount;
  /** 常态只列已配置的厂商：42 个里通常只有 2 个有凭据，剩下 40 行是噪声。
   *  与 VS Code 扩展视图同构 —— 默认显示「已安装」，搜索才出全部。 */
  const searching = query.trim().length > 0;
  const visible = searching
    ? sorted.filter((p) => `${p.id} ${p.label}`.toLowerCase().includes(query.trim().toLowerCase()))
    : sorted.filter((p) => p.auth || p.envSet);

  const badgeCls = (p: ProviderAuthStatus) =>
    p.auth ? "chip-success" : p.envSet ? "chip-accent" : "";

  return (
    <Card testId="provider-auth">
      <CardHeader>
        <CardTitle>厂商与密钥</CardTitle>
        <span className="text-[12px] text-dim">
          内置 {providers.length} 个厂商 · 已配置 {configuredCount} 个 · 存放于 ~/.pi/agent/auth.json
        </span>
      </CardHeader>
      {loading ? (
        <div aria-busy="true" aria-label="加载厂商目录" className="px-4 py-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2 border-t border-line-soft py-2 first:border-t-0 first:pt-0">
              <Skeleton className="h-3.5 w-24 shrink-0" />
              <Skeleton className="h-3 w-32 shrink-0" />
              <Skeleton className="ml-auto h-5 w-16 shrink-0 rounded-sm" />
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="px-4 pt-3">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索厂商，如 deepseek、kimi、qwen…"
              className="h-8 w-full rounded-md border border-line bg-panel-2 px-2.5 text-[12px] text-fg outline-none focus:border-accent/50"
            />
          </div>
          {/* 常态不设 max-h：只有 2 个厂商配了凭据时，卡片就该只有 2 行高。
              旧的固定 max-h-[26rem] 叠在双列 grid 的拉伸上，才会出现「内容少了卡片不收缩」。
              只有搜索态才给上限，避免一次命中 30 个厂商把卡片撑成一屏。 */}
          <div className={cn("px-4 py-3", searching && "max-h-[26rem] overflow-y-auto")}>
            {visible.map((p) => {
              const open = expanded === p.id;
              return (
                <div
                  key={p.id}
                  data-testid="provider-row"
                  className="border-t border-line-soft py-2 first:border-t-0 first:pt-0"
                >
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        setExpanded(open ? null : p.id);
                        setKeyDraft("");
                      }}
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                    >
                      <span className="shrink-0 text-[12px] font-medium text-fg">{p.label}</span>
                      {/* 厂商 id 是要核对的内容（对错一字之差就接不上），抬到 12px */}
                      <span className="truncate font-mono text-[12px] text-dim">{p.id}</span>
                      {/* 这个数是**内置目录**里的模型数，与模型库组头的「N/M 可选」是两个不同集合
                          （可选集含 models.json / 目录外的模型），写清口径避免当成同一个数出错。 */}
                      <span className="chip shrink-0" title="pi 内置目录中该厂商的模型数；模型库组头的「N/M 可选」是包含自定义 Provider 的可选集">
                        内置 {p.modelCount} 模型
                      </span>
                    </button>
                    {(p.auth || p.envSet) && (
                      <span className={cn("chip shrink-0", badgeCls(p))}>
                        {status(p)}
                        {p.auth?.masked ? ` ${p.auth.masked}` : ""}
                      </span>
                    )}
                    <button
                      onClick={() => {
                        setExpanded(open ? null : p.id);
                        setKeyDraft("");
                      }}
                      className="h-7 shrink-0 cursor-pointer rounded-md border border-line px-2.5 text-[12px] text-muted t-fast hover:text-fg"
                    >
                      {open ? "收起" : p.auth ? "更换 Key" : "配置"}
                    </button>
                  </div>
                  {open && (
                    <div className="mt-2 rounded-lg bg-panel-2 p-2.5">
                      {p.oauthOnly || (p.auth && p.auth.type !== "api_key") ? (
                        <div className="flex flex-wrap items-center gap-2 text-[12px] leading-relaxed text-muted">
                          <ShieldCheck size={12} className="shrink-0 text-accent" />
                          <span>
                            已通过<strong className="text-fg">订阅账号</strong>授权登录
                            {p.auth?.masked ? `（${p.auth.masked}）` : ""}，凭据存在本机 auth.json。
                          </span>
                          <div className="ml-auto flex shrink-0 items-center gap-1.5">
                            <button onClick={() => onOpenSetup(p.id)} className="btn btn-sm btn-ghost">
                              <KeyRound size={10} /> 重新登录
                            </button>
                            {/* 有登录就要有登出：/api/auth/logout 此前无人消费 */}
                            <button
                              onClick={() => void oauthLogout(p)}
                              disabled={saving === p.id}
                              className="btn btn-sm btn-ghost text-danger"
                            >
                              {saving === p.id ? <Loader2 size={10} className="anim-spin" /> : <X size={10} />} 退出登录
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="flex gap-2">
                            <input
                              type="password"
                              value={keyDraft}
                              onChange={(e) => setKeyDraft(e.target.value)}
                              onKeyDown={(e) => e.key === "Enter" && saveKey(p)}
                              placeholder={p.env ? `粘贴 API Key（对应环境变量 ${p.env}）` : "粘贴 API Key"}
                              autoFocus
                              className="h-8 flex-1 rounded-md border border-line bg-panel px-2.5 font-mono text-[12px] text-fg outline-none focus:border-accent/50"
                            />
                            <button
                              onClick={() => saveKey(p)}
                              disabled={saving === p.id || !keyDraft.trim()}
                              className="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md bg-accent px-3 text-[12px] font-semibold text-accent-fg t-fast hover:bg-accent-hover disabled:opacity-50"
                            >
                              {saving === p.id ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} 保存
                            </button>
                            {p.auth && (
                              <button
                                onClick={() => removeKey(p)}
                                className="flex h-8 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-line px-2.5 text-[12px] text-danger t-fast hover:bg-danger/10"
                              >
                                <X size={12} /> 删除
                              </button>
                            )}
                          </div>
                          {p.note && <div className="mt-1.5 text-[11px] text-dim">{p.note}</div>}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {visible.length === 0 && (
              <div className="py-3 text-[12px] text-dim">
                {searching
                  ? "没有匹配的厂商"
                  : "还没有配置任何厂商 —— 在上方搜索厂商名添加，或点右上「接入模型」。"}
              </div>
            )}
          </div>
          {!searching && unconfiguredCount > 0 && (
            <div
              data-testid="provider-collapsed-note"
              className="border-t border-line-soft px-4 py-2 text-[11px] text-dim"
            >
              其余 {unconfiguredCount} 个未配置厂商已收起 —— 在上方搜索厂商名即可添加。
            </div>
          )}
        </>
      )}
    </Card>
  );
}

/* ---------------- 健康 · 近 14 天（模块 6 R3：故障一眼可见，最小改法提供「设为默认」） ---------------- */
type ModelHealthRow = {
  provider: string;
  model: string;
  key: string;
  calls: number;
  failures: number;
  recoveredFailures: number;
  successRate: number;
  status: "ok" | "unstable" | "failing";
  lastCallAt: string;
  lastFailureAt: string | null;
  lastError: string | null;
};

type ModelHealthReport = {
  at: string;
  windowDays: number;
  models: ModelHealthRow[];
  totalCalls: number;
  totalFailures: number;
};

const HEALTH_STATUS: Record<ModelHealthRow["status"], { label: string; chip: string; text: string }> = {
  ok: { label: "正常", chip: "chip-success", text: "text-fg" },
  unstable: { label: "不稳", chip: "chip-warn", text: "text-warn" },
  failing: { label: "有故障", chip: "chip-danger", text: "text-danger" },
};

function formatSuccessRate(rate: number): string {
  const pct = rate * 100;
  return pct >= 99.95 ? "100%" : `${pct.toFixed(1)}%`;
}

function ModelHealthSection({
  failingCount,
  onDefaultChanged,
}: {
  /** 状态条算好的「库内有故障的模型数」；这里只负责展示，不再自算一份（匹配口径见 lib/model-health-match.ts） */
  failingCount: number;
  /** 「设为默认」成功后回传 `provider/model`，让模型库行上的「默认」标记跟着走 */
  onDefaultChanged?: (ref: string) => void;
}) {
  const [report, setReport] = useState<ModelHealthReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  /** 常态折叠：健康数据已经下沉到模型行，这里退成一行摘要，点开才拉完整明细 */
  const [expanded, setExpanded] = useState(false);
  const [defaults, setDefaults] = useState<{ defaultProvider?: string; defaultModel?: string }>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [healthRes, settingsRes] = await Promise.all([
        fetch("/api/model-health", { cache: "no-store" }),
        fetch("/api/pi-settings", { cache: "no-store" }),
      ]);
      const health = (await healthRes.json().catch(() => null)) as ModelHealthReport | null;
      const settings = (await settingsRes.json().catch(() => null)) as
        | { settings?: { defaultProvider?: string; defaultModel?: string } }
        | null;
      setReport(health && Array.isArray(health.models) ? health : null);
      setDefaults(settings?.settings ?? {});
    } catch {
      setReport(null);
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, []);

  /* 折叠时不请求：完整明细只在展开的那一刻拉（服务端 60s 缓存，反复展开不重复扫盘） */
  useEffect(() => {
    if (expanded && !loaded && !loading) void load();
  }, [expanded, loaded, loading, load]);

  /** 走既有默认模型设置链（/api/pi-settings → settings.json 的 defaultProvider/defaultModel）
   *  服务端对 `status=failing` 的模型回 409（不静默接受）；这里弹一次确认后再带
   *  `confirmUnhealthy: true` 重试——「这个模型坏了」与「我要设为默认」之间要有反应。 */
  const setDefault = async (row: ModelHealthRow) => {
    setSavingKey(row.key);
    try {
      const put = (confirmUnhealthy: boolean) =>
        fetch("/api/pi-settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            defaultProvider: row.provider,
            defaultModel: row.model,
            ...(confirmUnhealthy ? { confirmUnhealthy: true } : {}),
          }),
        });
      let res = await put(false);
      if (res.status === 409) {
        const d = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
        if (d.code !== "unhealthy_model") throw new Error(d.error || `保存失败（HTTP ${res.status}）`);
        const ok = await dialogConfirm({
          title: "这个模型近期有故障",
          message: `把「${row.model}」设为启动默认后，所有新会话都会用它。\n${d.error ?? ""}\n\n确定继续吗？`,
          confirmText: "仍要设为默认",
          danger: true,
        });
        if (!ok) return;
        res = await put(true);
      }
      const d = (await res.json()) as {
        error?: string;
        settings?: { defaultProvider?: string; defaultModel?: string };
      };
      if (!res.ok) throw new Error(d.error || `保存失败（HTTP ${res.status}）`);
      setDefaults(d.settings ?? { defaultProvider: row.provider, defaultModel: row.model });
      onDefaultChanged?.(`${row.provider}/${row.model}`);
      toast(`已将 ${row.model} 设为启动默认，新会话生效`);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingKey(null);
    }
  };

  const models = report?.models ?? [];

  return (
    <Card testId="model-health">
      <CardHeader>
        <CardTitle>健康 · 近 14 天</CardTitle>
        <span className="text-[11px] text-dim">
          来源：本机会话记录（~/.pi/agent/sessions） · 60 秒缓存
          {failingCount > 0 ? ` · ${failingCount} 个模型有故障` : ""}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {expanded && (
            <button onClick={() => void load()} disabled={loading} className="btn btn-sm btn-ghost">
              {loading ? <Loader2 size={12} className="anim-spin" /> : <RefreshCw size={12} />} 刷新
            </button>
          )}
          <button
            onClick={() => setExpanded((v) => !v)}
            data-testid="model-health-toggle"
            aria-expanded={expanded}
            className="btn btn-sm btn-ghost"
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {expanded ? "收起明细" : "展开明细"}
          </button>
        </div>
      </CardHeader>

      {/* 健康数据的常住处是**模型行右侧那颗故障标**，这里只留一行说明；
          完整明细（含「设为默认」）点开才看，它才不再霸占半屏。 */}
      {!expanded && (
        <div className="px-4 py-2.5 text-[12px] leading-relaxed text-dim">
          故障已标在对应模型行 · 展开看完整明细（成功率 / 失败次数 / 最近错误）
        </div>
      )}

      {expanded && (
        <div data-testid="model-health-detail">
      {loading && (
        <div aria-busy="true" aria-label="加载模型健康度" className="flex flex-col">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 border-t border-line-soft px-4 py-2.5 first:border-t-0">
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Skeleton className="h-3.5 w-1/3" />
                <Skeleton className="h-2.5 w-1/2" />
              </div>
              <Skeleton className="h-4 w-10 shrink-0" />
              <Skeleton className="h-5 w-14 shrink-0 rounded-sm" />
            </div>
          ))}
        </div>
      )}

      {!loading && models.length === 0 && (
        <div className="px-4 py-6 text-center text-[12px] leading-relaxed text-dim">
          近 14 天没有模型调用记录。聊过天后，这里会按模型显示成功率、失败次数与最近失败时刻。
        </div>
      )}

      {!loading &&
        models.map((m) => {
          const status = HEALTH_STATUS[m.status];
          const isDefault = defaults.defaultProvider === m.provider && defaults.defaultModel === m.model;
          return (
            <div
              key={m.key}
              data-testid="model-health-row"
              className="flex items-center gap-3 border-t border-line-soft px-4 py-2.5 first:border-t-0"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium text-fg">{m.model}</span>
                  <span className="truncate font-mono text-[11px] text-dim">{m.provider}</span>
                </div>
                <div className="mt-0.5 truncate text-[11px] text-dim">
                  {m.calls} 次调用 · 失败 {m.failures}
                  {m.recoveredFailures > 0 ? `（自动重试接管 ${m.recoveredFailures}）` : ""}
                  {m.lastFailureAt ? ` · 最近失败 ${relTime(m.lastFailureAt)}` : ""}
                </div>
                {m.lastError && (
                  <div className="mt-0.5 truncate text-[11px] text-dim/80" title={m.lastError}>
                    {m.lastError}
                  </div>
                )}
              </div>
              <span className={cn("shrink-0 text-[14px] font-semibold tabular-nums", status.text)}>
                {formatSuccessRate(m.successRate)}
              </span>
              <span className={cn("chip shrink-0", status.chip)}>{status.label}</span>
              {isDefault ? (
                <span className="chip chip-accent shrink-0">默认</span>
              ) : (
                <button
                  onClick={() => void setDefault(m)}
                  disabled={savingKey !== null}
                  title="写入 settings.json 的 defaultProvider/defaultModel，新会话生效"
                  className="btn btn-sm btn-ghost shrink-0"
                >
                  {savingKey === m.key ? <Loader2 size={12} className="anim-spin" /> : <Star size={12} />} 设为默认
                </button>
              )}
            </div>
          );
        })}

      <div className="border-t border-line-soft px-4 py-2 text-[11px] leading-relaxed text-dim">
        成功率 =（调用数 − 失败数）/ 调用数；失败取会话里 assistant 响应 stopReason=error 的次数。
        同一轮自动重试会在记录里各计一次（被重试接管的失败已单独标注）；用户主动中断不计入。
        未列延迟：会话记录里没有可归因到 provider 的耗时字段，宁缺勿假。
      </div>
        </div>
      )}
    </Card>
  );
}

/* ---------------- 顶部状态条（变体 C 新增）：先回答「跑的是什么 / 选了多少 / 坏没坏」 ---------------- */

/** 首帧占位：真值由模型库汇报上来（只此一处取数，见 ModelScopeSummary 的注释） */
const EMPTY_SCOPE_SUMMARY: ModelScopeSummary = {
  loading: true,
  error: null,
  total: 0,
  selected: 0,
  scoped: false,
  failing: 0,
  defaultRef: null,
};

function ModelStatusBar({
  summary,
  failingOnly,
  onToggleFailingOnly,
}: {
  summary: ModelScopeSummary;
  failingOnly: boolean;
  onToggleFailingOnly: () => void;
}) {
  const pending = summary.loading && summary.total === 0;
  /* 只显示模型名（provider 在故障标 / 展开面板里可见），状态条要的是一眼可读 */
  const defaultId = summary.defaultRef ? summary.defaultRef.slice(summary.defaultRef.indexOf("/") + 1) : "";
  return (
    <section
      data-testid="model-status-bar"
      className="rounded-card border border-line bg-panel px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-muted">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 text-dim">默认</span>
          {defaultId ? (
            <span className="truncate font-mono text-[12px] text-fg" title={summary.defaultRef ?? defaultId}>
              {defaultId}
            </span>
          ) : (
            <span className="text-dim">{pending ? "读取中…" : "自动选择"}</span>
          )}
        </span>
        <span className="flex items-baseline gap-1.5">
          <span className="text-dim">已选模型</span>
          {pending ? (
            <span className="text-dim">读取中…</span>
          ) : (
            <span className="tabular-nums text-fg">
              {summary.selected}
              <span className="text-dim"> / {summary.total}</span>
            </span>
          )}
        </span>
        {summary.failing > 0 ? (
          <span className="flex items-center gap-2">
            <button
              type="button"
              onClick={onToggleFailingOnly}
              aria-pressed={failingOnly}
              data-testid="status-failing-toggle"
              title={failingOnly ? "再点一次回到全部模型" : "只看有故障的模型（库内匹配得上的）"}
              className={cn(
                "chip chip-danger cursor-pointer t-fast hover:bg-danger/15",
                failingOnly && "border-danger/60",
              )}
            >
              有故障 {summary.failing} 个{failingOnly ? " · 只看这些" : ""}
            </button>
            <span className="text-[11px] text-dim">已标在对应模型行</span>
          </span>
        ) : (
          !pending && <span className="text-[12px] text-dim">近 14 天没有故障模型</span>
        )}
        {summary.error && <span className="text-[12px] text-danger">模型库加载失败：{summary.error}</span>}
      </div>
    </section>
  );
}


export function ModelsPage() {
  const [config, setConfig] = useState<Record<string, ProviderConfig>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  /* 模型库汇报上来的选型侧摘要（状态条用；不再向 /api/models 要第二遍） */
  const [library, setLibrary] = useState<ModelScopeSummary>(EMPTY_SCOPE_SUMMARY);
  /* 状态条「有故障 N 个」点开：模型库只看有故障的行 */
  const [failingOnly, setFailingOnly] = useState(false);
  /* 两张高级卡常态折成一行（变体 C：高级用法不该与日常操作同级） */
  const [customOpen, setCustomOpen] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  /* 健康面板里改过启动默认时，同步模型库行上的「默认」标记 */
  const [defaultRefOverride, setDefaultRefOverride] = useState<string | null>(null);

  // catalog 搜索
  const [catQuery, setCatQuery] = useState("");
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [catSearching, setCatSearching] = useState(false);
  /* 「接入模型」向导（选厂商 → 凭据 → 默认模型），对应 pi CLI 的 /login */
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupProvider, setSetupProvider] = useState<string | undefined>(undefined);
  /* 自定义 Provider：拉取网关实际可用的模型（/api/models-config/discover） */
  const [discovering, setDiscovering] = useState<string | null>(null);
  const [discovered, setDiscovered] = useState<
    Record<string, { models: { id: string; name?: string }[]; endpoint: string } | undefined>
  >({});
  const [discoverError, setDiscoverError] = useState<Record<string, string | undefined>>({});

  // 测试
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; msg: string }>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetch("/api/models-config", { cache: "no-store" }).then((r) => r.json());
      setConfig(data.providers ?? {});
    } catch {
      setConfig({});
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async (providers: Record<string, ProviderConfig>) => {
    setSaving(true);
    setSavedMsg(null);
    try {
      const res = await fetch("/api/models-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...config, providers }),
      });
      if (res.ok) {
        setConfig(providers);
        setSavedMsg("已保存");
        setTimeout(() => setSavedMsg(null), 2000);
      } else {
        setSavedMsg("保存失败");
      }
    } finally {
      setSaving(false);
    }
  };

  const updateProvider = (name: string, patch: Partial<ProviderConfig>) => {
    setConfig((prev) => ({ ...prev, [name]: { ...prev[name], ...patch } }));
  };

  /** 拉取自定义 Provider 网关的模型清单（先用当前编辑中的值，未保存也能试） */
  const discoverModels = async (name: string, provider: ProviderConfig) => {
    setDiscovering(name);
    setDiscoverError((prev) => ({ ...prev, [name]: undefined }));
    try {
      const res = await fetch("/api/models-config/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerName: name, provider }),
      });
      const d = (await res.json()) as {
        models?: { id: string; name?: string }[];
        endpoint?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(d.error || `拉取失败（HTTP ${res.status}）`);
      setDiscovered((prev) => ({ ...prev, [name]: { models: d.models ?? [], endpoint: d.endpoint ?? "" } }));
    } catch (e) {
      setDiscoverError((prev) => ({ ...prev, [name]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setDiscovering(null);
    }
  };

  const searchCatalog = async () => {
    const q = catQuery.trim();
    if (!q) return;
    setCatSearching(true);
    try {
      const data = await fetch(`/api/models-config/catalog?q=${encodeURIComponent(q)}`, { cache: "no-store" }).then((r) => r.json());
      setCatalog(data.entries ?? []);
    } catch {
      setCatalog([]);
    } finally {
      setCatSearching(false);
    }
  };

  const addFromCatalog = async (entry: CatalogEntry) => {
    const provider = entry.provider || entry.providerName || "custom";
    const name = await dialogPrompt({
      title: `保存 Provider（模型 ${entry.id}）`,
      message: "为这个 Provider 取一个名称，保存后可配置 Base URL 与 API Key。",
      defaultValue: provider,
      select: true,
      confirmText: "保存",
      placeholder: "provider 名称",
    });
    if (!name) return;
    const providers = { ...config, [name]: { ...config[name], baseUrl: config[name]?.baseUrl ?? "" } };
    setConfig(providers);
    await save(providers);
    setEditing(name);
    setCatalog(null);
    setCatQuery("");
  };

  const testProvider = async (name: string, p: ProviderConfig) => {
    setTesting(name);
    try {
      const res = await fetch("/api/models-config/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerName: name,
          provider: { baseUrl: p.baseUrl, apiKey: p.apiKey },
          model: { id: (p.models as { id: string }[] | undefined)?.[0]?.id ?? "default" },
        }),
      });
      const data = await res.json();
      setTestResult((prev) => ({
        ...prev,
        [name]: { ok: Boolean(data.ok), msg: data.ok ? data.response || "连接成功" : data.error || "连接失败" },
      }));
    } catch (e) {
      setTestResult((prev) => ({ ...prev, [name]: { ok: false, msg: String(e) } }));
    } finally {
      setTesting(null);
    }
  };

  const providerNames = Object.keys(config);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="page-col py-6">
        {/* 状态条（变体 C 新增）：先回答「跑的是什么 / 选了多少 / 坏没坏」，再往下才是可操作项 */}
        <div className="mb-5">
          <ModelStatusBar
            summary={library}
            failingOnly={failingOnly}
            onToggleFailingOnly={() => setFailingOnly((v) => !v)}
          />
        </div>

        <PageHeader
          icon={<Cpu size={16} />}
          title="模型"
          subtitle="管理模型 Provider、API Key 与连接"
          actions={
            <button onClick={() => setSetupOpen(true)} data-testid="open-setup" className="btn btn-primary">
              <KeyRound size={12} /> 接入模型
            </button>
          }
        />

        {/* 纵向单列：凭据在上 → 模型库在下 → 故障标回到模型行（变体 C）。
            原先的双列 grid 让 ProviderAuthSection 被同行拉伸（524px），也把两张
            高级小卡叠在右列，一列 1000px+、一列 200px、底部差出成片空白。
            grid-cols-1 是显式留痕：布局口径要能被 getComputedStyle 断言（一列 = 全宽）。 */}
        <div data-testid="models-page-stack" className="grid grid-cols-1 gap-5">
          <ProviderAuthSection onOpenSetup={(id) => { setSetupProvider(id); setSetupOpen(true); }} />

          <ModelScopeEditor
            onlyFailing={failingOnly}
            onSummary={setLibrary}
            defaultRefOverride={defaultRefOverride}
          />

        {/* 已配置 providers（models.json 自定义 Provider，高级用法）：常态折成一行 */}
        <Card testId="custom-provider-advanced">
          <CardHeader>
            <CardTitle>自定义 Provider（高级）</CardTitle>
            <span className="text-[11px] text-dim">写入 models.json，用于中转站 / 自建网关</span>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <span className="text-[11px] text-dim">{providerNames.length} 个</span>
              {savedMsg && (
                <span className={cn("text-[12px]", savedMsg === "已保存" ? "text-success" : "text-danger")}>
                  {savedMsg}
                </span>
              )}
              <button
                onClick={() => setCustomOpen((v) => !v)}
                data-testid="custom-provider-toggle"
                aria-expanded={customOpen}
                className="btn btn-sm btn-ghost"
              >
                {customOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                {customOpen ? "收起" : "展开"}
              </button>
            </div>
          </CardHeader>
          {!customOpen ? (
            <div data-testid="custom-provider-collapsed" className="px-4 py-2.5 text-[12px] leading-relaxed text-dim">
              高级用法，需要时展开 —— 开箱即用的厂商直接在上方「厂商与密钥」贴 Key 即可。
            </div>
          ) : (
            <>
          {loading && (
            <div aria-busy="true" aria-label="加载配置" className="flex flex-col">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="border-t border-line-soft px-4 py-3 first:border-t-0">
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-3.5 w-28 shrink-0" />
                    <Skeleton className="h-3 w-40 shrink-0" />
                    <Skeleton className="ml-auto h-7 w-24 shrink-0 rounded-md" />
                  </div>
                </div>
              ))}
            </div>
          )}
          {!loading && providerNames.length === 0 && (
            <div className="px-4 py-4 text-[12px] text-dim">暂无自定义 Provider。绝大多数场景不需要这里 —— 上方选厂商、贴 Key 即可。</div>
          )}
          {providerNames.map((name) => {
            const p = config[name];
            const isEditing = editing === name;
            return (
              <div key={name} className="border-t border-line-soft px-4 py-3 first:border-t-0">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-semibold text-fg">{name}</span>
                  <span className="truncate font-mono text-[11px] text-dim">{p.baseUrl || "未设置 baseUrl"}</span>
                  <div className="ml-auto flex items-center gap-1.5">
                    <button
                      onClick={() => testProvider(name, p)}
                      disabled={testing !== null}
                      className="flex h-7 cursor-pointer items-center gap-1 rounded-md border border-line px-2.5 text-[12px] text-muted t-fast hover:text-fg disabled:opacity-50"
                    >
                      {testing === name ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                      测试
                    </button>
                    <button
                      onClick={() => setEditing(isEditing ? null : name)}
                      className="flex h-7 cursor-pointer items-center gap-1 rounded-md border border-line px-2.5 text-[12px] text-muted t-fast hover:text-fg"
                    >
                      {isEditing ? "收起" : "编辑"}
                    </button>
                    <button
                      onClick={async () => {
                        const ok = await dialogConfirm({
                          title: "删除 Provider",
                          message: `确定删除「${name}」的配置？此操作不可撤销。`,
                          confirmText: "删除",
                          danger: true,
                        });
                        if (!ok) return;
                        const next = { ...config };
                        delete next[name];
                        save(next);
                      }}
                      className="flex h-7 cursor-pointer items-center gap-1 rounded-md border border-line px-2.5 text-[12px] text-danger t-fast hover:bg-danger/10"
                    >
                      <X size={12} /> 删除
                    </button>
                  </div>
                </div>
                {testResult[name] && (
                  <div
                    className={cn(
                      "mt-1.5 rounded-md px-2.5 py-1 text-[12px]",
                      testResult[name].ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger",
                    )}
                  >
                    {testResult[name].msg}
                  </div>
                )}
                {isEditing && (
                  <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <label className="block">
                      <span className="mb-1 block text-[11px] text-dim">Base URL</span>
                      <input
                        value={p.baseUrl ?? ""}
                        onChange={(e) => updateProvider(name, { baseUrl: e.target.value })}
                        placeholder="https://api.example.com/v1"
                        className="h-8 w-full rounded-md border border-line bg-panel-2 px-2.5 font-mono text-[12px] text-fg outline-none focus:border-accent/50"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-[11px] text-dim">API Key</span>
                      <input
                        type="password"
                        value={p.apiKey ?? ""}
                        onChange={(e) => updateProvider(name, { apiKey: e.target.value })}
                        placeholder="sk-…"
                        className="h-8 w-full rounded-md border border-line bg-panel-2 px-2.5 font-mono text-[12px] text-fg outline-none focus:border-accent/50"
                      />
                    </label>
                    <button
                      onClick={() => save(config)}
                      disabled={saving}
                      className="flex h-8 w-fit cursor-pointer items-center gap-1.5 rounded-md bg-accent px-3 text-[12px] font-semibold text-accent-fg t-fast hover:bg-accent-hover disabled:opacity-50"
                    >
                      {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                      保存配置
                    </button>
                    {/* 用填好的 Base URL + Key 去网关自己的 /models 端点拉列表 ——
                        自定义网关（中转站/自建）的模型 ID 无从得知，不接这个只能靠猜 */}
                    <button
                      onClick={() => void discoverModels(name, p)}
                      disabled={discovering === name}
                      title="请求该网关的 /models 端点，列出实际可用的模型"
                      className="flex h-8 w-fit cursor-pointer items-center gap-1.5 rounded-md border border-line px-3 text-[12px] text-muted t-fast hover:text-fg disabled:opacity-50"
                    >
                      {discovering === name ? (
                        <Loader2 size={12} className="anim-spin" />
                      ) : (
                        <Download size={12} />
                      )}
                      拉取可用模型
                    </button>
                  </div>
                )}
                {discovered[name] && (
                  <div className="mt-2 rounded-lg border border-line bg-panel-2 p-2.5">
                    <div className="flex items-center gap-2 text-[11px] text-dim">
                      <span>发现 {discovered[name].models.length} 个模型</span>
                      <span className="truncate font-mono text-[10px] text-dim/70">{discovered[name].endpoint}</span>
                      <button
                        onClick={() => setDiscovered((prev) => ({ ...prev, [name]: undefined as never }))}
                        className="btn btn-sm btn-subtle ml-auto"
                      >
                        关闭
                      </button>
                    </div>
                    <div className="mt-1.5 flex max-h-40 flex-wrap gap-1 overflow-y-auto">
                      {discovered[name].models.map((m) => (
                        <span key={m.id} className="chip chip-mono">
                          {m.id}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {discoverError[name] && (
                  <div className="mt-1.5 rounded-md bg-danger/10 px-2.5 py-1 text-[12px] text-danger">
                    {discoverError[name]}
                  </div>
                )}
              </div>
            );
          })}
            </>
          )}
        </Card>

        {/* 从目录添加（自定义 Provider 的高级用法）：同样折成一行 */}
        <Card testId="catalog-advanced">
          <CardHeader>
            <CardTitle>从模型目录添加（高级）</CardTitle>
            <span className="text-[11px] text-dim">models.dev 目录 · 目录外的厂商 / 模型</span>
            <button
              onClick={() => setCatalogOpen((v) => !v)}
              data-testid="catalog-toggle"
              aria-expanded={catalogOpen}
              className="btn btn-sm btn-ghost ml-auto"
            >
              {catalogOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              {catalogOpen ? "收起" : "展开"}
            </button>
          </CardHeader>
          {!catalogOpen ? (
            <div data-testid="catalog-collapsed" className="px-4 py-2.5 text-[12px] text-dim">
              高级用法，需要时展开。
            </div>
          ) : (
          <div className="p-4">
          <div className="flex gap-2">
            <input
              value={catQuery}
              onChange={(e) => setCatQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && searchCatalog()}
              placeholder="搜索 provider 或模型，如 deepseek、claude…"
              className="h-8 flex-1 rounded-md border border-line bg-panel-2 px-2.5 text-[12px] text-fg outline-none focus:border-accent/50"
            />
            <button
              onClick={searchCatalog}
              disabled={catSearching || !catQuery.trim()}
              className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md bg-accent px-3 text-[12px] font-semibold text-accent-fg t-fast hover:bg-accent-hover disabled:opacity-50"
            >
              {catSearching ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              搜索
            </button>
          </div>
          {catalog && (
            <div className="mt-3 max-h-56 overflow-y-auto">
              {catalog.length === 0 && <div className="py-2 text-[12px] text-dim">没有匹配结果</div>}
              {catalog.map((e, i) => (
                <button
                  key={`${e.provider}-${e.id}-${i}`}
                  onClick={() => addFromCatalog(e)}
                  className="flex w-full cursor-pointer items-center gap-2 border-t border-line-soft px-1 py-1.5 text-left t-fast first:border-t-0 hover:bg-hover"
                >
                  <span className="text-[12px] font-medium text-fg">{e.name || e.id}</span>
                  <span className="truncate font-mono text-[11px] text-dim">
                    {e.provider || e.providerName} / {e.id}
                  </span>
                  <span className="ml-auto shrink-0 text-[11px] text-accent">添加</span>
                </button>
              ))}
            </div>
          )}
            </div>
          )}
        </Card>

          {/* 健康明细：数据本体已下沉到模型行（见 ModelScopeEditor 的故障标），
              这里只剩一行摘要 + 可展开的完整面板 */}
          <ModelHealthSection
            failingCount={library.failing}
            onDefaultChanged={(ref) => setDefaultRefOverride(ref)}
          />
        </div>
      </div>

      <ModelSetupDialog
        open={setupOpen}
        initialProviderId={setupProvider}
        onClose={() => {
          setSetupOpen(false);
          setSetupProvider(undefined);
        }}
        reason="选择厂商 → 填入凭据（API Key 或订阅登录）→ 挑选默认模型"
      />
    </div>
  );
}
