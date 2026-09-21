"use client";

import { Bot, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "@/components/lib/utils";
import { dialogConfirm, toast } from "@/components/ui/dialog";
import { EmptyState, PageHeader } from "@/components/ui/bits";

type SubagentScope = "builtin" | "global" | "workspace" | "project";

type SubagentProfile = {
  name: string;
  displayName: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  loadSkills: boolean;
  loadExtensions: boolean;
  model?: string;
  thinking?: string;
  maxTurns?: number;
  inheritContext: boolean;
  runInBackground: boolean;
  enabled: boolean;
  scope: SubagentScope;
  filePath?: string;
};

const inputCls =
  "h-8 w-full rounded-md border border-line bg-panel-2 px-2.5 text-[12px] text-fg outline-none focus:border-accent/50";
const THINKING_OPTIONS = ["", "off", "minimal", "low", "medium", "high", "xhigh", "max"];

/* 内置子代理开关 */
function BuiltinToggle({ enabled, onChange, saving }: { enabled: boolean | null; onChange: (v: boolean) => void; saving: boolean }) {
  return (
    <button
      onClick={() => onChange(!enabled)}
      disabled={saving || enabled === null}
      data-testid="subagent-builtin-toggle"
      className={cn(
        "flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 text-[12px] t-fast disabled:opacity-50",
        enabled
          ? "border-success/40 bg-success/10 text-success"
          : "border-line bg-panel-2 text-muted hover:text-fg",
      )}
    >
      <span className={cn("size-1.5 rounded-full", enabled ? "bg-success" : "bg-dim")} />
      {enabled === null ? "加载中…" : enabled ? "内置子代理已启用" : "内置子代理已停用"}
    </button>
  );
}

/* 新建/编辑表单 */
function ProfileEditor({
  initial,
  cwd,
  onSaved,
  onCancel,
}: {
  initial: Partial<SubagentProfile> | null;
  cwd: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({
    name: initial?.name ?? "",
    displayName: initial?.displayName ?? "",
    description: initial?.description ?? "",
    systemPrompt: initial?.systemPrompt ?? "",
    tools: (initial?.tools ?? []).join(", "),
    model: initial?.model ?? "",
    thinking: initial?.thinking ?? "",
    maxTurns: initial?.maxTurns ? String(initial.maxTurns) : "",
    inheritContext: initial?.inheritContext ?? true,
    loadSkills: initial?.loadSkills ?? true,
    loadExtensions: initial?.loadExtensions ?? true,
    runInBackground: initial?.runInBackground ?? false,
    enabled: initial?.enabled ?? true,
  });
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    if (!form.name.trim()) {
      toast("name 必填（小写字母/数字/连字符）");
      return;
    }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        displayName: form.displayName.trim() || form.name.trim(),
        description: form.description,
        systemPrompt: form.systemPrompt,
        tools: form.tools.split(",").map((s) => s.trim()).filter(Boolean),
        loadSkills: form.loadSkills,
        loadExtensions: form.loadExtensions,
        inheritContext: form.inheritContext,
        runInBackground: form.runInBackground,
        enabled: form.enabled,
      };
      if (form.model.trim()) payload.model = form.model.trim();
      if (form.thinking) payload.thinking = form.thinking;
      if (form.maxTurns.trim()) {
        const n = Number(form.maxTurns);
        if (!Number.isInteger(n) || n <= 0) throw new Error("maxTurns 必须是正整数");
        payload.maxTurns = n;
      }
      const res = await fetch("/api/subagents/profiles", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, scope: "global", profile: payload }),
      });
      const d = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(d.error || `保存失败（HTTP ${res.status}）`);
      toast("已保存");
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-t border-line-soft px-4 py-3" data-testid="subagent-editor">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-[11px] text-dim">name（唯一标识）</span>
          <input value={form.name} onChange={(e) => set("name", e.target.value)} disabled={!!initial?.name} placeholder="reviewer" className={inputCls} />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] text-dim">显示名</span>
          <input value={form.displayName} onChange={(e) => set("displayName", e.target.value)} placeholder="代码审查员" className={inputCls} />
        </label>
        <label className="block sm:col-span-2">
          <span className="mb-1 block text-[11px] text-dim">描述</span>
          <input value={form.description} onChange={(e) => set("description", e.target.value)} placeholder="什么时候应该使用这个子代理" className={inputCls} />
        </label>
        <label className="block sm:col-span-2">
          <span className="mb-1 block text-[11px] text-dim">系统提示（systemPrompt）</span>
          <textarea
            value={form.systemPrompt}
            onChange={(e) => set("systemPrompt", e.target.value)}
            rows={4}
            className="w-full resize-y rounded-md border border-line bg-panel-2 p-2.5 font-mono text-[12px] leading-relaxed text-fg outline-none focus:border-accent/50"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] text-dim">工具（逗号分隔，留空 = 全部）</span>
          <input value={form.tools} onChange={(e) => set("tools", e.target.value)} placeholder="read, bash, grep" className={inputCls} />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] text-dim">模型（provider/modelId，留空 = 默认）</span>
          <input value={form.model} onChange={(e) => set("model", e.target.value)} placeholder="anthropic/claude-…（可选）" className={inputCls} />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] text-dim">思考档位</span>
          <select value={form.thinking} onChange={(e) => set("thinking", e.target.value)} className={inputCls}>
            {THINKING_OPTIONS.map((o) => (
              <option key={o} value={o}>{o === "" ? "（默认）" : o}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] text-dim">最大轮数（maxTurns）</span>
          <input value={form.maxTurns} onChange={(e) => set("maxTurns", e.target.value)} placeholder="不限" className={inputCls} />
        </label>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-[12px] text-muted">
        {([
          ["inheritContext", "继承父会话上下文"],
          ["loadSkills", "加载技能"],
          ["loadExtensions", "加载扩展"],
          ["runInBackground", "后台运行"],
          ["enabled", "启用"],
        ] as const).map(([key, label]) => (
          <label key={key} className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              checked={form[key]}
              onChange={(e) => set(key, e.target.checked)}
              className="size-3.5 accent-[var(--accent)]"
            />
            {label}
          </label>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={() => void save()}
          disabled={saving}
          className="flex h-7 cursor-pointer items-center gap-1 rounded-lg bg-accent px-2.5 text-[12px] font-medium text-accent-fg t-fast hover:bg-accent-hover disabled:opacity-50"
        >
          {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} 保存到全局（~/.pi/agent）
        </button>
        <button
          onClick={onCancel}
          className="flex h-7 cursor-pointer items-center rounded-lg border border-line px-2.5 text-[12px] text-muted t-fast hover:text-fg"
        >
          取消
        </button>
      </div>
    </div>
  );
}

import { SubagentRunMonitor } from "@/components/subagents/RunMonitor";

/** 作用域中文名：避免全中文界面里冒出 builtin / workspace 这类英文枚举 */
const SCOPE_LABEL: Record<string, string> = {
  builtin: "内置",
  global: "全局",
  workspace: "工作区",
  project: "项目",
};

export function SubagentsPage({ defaultCwd }: { defaultCwd: string | null }) {
  const [profiles, setProfiles] = useState<SubagentProfile[]>([]);
  const [builtinEnabled, setBuiltinEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null); // profile name 或 "new"
  const [togglingBuiltin, setTogglingBuiltin] = useState(false);

  const load = useCallback(async (cwd: string | null) => {
    if (!cwd) {
      setProfiles([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" });
      const d = (await res.json()) as { profiles?: SubagentProfile[]; error?: string };
      if (!res.ok) throw new Error(d.error || `加载失败（HTTP ${res.status}）`);
      setProfiles(d.profiles ?? []);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
      setProfiles([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(defaultCwd);
  }, [defaultCwd, load]);

  useEffect(() => {
    fetch("/api/subagents/settings", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { enabled?: boolean }) => setBuiltinEnabled(d.enabled ?? false))
      .catch(() => setBuiltinEnabled(null));
  }, []);

  const toggleBuiltin = async () => {
    if (builtinEnabled === null) return;
    setTogglingBuiltin(true);
    try {
      const res = await fetch("/api/subagents/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !builtinEnabled }),
      });
      const d = (await res.json()) as { enabled?: boolean; error?: string };
      if (!res.ok) throw new Error(d.error || `保存失败（HTTP ${res.status}）`);
      setBuiltinEnabled(d.enabled ?? !builtinEnabled);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setTogglingBuiltin(false);
    }
  };

  const deleteProfile = async (p: SubagentProfile) => {
    const ok = await dialogConfirm({
      title: "删除子代理",
      message: `确定删除「${p.displayName || p.name}」（${p.scope}）？此操作不可撤销。`,
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch("/api/subagents/profiles", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: defaultCwd!, scope: p.scope, name: p.name }),
      });
      const d = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(d.error || `删除失败（HTTP ${res.status}）`);
      toast("已删除");
      void load(defaultCwd);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleEnabled = async (p: SubagentProfile) => {
    try {
      const res = await fetch("/api/subagents/profiles", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: defaultCwd!, scope: p.scope === "project" ? "project" : "global", name: p.name, enabled: !p.enabled }),
      });
      const d = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(d.error || `操作失败（HTTP ${res.status}）`);
      void load(defaultCwd);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="page-col py-6">
        <PageHeader
          icon={<Bot size={16} />}
          title="子代理"
          subtitle="可复用的专用代理，由主会话按需派生"
        />

        {/* 先看到「谁在跑」，再管配置 —— 与产品「编排与可见性」的定位一致 */}
        <SubagentRunMonitor />

        {/* 两卡同排等高（grid 默认 stretch）。原先是 items-start + 右卡 self-start，
            右卡只有 103px、左卡 335px，同排一高一矮；现在右卡拉伸后
            内容两端分布（标题顶、目录与按钮底），中间留白而不是短一截。 */}
        <div className="grid gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex flex-col rounded-card border border-line bg-panel xl:order-2">
          <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-4 py-3">
            <span className="text-[13px] font-semibold text-fg">内置子代理</span>
            <span className="text-[11px] text-dim">general / code-reviewer 等 Pi 预设</span>            <div className="ml-auto">
              <BuiltinToggle enabled={builtinEnabled} saving={togglingBuiltin} onChange={() => void toggleBuiltin()} />
            </div>
          </div>
          <div className="mt-auto flex items-center gap-2 px-4 py-2.5 text-[12px] text-dim">
            <span className="min-w-0 truncate font-mono">目录：{defaultCwd ?? "（未设置默认工作目录，无法读取项目级 Profile）"}</span>
            <button
              onClick={() => setEditing("new")}
              disabled={!defaultCwd}
              data-testid="subagent-new"
              className="btn btn-primary ml-auto shrink-0"
            >
              <Plus size={12} /> 新建子代理
            </button>
          </div>
        </div>

        <div className="rounded-card border border-line bg-panel xl:order-1">
          <div className="flex items-center gap-2 border-b border-line-soft px-4 py-3">
            <span className="text-[13px] font-semibold text-fg">子代理配置</span>
            <span className="text-[11px] text-dim">{profiles.length} 个</span>
          </div>
          {loading && (
            <div className="flex items-center gap-2 px-4 py-5 text-[12px] text-dim">
              <Loader2 size={14} className="animate-spin" /> 加载 Profiles…
            </div>
          )}
          {!loading && profiles.length === 0 && (
            <EmptyState icon={<Bot size={20} />} title="暂无子代理配置" hint="新建一个子代理，或在上方开关处启用 Pi 内置预设。" />
          )}
          {profiles.map((p) => (
            <div key={`${p.scope}-${p.name}`} className="border-t border-line-soft px-4 py-3 first:border-t-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className={cn("text-[13px] font-semibold", p.enabled ? "text-fg" : "text-dim line-through")}>
                  {p.displayName || p.name}
                </span>
                <span className="font-mono text-[11px] text-dim">{p.name}</span>
                <span className="chip">{SCOPE_LABEL[p.scope] ?? p.scope}</span>
                {p.model && <span className="truncate font-mono text-[10px] text-dim">{p.model}</span>}
                <div className="ml-auto flex items-center gap-1.5">
                  <button
                    onClick={() => void toggleEnabled(p)}
                    className="btn btn-ghost"
                  >
                    {p.enabled ? "停用" : "启用"}
                  </button>
                  <button
                    onClick={() => setEditing(editing === p.name ? null : p.name)}
                    className="flex h-7 cursor-pointer items-center rounded-md border border-line px-2.5 text-[12px] text-muted t-fast hover:text-fg"
                  >
                    {editing === p.name ? "收起" : "编辑"}
                  </button>
                  <button
                    onClick={() => void deleteProfile(p)}
                    className="flex h-7 cursor-pointer items-center gap-1 rounded-md border border-line px-2.5 text-[12px] text-danger t-fast hover:bg-danger/10"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
              {p.description && <div className="mt-1 text-[12px] text-muted">{p.description}</div>}
              <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-dim">
                {p.tools.length > 0 && <span>工具：{p.tools.join(" · ")}</span>}
                {p.maxTurns != null && <span>≤{p.maxTurns} 轮</span>}
                {p.runInBackground && <span>后台</span>}
                {p.inheritContext && <span>继承上下文</span>}
              </div>
              {editing === p.name && (
                <ProfileEditor
                  initial={p}
                  cwd={defaultCwd!}
                  onSaved={() => {
                    setEditing(null);
                    void load(defaultCwd);
                  }}
                  onCancel={() => setEditing(null)}
                />
              )}
            </div>
          ))}
          {editing === "new" && (
            <ProfileEditor
              initial={null}
              cwd={defaultCwd!}
              onSaved={() => {
                setEditing(null);
                void load(defaultCwd);
              }}
              onCancel={() => setEditing(null)}
            />
          )}
          </div>
        </div>
      </div>
    </div>
  );
}
