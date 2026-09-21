"use client";

import { Check, Cpu, Download, KeyRound, Loader2, RefreshCw, Save, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "@/components/lib/utils";
import { dialogConfirm, dialogPrompt, toast } from "@/components/ui/dialog";
import { EmptyState, PageHeader } from "@/components/ui/bits";
import { ModelScopeEditor } from "@/components/ModelScopeEditor";
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
  const filtered = query.trim()
    ? sorted.filter((p) => `${p.id} ${p.label}`.toLowerCase().includes(query.trim().toLowerCase()))
    : sorted;
  const configuredCount = providers.filter((p) => p.auth || p.envSet).length;

  const badgeCls = (p: ProviderAuthStatus) =>
    p.auth ? "chip-success" : p.envSet ? "chip-accent" : "";

  return (
    <div className="rounded-card border border-line bg-panel" data-testid="provider-auth">
      <div className="flex items-center gap-2 border-b border-line-soft px-4 py-3">
        <span className="text-[13px] font-semibold text-fg">厂商与密钥</span>
        <span className="text-[12px] text-dim">
          内置 {providers.length} 个厂商 · 已配置 {configuredCount} 个 · 存放于 ~/.pi/agent/auth.json
        </span>
      </div>
      {loading ? (
        <div className="flex items-center gap-2 px-4 py-5 text-[12px] text-dim">
          <Loader2 size={14} className="animate-spin" /> 加载厂商目录…
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
          <div className="max-h-[26rem] overflow-y-auto px-4 py-3">
            {filtered.map((p) => {
              const open = expanded === p.id;
              return (
                <div key={p.id} className="border-t border-line-soft py-2 first:border-t-0 first:pt-0">
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
                      <span className="chip shrink-0">{p.modelCount} 模型</span>
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
            {filtered.length === 0 && <div className="py-3 text-[12px] text-dim">没有匹配的厂商</div>}
          </div>
        </>
      )}
    </div>
  );
}


export function ModelsPage() {
  const [config, setConfig] = useState<Record<string, ProviderConfig>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

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

        {/* 四张卡按行对齐（grid 同行等高）。
            原先是「左列 2 张 + 右列 2 张」各自成栈：两张高级小卡叠在右列，
            一列 1000px+、一列 200px，底部差出成片空白；行对齐后右列不再短一截。 */}
        <div className="grid gap-5 xl:grid-cols-2">
          <ProviderAuthSection onOpenSetup={(id) => { setSetupProvider(id); setSetupOpen(true); }} />

          <ModelScopeEditor />

        {/* 已配置 providers（models.json 自定义 Provider，高级用法） */}
        <div className="rounded-card border border-line bg-panel">
          <div className="flex items-center gap-2 border-b border-line-soft px-4 py-3">
            <span className="text-[13px] font-semibold text-fg">自定义 Provider（高级）</span>
            <span className="text-[11px] text-dim">写入 models.json，用于中转站 / 自建网关；开箱即用的厂商直接在上方「厂商与密钥」输入 Key 即可</span>
            <span className="ml-auto shrink-0 text-[11px] text-dim">{providerNames.length} 个</span>
            {savedMsg && (
              <span className={cn("ml-auto text-[12px]", savedMsg === "已保存" ? "text-success" : "text-danger")}>
                {savedMsg}
              </span>
            )}
          </div>
          {loading && (
            <div className="flex items-center gap-2 px-4 py-5 text-[12px] text-dim">
              <Loader2 size={14} className="animate-spin" /> 加载配置…
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
        </div>

        {/* 从目录添加（自定义 Provider 的高级用法） */}
        <div className="rounded-card border border-line bg-panel p-4">
          <div className="mb-2 text-[12px] font-semibold text-fg">从模型目录添加（models.dev · 高级）</div>
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
                  <span className="ml-auto shrink-0 text-[11px] text-accent">添加 →</span>
                </button>
              ))}
            </div>
          )}
          </div>
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
