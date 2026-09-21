"use client";

import { Archive, ArchiveRestore, Download, FileText, Loader2, Plus, RefreshCw, Save, Search, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "@/components/lib/utils";
import { PageHeader } from "@/components/ui/bits";
import { dialogConfirm, toast } from "@/components/ui/dialog";

type SkillInfo = {
  name: string;
  description: string;
  filePath: string;
  disableModelInvocation: boolean;
  sourceInfo: { source?: string; scope?: string };
  install?: { package: string; scope: string; canCheckForUpdates: boolean } | null;
};
type SearchResult = { package: string; installs?: string; url?: string };

/** 技能生命周期：状态是自动算的，归档/恢复由人点（见 lib/skill-lifecycle） */
type SkillState = "active" | "stale" | "unused";
type LifecycleEntry = {
  name: string;
  baseDir: string;
  useCount: number;
  lastUsedAt: string | null;
  state: SkillState;
  reason: string;
};
type ArchivedSkill = {
  id: string;
  name: string;
  originalDir: string;
  archivedAt: string;
  reason: string;
};

function shortDate(iso: string | null): string {
  if (!iso) return "从未";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "未知";
  const days = Math.floor((Date.now() - at) / 86400000);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  if (days < 30) return `${days} 天前`;
  return new Date(at).toLocaleDateString();
}

/* SKILL.md 查看编辑器 */
function SkillEditor({ filePath, onClose }: { filePath: string; onClose: () => void }) {
  const [content, setContent] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setContent(null);
    fetch(`/api/skills/file?path=${encodeURIComponent(filePath)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { content?: string; error?: string }) => {
        if (d.error) throw new Error(d.error);
        setContent(d.content ?? "");
      })
      .catch((e) => {
        toast(e instanceof Error ? e.message : String(e));
        onClose();
      });
  }, [filePath, onClose]);

  const save = async () => {
    if (content === null) return;
    setSaving(true);
    try {
      const res = await fetch("/api/skills/file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath, content }),
      });
      const d = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(d.error || `保存失败（HTTP ${res.status}）`);
      toast("已保存");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-2 w-full" data-testid="skill-editor">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="truncate font-mono text-[11px] text-dim" title={filePath}>{filePath}</span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <button
            onClick={() => void save()}
            disabled={saving || content === null}
            className="btn btn-primary btn-sm"
          >
            {saving ? <Loader2 size={10} className="animate-spin" /> : <Save size={10} />} 保存
          </button>
          <button onClick={onClose} className="btn btn-sm btn-ghost">
            收起
          </button>
        </div>
      </div>
      {content === null ? (
        <div className="flex items-center gap-2 py-3 text-[12px] text-dim">
          <Loader2 size={14} className="animate-spin" /> 加载 SKILL.md…
        </div>
      ) : (
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          spellCheck={false}
          className="h-64 w-full resize-y rounded-md border border-line bg-panel-2 p-2.5 font-mono text-[12px] leading-relaxed text-fg outline-none focus:border-accent/50"
        />
      )}
    </div>
  );
}

export function SkillsPage({ defaultCwd }: { defaultCwd: string | null }) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  // 更新检查状态：filePath → 状态文本
  const [updateState, setUpdateState] = useState<Record<string, { checking?: boolean; updating?: boolean; msg?: string; canUpdate?: boolean }>>({});

  // skills.sh 搜索安装
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [lifecycle, setLifecycle] = useState<Record<string, LifecycleEntry>>({});
  const [archived, setArchived] = useState<ArchivedSkill[]>([]);
  const [archiving, setArchiving] = useState<string | null>(null);

  const loadLifecycle = useCallback(async (cwd: string) => {
    if (!cwd) return;
    try {
      const res = await fetch(`/api/skills/lifecycle?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { entries?: LifecycleEntry[]; archived?: ArchivedSkill[] };
      setLifecycle(Object.fromEntries((data.entries ?? []).map((entry) => [entry.name, entry])));
      setArchived(data.archived ?? []);
    } catch {
      /* 拿不到就不显示分层，不打扰 */
    }
  }, []);

  const load = useCallback(async (cwd: string) => {
    if (!cwd) return;
    setLoading(true);
    try {
      const data = await fetch(`/api/skills?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" }).then((r) => r.json());
      setSkills(data.skills ?? []);
    } catch {
      setSkills([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (defaultCwd) load(defaultCwd);
  }, [defaultCwd, load]);

  useEffect(() => {
    if (defaultCwd) void loadLifecycle(defaultCwd);
  }, [defaultCwd, loadLifecycle]);

  const archive = async (s: SkillInfo) => {
    const entry = lifecycle[s.name];
    const ok = await dialogConfirm({
      title: "归档技能",
      message: `把「${s.name}」搬到归档目录（不再是可用技能，也不会被加载）。\n\n`
        + "不会删除：文件原样保留，随时可以恢复。",
      confirmText: "归档",
    });
    if (!ok) return;
    setArchiving(s.name);
    try {
      const res = await fetch("/api/skills/lifecycle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "archive",
          name: s.name,
          baseDir: entry?.baseDir ?? s.filePath.replace(/[\\/][^\\/]+$/, ""),
          reason: entry?.reason ?? "手工归档",
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || `归档失败（HTTP ${res.status}）`);
      toast(`已归档「${s.name}」，可在下方恢复`);
      if (defaultCwd) {
        await load(defaultCwd);
        await loadLifecycle(defaultCwd);
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : "归档失败");
    } finally {
      setArchiving(null);
    }
  };

  const restore = async (item: ArchivedSkill) => {
    setArchiving(item.id);
    try {
      const res = await fetch("/api/skills/lifecycle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restore", id: item.id }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || `恢复失败（HTTP ${res.status}）`);
      toast(`已恢复「${item.name}」`);
      if (defaultCwd) {
        await load(defaultCwd);
        await loadLifecycle(defaultCwd);
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : "恢复失败");
    } finally {
      setArchiving(null);
    }
  };

  const toggle = async (s: SkillInfo) => {
    setToggling(s.filePath);
    try {
      await fetch("/api/skills", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath: s.filePath, disableModelInvocation: !s.disableModelInvocation }),
      });
      setSkills((prev) =>
        prev.map((x) => (x.filePath === s.filePath ? { ...x, disableModelInvocation: !s.disableModelInvocation } : x)),
      );
    } finally {
      setToggling(null);
    }
  };

  const checkUpdate = async (s: SkillInfo) => {
    if (!s.install || !defaultCwd) return;
    const key = s.filePath;
    setUpdateState((p) => ({ ...p, [key]: { checking: true } }));
    try {
      const res = await fetch("/api/skills/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: defaultCwd, package: s.install.package, scope: s.install.scope }),
      });
      const d = await res.json();
      const result = Array.isArray(d.results) ? d.results[0] : d;
      const state = result?.state;
      setUpdateState((p) => ({
        ...p,
        [key]: {
          msg:
            state === "update-available"
              ? "有可用更新"
              : state === "up-to-date"
                ? "已是最新"
                : result?.message || "无法检查更新",
          canUpdate: state === "update-available",
        },
      }));
    } catch {
      setUpdateState((p) => ({ ...p, [key]: { msg: "检查失败" } }));
    }
  };

  const doUpdate = async (s: SkillInfo) => {
    if (!s.install || !defaultCwd) return;
    const key = s.filePath;
    setUpdateState((p) => ({ ...p, [key]: { updating: true } }));
    try {
      const res = await fetch("/api/skills/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: defaultCwd, package: s.install.package, scope: s.install.scope }),
      });
      const d = await res.json();
      setUpdateState((p) => ({
        ...p,
        [key]: { msg: res.ok ? "已更新，刷新列表后生效" : d.error || "更新失败" },
      }));
      if (res.ok) load(defaultCwd);
    } catch {
      setUpdateState((p) => ({ ...p, [key]: { msg: "更新失败" } }));
    }
  };

  const search = async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setResults(null);
    try {
      const data = await fetch("/api/skills/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q }),
      }).then((r) => r.json());
      setResults(data.results ?? []);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  const install = async (source: string) => {
    setInstalling(source);
    setMessage(null);
    try {
      const res = await fetch("/api/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ package: source, scope: "global" }),
      });
      const data = await res.json();
      setMessage(res.ok ? `已安装 ${source}` : `安装失败：${data.error ?? res.status}`);
      if (res.ok && defaultCwd) load(defaultCwd);
    } catch (e) {
      setMessage(`安装失败：${String(e)}`);
    } finally {
      setInstalling(null);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="page-col py-6">
        <PageHeader
          icon={<Sparkles size={16} />}
          title="技能"
          subtitle={`管理 Agent 可用的 Skills · 共 ${skills.length} 个`}
          actions={
            <button
              onClick={() => defaultCwd && load(defaultCwd)}
              className="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-panel-2 px-2.5 text-[12px] text-muted t-fast hover:text-fg"
            >
              <RefreshCw size={12} className={cn(loading && "anim-spin")} />
              刷新
            </button>
          }
        />

        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,7fr)_minmax(0,3fr)]">
        {/* 从 skills.sh 安装 */}
        <div className="rounded-card border border-line bg-panel p-4 xl:order-2 xl:sticky xl:top-6 xl:self-start">
          <div className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold text-fg">
            <Plus size={14} className="text-accent" />
            从 skills.sh 安装新技能
          </div>
          <div className="flex gap-2">
            <div className="flex h-9 flex-1 items-center gap-2 rounded-lg border border-line bg-panel-2 px-3">
              <Search size={14} className="text-dim" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && search()}
                placeholder="搜索技能名称，如 pdf、commit-helper…"
                className="w-full bg-transparent text-[12px] text-fg outline-none placeholder:text-dim"
              />
            </div>
            <button
              onClick={search}
              disabled={searching || !query.trim()}
              className="flex h-9 cursor-pointer items-center gap-1.5 rounded-lg bg-accent px-4 text-[12px] font-semibold text-accent-fg t-fast hover:bg-accent-hover disabled:opacity-50"
            >
              {searching ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
              搜索
            </button>
          </div>
          {message && (
            <div className="mt-2 rounded-md bg-panel-2 px-3 py-1.5 text-[12px] text-muted">{message}</div>
          )}
          {results && (
            <div className="mt-3 max-h-64 overflow-y-auto">
              {results.length === 0 && <div className="py-3 text-[12px] text-dim">没有找到匹配的技能</div>}
              {results.map((r) => (
                <div key={r.package} className="flex items-center gap-3 border-t border-line-soft py-2 first:border-t-0">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] font-medium text-fg" title={r.package}>
                      {r.package}
                    </div>
                    {r.url && (
                      <a href={r.url} target="_blank" rel="noreferrer" className="truncate font-mono text-[11px] text-dim hover:text-accent">
                        {r.url}
                      </a>
                    )}
                  </div>
                  {r.installs && <span className="shrink-0 text-[11px] text-dim">{r.installs}</span>}
                  <button
                    onClick={() => install(r.package)}
                    disabled={installing !== null}
                    className="flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-accent/40 px-2.5 text-[12px] font-medium text-accent t-fast hover:bg-accent-soft disabled:opacity-50"
                  >
                    {installing === r.package ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                    安装
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 已装技能列表 */}
        <div className="rounded-card border border-line bg-panel xl:order-1">
          {loading && (
            <div className="flex items-center gap-2 px-4 py-6 text-[12px] text-dim">
              <Loader2 size={14} className="animate-spin" /> 加载技能中…
            </div>
          )}
          {!loading && skills.length === 0 && (
            <div className="px-4 py-6 text-[12px] text-dim">当前项目没有可用技能</div>
          )}
          {skills.map((s) => {
            const enabled = !s.disableModelInvocation;
            const entry = lifecycle[s.name];
            return (
              <div key={s.filePath} className="border-t border-line-soft px-4 py-3 first:border-t-0">
                <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-semibold text-fg">{s.name}</span>
                    {s.sourceInfo?.scope && (
                      <span className="rounded-sm bg-panel-2 px-1.5 py-0.5 text-[10px] text-dim">
                        {s.sourceInfo.scope === "global" ? "全局" : "项目"}
                      </span>
                    )}
                    {entry && entry.state !== "active" && (
                      <span
                        className={cn("chip", entry.state === "unused" ? "chip-warn" : "chip")}
                        title={`${entry.reason} · 最近使用：${shortDate(entry.lastUsedAt)}`}
                      >
                        {entry.state === "unused" ? "从未使用" : "久未使用"}
                      </span>
                    )}
                    {entry && entry.useCount > 0 && (
                      <span className="text-[10px] text-dim">
                        用过 {entry.useCount} 次 · {shortDate(entry.lastUsedAt)}
                      </span>
                    )}
                    {!enabled && (
                      <span className="flex items-center gap-0.5 rounded-sm bg-panel-2 px-1.5 py-0.5 text-[10px] text-dim">
                        <X size={10} /> 模型不可调用
                      </span>
                    )}
                  </div>
                  {s.description && <p className="mt-0.5 line-clamp-2 text-[12px] text-muted">{s.description}</p>}
                  <div className="mt-0.5 truncate font-mono text-[11px] text-dim/80" title={s.filePath}>
                    {s.filePath}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {s.install?.canCheckForUpdates && defaultCwd && (
                    <div className="flex items-center gap-1.5">
                      {updateState[s.filePath]?.msg && (
                        <span className={cn("text-[11px]", updateState[s.filePath]?.canUpdate ? "text-accent" : "text-dim")}>
                          {updateState[s.filePath]?.msg}
                        </span>
                      )}
                      {updateState[s.filePath]?.canUpdate ? (
                        <button
                          onClick={() => doUpdate(s)}
                          disabled={updateState[s.filePath]?.updating}
                          className="btn btn-primary btn-sm"
                        >
                          {updateState[s.filePath]?.updating ? <Loader2 size={10} className="animate-spin" /> : <Download size={10} />}
                          更新
                        </button>
                      ) : (
                        <button
                          onClick={() => checkUpdate(s)}
                          disabled={updateState[s.filePath]?.checking}
                          className="btn btn-sm btn-ghost"
                        >
                          {updateState[s.filePath]?.checking ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
                          检查更新
                        </button>
                      )}
                    </div>
                  )}
                  <button
                    onClick={() => setEditingPath(editingPath === s.filePath ? null : s.filePath)}
                    className={cn(
                      "btn btn-sm",
                      editingPath === s.filePath
                        ? "border-accent/40 bg-accent-soft text-accent"
                        : "btn-ghost",
                    )}
                  >
                    <FileText size={10} /> {editingPath === s.filePath ? "收起" : "编辑"}
                  </button>
                  <button
                    onClick={() => void archive(s)}
                    disabled={archiving === s.name}
                    className="btn btn-sm btn-ghost"
                    title="搬到归档目录（不删除，可恢复）"
                  >
                    {archiving === s.name ? <Loader2 size={10} className="animate-spin" /> : <Archive size={10} />}
                    归档
                  </button>
                  <button
                    onClick={() => toggle(s)}
                    disabled={toggling === s.filePath}
                    className={cn(
                      "relative h-5 w-9 shrink-0 cursor-pointer rounded-full t-fast",
                      enabled ? "bg-accent" : "bg-line",
                    )}
                    title={enabled ? "点击禁用（模型不可自动调用）" : "点击启用"}
                  >
                    <span
                      className={cn(
                        "absolute top-0.5 size-4 rounded-full bg-white shadow-sm transition-all",
                        enabled ? "left-[18px]" : "left-0.5",
                      )}
                    />
                  </button>
                </div>
              </div>
                {editingPath === s.filePath && (
                  <SkillEditor filePath={s.filePath} onClose={() => setEditingPath(null)} />
                )}
              </div>
            );
          })}

          {/* 已归档：技能永远不删，只用这里来收拢“装了没用过”的能力。
              必须待在技能列表卡**内部**：它落在 grid 里就成了一个独立网格项，
              带着默认 order=0 抢走左列首位，把 order-1/order-2 的列序整个顶掉
              （表现出来就是左列两张卡凑顶端、中间空一大段）。 */}
          {archived.length > 0 && (
            <div className="mt-3 rounded-card border border-line-soft bg-panel-2/50 p-3">
              <div className="flex items-center gap-2">
                <Archive size={12} className="text-dim" />
                <span className="text-[12px] font-semibold text-muted">已归档 {archived.length}</span>
                <span className="text-[11px] text-dim">文件仍在归档目录里，恢复即回到原位</span>
              </div>
              <div className="mt-2 flex flex-col gap-1">
                {archived.map((item) => (
                  <div key={item.id} className="flex items-center gap-2 rounded-md bg-panel px-2 py-1.5">
                    <span className="min-w-0 flex-1 truncate text-[12px] text-fg" title={`${item.originalDir}\n${item.reason}`}>
                      {item.name}
                    </span>
                    <span className="shrink-0 text-[10px] text-dim">
                      {shortDate(item.archivedAt)}归档 · {item.reason}
                    </span>
                    <button
                      onClick={() => void restore(item)}
                      disabled={archiving === item.id}
                      className="btn btn-sm btn-ghost shrink-0"
                    >
                      {archiving === item.id ? <Loader2 size={10} className="animate-spin" /> : <ArchiveRestore size={10} />}
                      恢复
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}
