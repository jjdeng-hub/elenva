"use client";

import { ChevronRight, Download, Loader2, Package, Plug, RefreshCw, Search, Server, ShieldCheck, Sparkles, Star, Trash2 } from "lucide-react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/components/lib/utils";
import { PageHeader } from "@/components/ui/bits";
import { dialogConfirm, toast } from "@/components/ui/dialog";

type PluginPackage = {
  source: string;
  scope: string;
  disabled: boolean;
  status: string;
  version?: string;
  packageName?: string;
  canCheckForUpdates?: boolean;
  counts: { extensions: number; skills: number; prompts: number; themes: number };
};

/** /api/mcp-servers 返回项（~/.pi/agent/mcp.json 里的服务器） */
type McpServer = {
  name: string;
  description?: string;
  enabled: boolean;
  transport: "stdio" | "http";
  target: string;
};

/** /api/package-catalog 返回项（npm registry 搜索） */
type CatalogItem = {
  name: string;
  /** npm 月下载量（主排序依据） */
  downloads?: number;
  /** GitHub star，取不到就没有这个字段 */
  stars?: number;
  repository?: string;
  version?: string;
  description?: string;
  date?: string;
  keywords?: string[];
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 下载量 / star 的紧凑写法：12.3k、1.2M —— 比原始数字好扫读 */
function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

/** 「3 天前更新」—— 维护活跃度比绝对日期好判断 */
function relativeDays(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (!Number.isFinite(days) || days < 0) return "";
  if (days === 0) return "今天更新";
  if (days === 1) return "昨天更新";
  if (days < 30) return `${days} 天前更新`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前更新`;
  return `${Math.floor(days / 365)} 年前更新`;
}

/** 官方文档给的是整条命令（如 `pi install npm:foo`）；这里剥掉命令前缀与包裹引号，只留 source */
const normalizeSource = (raw: string) =>
  raw
    .trim()
    .replace(/^pi\s+(?:install|remove)\s+/i, "")
    .replace(/^["']+|["']+$/g, "")
    .trim();

/** 布尔开关（与设置页同款交互；本页自持一份，避免跨页耦合） */
function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      onClick={() => onChange(!on)}
      disabled={disabled}
      aria-pressed={on}
      className={cn(
        "relative h-5 w-9 shrink-0 cursor-pointer rounded-full t-fast disabled:opacity-50",
        on ? "bg-accent" : "bg-line",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 size-4 rounded-full bg-white shadow-sm transition-all",
          on ? "left-[18px]" : "left-0.5",
        )}
      />
    </button>
  );
}

export function PluginsPage({ defaultCwd }: { defaultCwd: string | null }) {
  const [packages, setPackages] = useState<PluginPackage[]>([]);
  const [loading, setLoading] = useState(true);
  /** 正在进行的列表操作：`act:<source>` / `remove:<source>` / `check:<source>` */
  const [busy, setBusy] = useState<string | null>(null);
  const [updateMsg, setUpdateMsg] = useState<Record<string, string>>({});
  const [installSource, setInstallSource] = useState("");
  const [installingSource, setInstallingSource] = useState<string | null>(null);

  /** MCP 服务器（~/.pi/agent/mcp.json；内核在会话启动时连接） */
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [mcpLoading, setMcpLoading] = useState(true);
  const [mcpBusy, setMcpBusy] = useState<string | null>(null);
  const [mcpNote, setMcpNote] = useState<string | null>(null);
  /** MCP 写操作确认开关（护栏设置，与审批档位独立） */
  const [mcpWriteApproval, setMcpWriteApproval] = useState(true);
  const [mcpWriteBusy, setMcpWriteBusy] = useState(false);

  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalog, setCatalog] = useState<CatalogItem[] | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const catalogLoadedOnce = useRef(false);

  const load = useCallback(async () => {
    if (!defaultCwd) {
      setPackages([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const data = await fetch(`/api/plugins?cwd=${encodeURIComponent(defaultCwd)}`, { cache: "no-store" }).then((r) => r.json());
      setPackages(data.packages ?? []);
    } catch {
      setPackages([]);
    } finally {
      setLoading(false);
    }
  }, [defaultCwd]);

  useEffect(() => {
    load();
  }, [load]);

  const loadMcp = useCallback(async () => {
    setMcpLoading(true);
    try {
      const [serversData, guardData] = await Promise.all([
        fetch("/api/mcp-servers", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/guardrails", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
      ]);
      const data = serversData as { servers?: McpServer[]; error?: string };
      setMcpServers(data.servers ?? []);
      setMcpNote(data.error ?? null);
      const guard = guardData as { mcpWriteApproval?: boolean } | null;
      if (guard && typeof guard.mcpWriteApproval === "boolean") setMcpWriteApproval(guard.mcpWriteApproval);
    } catch {
      setMcpServers([]);
    } finally {
      setMcpLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMcp();
  }, [loadMcp]);

  const setMcpWriteApprovalSetting = async (next: boolean) => {
    setMcpWriteBusy(true);
    try {
      const res = await fetch("/api/guardrails", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "setMcpWriteApproval", enabled: next }),
      });
      const data = (await res.json().catch(() => ({}))) as { mcpWriteApproval?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setMcpWriteApproval(data.mcpWriteApproval !== false);
      toast(next ? "已开启：MCP 写操作需确认" : "已关闭：MCP 写操作不再确认");
    } catch (e) {
      toast(`操作失败：${errText(e)}`, 6000);
    } finally {
      setMcpWriteBusy(false);
    }
  };

  const setMcpEnabled = async (server: McpServer, enabled: boolean) => {
    setMcpBusy(server.name);
    try {
      const res = await fetch("/api/mcp-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "setEnabled", name: server.name, enabled }),
      });
      const data = (await res.json().catch(() => ({}))) as { servers?: McpServer[]; error?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (Array.isArray(data.servers)) setMcpServers(data.servers);
      toast(enabled ? `已启用 ${server.name} · 新会话生效` : `已停用 ${server.name} · 新会话生效`);
    } catch (e) {
      toast(`操作失败：${errText(e)}`, 6000);
    } finally {
      setMcpBusy(null);
    }
  };

  /**
   * 统一的 POST 封装：cwd 必填（API 会校验）、读后端的 error 字段、用返回的列表直接刷新。
   * 此前 enable/disable 漏传 cwd，服务端一律 400 且前端不检查 res.ok，表现为「点了没反应」。
   */
  const post = useCallback(
    async (body: Record<string, unknown>) => {
      const res = await fetch("/api/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: defaultCwd, ...body }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; packages?: PluginPackage[] };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (Array.isArray(data.packages)) setPackages(data.packages);
      return data;
    },
    [defaultCwd],
  );

  const action = async (pkg: PluginPackage, act: "enable" | "disable") => {
    if (!defaultCwd) return;
    setBusy(`act:${pkg.source}`);
    try {
      await post({ action: act, source: pkg.source, scope: pkg.scope });
    } catch (e) {
      toast(`${act === "enable" ? "启用" : "禁用"}失败：${errText(e)}`, 6000);
    } finally {
      setBusy(null);
    }
  };

  /** 安装统一入口：手动输入与目录安装共用（都走二次确认） */
  const runInstall = async (rawSource: string, clearInput = false) => {
    const source = normalizeSource(rawSource);
    if (!source || !defaultCwd || installingSource) return;
    const ok = await dialogConfirm({
      title: "安装插件",
      message: `即将安装 ${source}。插件可以携带可执行扩展，请确认来源可信。`,
      confirmText: "安装",
    });
    if (!ok) return;
    setInstallingSource(source);
    try {
      await post({ action: "install", source });
      if (clearInput) setInstallSource("");
      // 扩展是在会话启动时绑定并缓存工具清单的，所以老会话不会自动看到新插件。
      // 内核的 reload 会用 includeAllExtensionTools 重新绑定（实测有效），/reload 比新建会话省事。
      toast("安装完成 · 新会话生效，或在当前会话执行 /reload 立即生效", 5000);
    } catch (e) {
      toast(`安装失败：${errText(e)}`, 8000);
    } finally {
      setInstallingSource(null);
    }
  };

  const remove = async (pkg: PluginPackage) => {
    if (!defaultCwd) return;
    const ok = await dialogConfirm({
      title: "移除插件",
      message: `将移除 ${pkg.packageName || pkg.source}，其扩展与技能不再加载。`,
      confirmText: "移除",
      danger: true,
    });
    if (!ok) return;
    setBusy(`remove:${pkg.source}`);
    try {
      await post({ action: "remove", source: pkg.source, scope: pkg.scope });
      toast("已移除");
    } catch (e) {
      toast(`移除失败：${errText(e)}`, 8000);
    } finally {
      setBusy(null);
    }
  };

  const checkUpdate = async (pkg: PluginPackage) => {
    if (!defaultCwd) return;
    const key = `${pkg.scope}-${pkg.source}`;
    setBusy(`check:${pkg.source}`);
    try {
      const res = await fetch("/api/plugins/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: defaultCwd, source: pkg.source, scope: pkg.scope }),
      });
      const d = await res.json();
      const result = Array.isArray(d.results) ? d.results[0] : d;
      const state = result?.state;
      setUpdateMsg((p) => ({
        ...p,
        [key]:
          state === "update-available"
            ? "有可用更新，可通过包管理器更新"
            : state === "up-to-date"
              ? "已是最新"
              : result?.message || "无法检查",
      }));
    } catch {
      setUpdateMsg((p) => ({ ...p, [key]: "检查失败" }));
    } finally {
      setBusy(null);
    }
  };

  const searchCatalog = useCallback(async (rawQuery?: string) => {
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      const q = (rawQuery ?? "").trim();
      const res = await fetch(`/api/package-catalog?q=${encodeURIComponent(q)}&limit=30`, { cache: "no-store" });
      const d = (await res.json().catch(() => ({}))) as { error?: string; results?: CatalogItem[] };
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      setCatalog(Array.isArray(d.results) ? d.results : []);
    } catch (e) {
      setCatalogError(`加载失败：${errText(e)}`);
      setCatalog(null);
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  const runCatalogSearch = () => searchCatalog(catalogQuery);

  // 首次进入自动拉一次目录，让「发现」是主动呈现而不是等用户搜
  useEffect(() => {
    if (!defaultCwd || catalogLoadedOnce.current) return;
    catalogLoadedOnce.current = true;
    searchCatalog("");
  }, [defaultCwd, searchCatalog]);

  const isInstalled = (name: string) => packages.some((p) => p.packageName === name || p.source === `npm:${name}`);

  /** 任一操作进行中：禁用其余按钮，避免并发改动同一个包列表 */
  const anyBusy = busy !== null || installingSource !== null;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="page-col py-6">
        <PageHeader icon={<Plug size={16} />} title="插件" subtitle="安装 Pi 包，扩展能力、技能、命令与主题" />

        {/* 安装栏 */}
        <Card className="mb-4 p-4">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-[13px] font-semibold text-fg">安装插件</span>
            <span className="text-[11px] text-dim">从 npm、Git 仓库或本地路径安装</span>
          </div>
          <div className="mt-2.5 flex items-center gap-2">
            <input
              value={installSource}
              onChange={(e) => setInstallSource(e.target.value)}
              onPaste={(e) => {
                const raw = e.clipboardData.getData("text");
                const cleaned = normalizeSource(raw);
                if (cleaned && cleaned !== raw.trim()) {
                  e.preventDefault();
                  setInstallSource(cleaned);
                  toast("已去掉 pi install 前缀");
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) runInstall(installSource, true);
              }}
              placeholder="npm:pi-mcp-adapter"
              disabled={installingSource !== null || !defaultCwd}
              spellCheck={false}
              aria-label="插件来源"
              className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-panel-2 px-3 font-mono text-[12px] text-fg outline-none t-fast placeholder:text-dim focus:border-accent/50 disabled:opacity-60"
            />
            <button
              onClick={() => runInstall(installSource, true)}
              disabled={installingSource !== null || !installSource.trim() || !defaultCwd}
              className="flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-accent px-4 text-[13px] font-semibold text-accent-fg t-fast hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {installingSource !== null ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
              安装
            </button>
          </div>
          {/* CLI 对照说明是开发向内容，收起为可折叠提示 —— 不占常驻版面 */}
          <details className="group mt-3 rounded-lg bg-panel-2 px-3 py-2.5">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] font-semibold text-muted t-fast hover:text-fg">
              <ChevronRight size={10} className="shrink-0 transition-transform group-open:rotate-90" />
              对应 pi CLI 命令？
            </summary>
            <div className="mt-1.5 flex flex-col gap-1 text-[11px] text-dim">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-mono">pi install npm:pi-mcp-adapter</span>
                <span>→</span>
                <span className="font-mono text-muted">npm:pi-mcp-adapter</span>
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-mono">pi remove npm:pi-mcp-adapter</span>
                <span>→</span>
                <span className="text-muted">下方列表点「移除」</span>
              </div>
              <div className="mt-0.5 leading-relaxed">
                只填 <span className="font-mono">install</span> 后面那一段，整条命令粘贴会自动去前缀。支持 npm / git / 本地路径；装到全局，新会话生效，
                或在已开着的会话里执行 <span className="font-mono">/reload</span> 立即生效。
              </div>
            </div>
          </details>
        </Card>

        {/* 发现插件（npm registry 搜索） */}
        <Card className="mb-4 p-4">
          <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="flex items-center gap-1.5 text-[13px] font-semibold text-fg">
              <Sparkles size={14} className="text-accent" />
              发现插件
            </span>
            <span className="text-[11px] text-dim">来自 npm 的 pi-package 目录 · 按月下载量排序</span>
          </div>
          <div className="flex gap-2">
            <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-panel-2 px-3">
              <Search size={14} className="shrink-0 text-dim" />
              <input
                value={catalogQuery}
                onChange={(e) => setCatalogQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) runCatalogSearch();
                }}
                placeholder="搜索插件，如 memory、mcp、subagents；留空看全部"
                disabled={catalogLoading}
                spellCheck={false}
                aria-label="搜索插件目录"
                className="w-full min-w-0 bg-transparent text-[12px] text-fg outline-none placeholder:text-dim disabled:opacity-60"
              />
            </div>
            <button
              onClick={runCatalogSearch}
              disabled={catalogLoading}
              className="flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-accent px-4 text-[13px] font-semibold text-accent-fg t-fast hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {catalogLoading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
              搜索
            </button>
          </div>

          {catalogError && (
            <div className="mt-2 rounded-md bg-danger/10 px-3 py-1.5 text-[12px] text-danger">{catalogError}</div>
          )}

          {catalogLoading && catalog === null && (
            <div className="flex items-center gap-2 py-4 text-[12px] text-dim">
              <Loader2 size={14} className="animate-spin" /> 正在读取目录…
            </div>
          )}

          {catalog !== null && (
            <div className="mt-3 max-h-80 overflow-y-auto">
              {catalog.length === 0 && (
                <div className="py-3 text-[12px] text-dim">
                  没有找到匹配的插件
                  {catalogQuery.trim() && <span className="text-dim">（试试更短的关键词）</span>}
                </div>
              )}
              {catalog.map((item) => {
                const src = `npm:${item.name}`;
                const done = isInstalled(item.name);
                return (
                  <div key={item.name} className="flex items-center gap-3 border-t border-line-soft py-2 first:border-t-0">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="truncate text-[12px] font-medium text-fg" title={item.name}>
                          {item.name}
                        </span>
                        {item.version && <span className="shrink-0 font-mono text-[11px] text-dim">{item.version}</span>}
                        {/* 两个流行度信号都给出：下载量看「有多少人在用」，star 看「有多少人关注」 */}
                        {item.stars !== undefined && (
                          <span
                            className="flex shrink-0 items-center gap-0.5 text-[11px] text-dim"
                            title={`GitHub ${item.stars} star`}
                          >
                            <Star size={10} />
                            {formatCount(item.stars)}
                          </span>
                        )}
                        {item.downloads !== undefined && (
                          <span
                            className="flex shrink-0 items-center gap-0.5 text-[11px] text-dim"
                            title={`npm 月下载 ${item.downloads}`}
                          >
                            <Download size={10} />
                            {formatCount(item.downloads)}/月
                          </span>
                        )}
                        {item.date && <span className="shrink-0 text-[11px] text-dim">{relativeDays(item.date)}</span>}
                      </div>
                      {item.description && (
                        <div className="truncate text-[12px] text-dim" title={item.description}>
                          {item.description}
                        </div>
                      )}
                    </div>
                    {done ? (
                      <span className="shrink-0 rounded-md bg-panel-2 px-2.5 py-1 text-[11px] text-dim">已安装</span>
                    ) : (
                      <button
                        onClick={() => runInstall(src)}
                        disabled={anyBusy}
                        className="flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-accent/40 px-2.5 text-[12px] font-medium text-accent t-fast hover:bg-accent-soft disabled:opacity-50"
                      >
                        {installingSource === src ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                        安装
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>已安装</CardTitle>
            <span className="ml-auto text-[12px] text-dim">{packages.length} 个</span>
          </CardHeader>
          {loading && (
            <div className="flex items-center gap-2 px-4 py-5 text-[12px] text-dim">
              <Loader2 size={14} className="animate-spin" /> 加载中…
            </div>
          )}
          {!loading && packages.length === 0 && (
            <div className="px-4 py-5 text-[12px] text-dim">没有安装任何插件</div>
          )}
          <div className="grid items-start gap-3 px-4 py-4 lg:grid-cols-2">
            {packages.map((p) => (
              <div key={`${p.scope}-${p.source}`} className="flex items-center gap-3 rounded-lg border border-line bg-panel-2/40 p-3">
                <Package size={14} className="shrink-0 text-dim" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium text-fg" title={p.source}>
                      {p.packageName || p.source}
                    </span>
                    {p.version && <span className="font-mono text-[12px] text-dim">{p.version}</span>}
                    <span className="rounded-sm bg-panel-2 px-1.5 py-0.5 text-[11px] text-dim">
                      {p.scope === "global" ? "全局" : "项目"}
                    </span>
                    {p.status === "missing" && (
                      <span className="rounded-sm bg-danger/10 px-1.5 py-0.5 text-[11px] text-danger">缺失</span>
                    )}
                  </div>
                  <div className="text-[12px] text-dim">
                    {p.counts.extensions} 扩展 · {p.counts.skills} 技能 · {p.counts.prompts} 命令
                    {updateMsg[`${p.scope}-${p.source}`] && (
                      <span className={cn("ml-2", updateMsg[`${p.scope}-${p.source}`].includes("可用") ? "text-accent" : "")}>
                        · {updateMsg[`${p.scope}-${p.source}`]}
                      </span>
                    )}
                  </div>
                </div>
                {p.canCheckForUpdates && defaultCwd && (
                  <button
                    onClick={() => checkUpdate(p)}
                    disabled={anyBusy}
                    className="mr-1 flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-line px-2.5 text-[12px] text-muted t-fast hover:text-fg disabled:opacity-50"
                    title="检查插件更新"
                  >
                    <RefreshCw size={12} className={cn(busy === `check:${p.source}` && "animate-spin")} />
                    检查更新
                  </button>
                )}
                <button
                  onClick={() => action(p, p.disabled ? "enable" : "disable")}
                  disabled={anyBusy}
                  className={cn(
                    "flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md border px-2.5 text-[12px] t-fast disabled:opacity-50",
                    p.disabled ? "border-accent/40 text-accent hover:bg-accent-soft" : "border-line text-muted hover:text-fg",
                  )}
                >
                  {busy === `act:${p.source}` && <Loader2 size={12} className="animate-spin" />}
                  {p.disabled ? "启用" : "禁用"}
                </button>
                <button
                  onClick={() => remove(p)}
                  disabled={anyBusy}
                  className="flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-line px-2.5 text-[12px] text-muted t-fast hover:border-danger/40 hover:text-danger disabled:opacity-50"
                  title="移除插件"
                >
                  {busy === `remove:${p.source}` ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                  移除
                </button>
              </div>
            ))}
          </div>
        </Card>

        <Card className="mt-4">
          <CardHeader>
            <CardTitle>MCP 服务器</CardTitle>
            <span className="ml-auto text-[12px] text-dim">{mcpServers.length} 个</span>
          </CardHeader>
          <div className="px-4 pt-3 text-[12px] text-dim">
            通过 MCP 协议给 Elen 接上外部工具（stdio / HTTP）。服务器在会话启动时连接，工具由模型按需调用、不占对话上下文。
          </div>
          <div className="mx-4 mt-3 flex items-center gap-3 rounded-lg border border-line bg-panel-2/40 p-3">
            <ShieldCheck size={14} className="shrink-0 text-dim" />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-fg">写操作需确认</div>
              <div className="text-[12px] text-dim">
                删除 / 清空 / 写入类 MCP 工具执行前弹确认卡，读取类不打扰（审批档位设为「关闭」时不生效）
              </div>
            </div>
            <Toggle
              on={mcpWriteApproval}
              disabled={mcpWriteBusy}
              onChange={(next) => void setMcpWriteApprovalSetting(next)}
            />
          </div>
          {mcpLoading && (
            <div className="flex items-center gap-2 px-4 py-4 text-[12px] text-dim">
              <Loader2 size={14} className="animate-spin" /> 加载中…
            </div>
          )}
          {!mcpLoading && mcpServers.length === 0 && (
            <div className="px-4 py-4 text-[12px] text-dim">
              {mcpNote ?? "还没有接入任何服务器。接入方式：在 ~/.pi/agent/mcp.json 配置（目前由维护者代管）。"}
            </div>
          )}
          {!mcpLoading && mcpServers.length > 0 && (
            <div className="grid items-start gap-3 px-4 py-4 lg:grid-cols-2">
              {mcpServers.map((s) => (
                <div key={s.name} className="flex items-center gap-3 rounded-lg border border-line bg-panel-2/40 p-3">
                  <Server size={14} className="shrink-0 text-dim" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-[13px] font-medium text-fg" title={s.name}>
                        {s.name}
                      </span>
                      <span className="rounded-sm bg-panel-2 px-1.5 py-0.5 text-[11px] text-dim">{s.transport}</span>
                      {!s.enabled && (
                        <span className="rounded-sm bg-panel-2 px-1.5 py-0.5 text-[11px] text-dim">已停用</span>
                      )}
                    </div>
                    <div className="truncate text-[12px] text-dim" title={s.description || s.target}>
                      {s.description || s.target}
                    </div>
                  </div>
                  <Toggle on={s.enabled} disabled={mcpBusy !== null} onChange={(next) => void setMcpEnabled(s, next)} />
                </div>
              ))}
            </div>
          )}
          <div className="border-t border-line-soft px-4 py-2 text-[11px] text-dim">
            改动对新会话生效 · 会话里输入 /mcp 查看连接状态、重连或登录
          </div>
        </Card>
      </div>
    </div>
  );
}
