"use client";

import { Check, Loader2, Pencil, Plus, RefreshCw, Save, Search, X } from "lucide-react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "@/components/lib/utils";
import { toast } from "@/components/ui/dialog";
import { useModelNotes } from "@/hooks/useModelNotes";
import { failingModelNote, useModelHealth } from "@/hooks/useModelHealth";
import { failingBadgeText, lookupModelHealth } from "@/lib/model-health-match";

/** 与 lib/model-notes.ts 的 MAX_NOTE_LENGTH 一致（客户端不能运行时导入该文件——下半有 node:fs）。 */
const NOTE_MAX = 200;

/**
 * 模型库向页面状态条汇报的选型侧摘要。
 *
 * 为什么由这里汇报而不是页面自己再拉一次：`/api/models` 会 `createAgentSessionServices`
 * （真正加载模型注册表 + 项目扩展），是全页最重的一次取数；模型库已经在拉了，
 * 页面再拉一遍既慢又会出现「状态条与列表不是同一份数据」的漂移。
 */
export type ModelScopeSummary = {
  loading: boolean;
  error: string | null;
  /** 库里的全部模型数 */
  total: number;
  /** 已勾选数（未收窄白名单时 = total，与列表口径一致） */
  selected: number;
  /** 是否收窄过白名单（`enabledModels` 非空） */
  scoped: boolean;
  /** 库内被标为「有故障」的模型数；健康记录匹配不上库内任何模型的不计（见 lib/model-health-match.ts） */
  failing: number;
  /** 默认模型 ref（`provider/id`），未知为 null */
  defaultRef: string | null;
};

type Props = {
  /** 只看有故障的模型（状态条那颗「有故障 N 个」点开后置真） */
  onlyFailing?: boolean;
  onSummary?: (summary: ModelScopeSummary) => void;
  /** 外部（健康面板「设为默认」）改过默认模型时，用来同步行上的「默认」标记 */
  defaultRefOverride?: string | null;
};

type ModelEntry = { id: string; name: string; provider: string };
type ModelsPayload = {
  modelList?: ModelEntry[];
  /** 未过滤的完整清单（编辑器用它，保证白名单外的模型也可见可勾选） */
  allModelList?: ModelEntry[];
  defaultModel?: { provider: string; modelId: string } | null;
  catalogCheckedAt?: number;
  error?: string;
};

const THINKING_SUFFIX = /:(?:auto|off|minimal|low|medium|high|xhigh|max)$/i;

function isGlobPattern(pattern: string): boolean {
  return /[*?[]/.test(pattern);
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function refOf(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

/** 与服务端 model-scope 的匹配规则保持同一取向：glob 优先，否则精确，最后退化到包含。 */
function patternMatches(pattern: string, model: ModelEntry): boolean {
  const base = pattern.trim().replace(THINKING_SUFFIX, "");
  if (!base) return false;
  const ref = refOf(model);
  if (isGlobPattern(base)) {
    const re = globToRegExp(base);
    return re.test(ref) || re.test(model.id);
  }
  return ref.toLowerCase() === base.toLowerCase() || model.id.toLowerCase() === base.toLowerCase();
}

function formatAgo(ms: number | undefined): string {
  if (!ms) return "从未刷新";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "刚刚刷新";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前刷新`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前刷新`;
  return `${Math.floor(diff / 86_400_000)} 天前刷新`;
}

/**
 * 模型库编辑器。
 *
 * 交互只讲一件事：勾选 = 这个模型出现在对话的模型选择器里；未勾选的保留在库中。
 * 实现上，勾选集合就是 pi 的 `enabledModels` 白名单（glob 模式；pi 没有黑名单）。
 * 未做选择时全部可用；保存过选择后，厂商上新模型默认留在库里，勾选后才进选择器。
 */
export function ModelScopeEditor({ onlyFailing = false, onSummary, defaultRefOverride = null }: Props = {}) {
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [patterns, setPatterns] = useState<string[]>([]);
  const [defaultRef, setDefaultRef] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | undefined>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [patternDraft, setPatternDraft] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  /** 一旦用户勾选过，通配模式会被展开成具体模型，需要提示一次。 */
  const [materialized, setMaterialized] = useState(false);

  /* 模型备注：每模型一条自由文本（擅长什么 / 贵不贵），行内展示 + 小铅笔内联编辑。 */
  const { notes, save: saveNote } = useModelNotes();
  /* 健康度：模型库里也要能看见「这个模型近期有故障」，而不是勾了才发现（模块 6 修复轮 C）。 */
  const { health } = useModelHealth();
  const [editingRef, setEditingRef] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [savingNote, setSavingNote] = useState(false);

  const openNoteEditor = (ref: string, current: string) => {
    setEditingRef(ref);
    setNoteDraft(current);
  };

  /** Enter 保存 / 清除按钮走同一条路；空串即清除（服务端删键）。 */
  const commitNote = async (provider: string, modelId: string, note: string) => {
    setSavingNote(true);
    try {
      await saveNote(provider, modelId, note);
      toast(note.trim() ? "备注已保存" : "备注已清除");
      setEditingRef(null);
      setNoteDraft("");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingNote(false);
    }
  };

  const loadModels = useCallback(async () => {
    try {
      const res = await fetch("/api/models", { cache: "no-store" });
      const d = (await res.json()) as ModelsPayload;
      // 加载失败（如 403 / 网络错误）时如实报错，而不是伪装成"没有可用模型"。
      if (!res.ok || d.error) throw new Error(d.error || `HTTP ${res.status}`);
      // 白名单（enabledModels）会让内核侧只返回"可见"模型；编辑器必须用未过滤的
      // 全量清单，否则收窄后看不见被移出的模型、无法再勾回来（2026-09-28 反馈）。
      const list = Array.isArray(d.allModelList) ? d.allModelList : d.modelList;
      setModels(Array.isArray(list) ? list : []);
      setCheckedAt(d.catalogCheckedAt);
      setDefaultRef(d.defaultModel ? `${d.defaultModel.provider}/${d.defaultModel.modelId}` : null);
      setLoadError(null);
    } catch (e) {
      setModels([]);
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [d] = await Promise.all([
          fetch("/api/pi-settings", { cache: "no-store" }).then((r) => r.json()),
          loadModels(),
        ]);
        if (cancelled) return;
        const list = (d as { settings?: { enabledModels?: string[] } })?.settings?.enabledModels;
        setPatterns(Array.isArray(list) ? list : []);
      } catch {
        /* 保持空列表 */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadModels]);

  const globPatterns = useMemo(() => patterns.filter(isGlobPattern), [patterns]);

  /** 默认模型的显示取值：健康面板改过默认就以后者为准（库只在加载时读一次 settings） */
  const shownDefaultRef = defaultRefOverride ?? defaultRef;

  /**
   * 未启用白名单时（patterns 为空）内核会展示**全部**模型，所以勾选态必须是"全选"——
   * 否则"显示全部"会长成"一个都没选"的样子，而用户的直觉是"取消勾选 = 删掉这个模型"。
   */
  const selectedRefs = useMemo(() => {
    const set = new Set<string>();
    if (patterns.length === 0) {
      for (const m of models) set.add(refOf(m));
      return set;
    }
    for (const m of models) {
      if (patterns.some((p) => patternMatches(p, m))) set.add(refOf(m));
    }
    return set;
  }, [models, patterns]);

  const scoped = patterns.length > 0;

  /**
   * 库内被健康数据标为「有故障」的行。匹配走 `lookupModelHealth`（同 provider + 同 id，
   * 大小写不敏感且唯一才认）——健康侧 id 与模型库 id 来源不同，匹配不上一律**不标**。
   */
  const failingRefs = useMemo(() => {
    const set = new Set<string>();
    for (const m of models) {
      if (lookupModelHealth(health, m.provider, m.id)?.status === "failing") set.add(refOf(m));
    }
    return set;
  }, [models, health]);

  const filtered = useMemo(() => {
    const base = onlyFailing ? models.filter((m) => failingRefs.has(refOf(m))) : models;
    const q = query.trim().toLowerCase();
    if (!q) return base;
    return base.filter(
      (m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q),
    );
  }, [models, query, onlyFailing, failingRefs]);

  /* 状态条要的那点数，由这里汇报（页面不再重复请求 /api/models） */
  useEffect(() => {
    onSummary?.({
      loading,
      error: loadError,
      total: models.length,
      selected: selectedRefs.size,
      scoped,
      failing: failingRefs.size,
      defaultRef: shownDefaultRef,
    });
  }, [onSummary, loading, loadError, models, selectedRefs, scoped, failingRefs, shownDefaultRef]);

  const groups = useMemo(() => {
    const map = new Map<string, ModelEntry[]>();
    for (const m of filtered) {
      const list = map.get(m.provider) ?? [];
      list.push(m);
      map.set(m.provider, list);
    }
    return [...map.entries()];
  }, [filtered]);

  /** 勾选结果一律落成具体的 `provider/modelId`，避免"模式"与"勾选"两套语义打架。 */
  const applySelection = (nextRefs: Set<string>) => {
    // 空列表在内核语义里等于"不过滤 = 显示全部"，与用户"全部取消"的预期相反，直接拦下。
    if (nextRefs.size === 0) {
      toast("至少选一个模型——它会出现在对话的模型选择器里");
      return;
    }
    if (globPatterns.length > 0 && !materialized) {
      setMaterialized(true);
      toast("已展开为具体模型列表（原通配模式已替换）");
    }
    setPatterns([...nextRefs].sort());
  };

  const toggle = (model: ModelEntry) => {
    const next = new Set(selectedRefs);
    const ref = refOf(model);
    if (next.has(ref)) next.delete(ref);
    else next.add(ref);
    applySelection(next);
  };

  const save = async () => {
    setSaving(true);
    try {
      const enabledModels = patterns.length === 0 ? null : patterns;
      const res = await fetch("/api/pi-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabledModels }),
      });
      const d = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(d.error || `保存失败（HTTP ${res.status}）`);
      toast(patterns.length === 0 ? "当前未做选择：全部模型都会出现在对话选择器里" : `已保存 ${patterns.length} 个模型，新会话生效`);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/models/refresh", { method: "POST" });
      const d = (await res.json()) as { error?: string; added?: number; errors?: { provider: string; message: string }[] };
      if (!res.ok) throw new Error(d.error || `刷新失败（HTTP ${res.status}）`);
      await loadModels();
      const added = d.added ?? 0;
      const failed = d.errors?.length ?? 0;
      toast(
        added > 0
          ? `模型库已更新，新增 ${added} 个模型`
          : failed > 0
            ? `刷新完成，${failed} 个厂商失败`
            : "模型库已是最新",
      );
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  };

  const btn =
    "flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-line px-2.5 text-[12px] text-muted t-fast hover:text-fg disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <Card testId="model-scope-editor">
      <CardHeader>
        <CardTitle>模型库</CardTitle>
        <span className="text-[11px] text-dim">
          {loading ? "加载中…" : scoped ? `已选 ${selectedRefs.size} / 共 ${models.length}` : `全部 ${models.length} 个`}
          {" · "}
          {formatAgo(checkedAt)}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <button onClick={() => void refresh()} disabled={refreshing || loading} className={btn} title="向 pi.dev 拉取厂商最新模型目录">
            {refreshing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} 刷新模型库
          </button>
          <button
            onClick={() => void save()}
            disabled={loading || saving}
            data-testid="model-scope-save"
            className="btn btn-primary"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} 保存
          </button>
        </div>
      </CardHeader>

      <div className="px-4 pt-3 text-[11px] leading-relaxed text-dim">
        勾选的模型会出现在对话的模型选择器里；未勾选的保留在库中，不用管。
      </div>

      <div className="flex flex-wrap items-center gap-2 px-4 pt-2">
        <div className="relative min-w-48 flex-1">
          <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-dim" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索模型，如 deepseek、glm…"
            className="h-8 w-full rounded-md border border-line bg-panel-2 pl-7 pr-2.5 text-[12px] text-fg outline-none focus:border-accent/50"
          />
        </div>
        <button
          onClick={() => applySelection(new Set(models.map(refOf)))}
          disabled={loading || models.length === 0}
          className={btn}
          title="勾选全部模型；保存后它们都会出现在对话的模型选择器里。"
        >
          全选
        </button>
      </div>

      <div className="max-h-[22rem] overflow-y-auto px-4 py-3">
        {loading && (
          <div className="flex items-center gap-2 py-4 text-[12px] text-dim">
            <Loader2 size={14} className="animate-spin" /> 加载模型库…
          </div>
        )}
        {!loading && groups.length === 0 && (
          <div className="py-4 text-[12px] text-dim">
            {loadError
              ? `模型库加载失败：${loadError}`
              : models.length === 0
                ? "没有可用模型，请先在下方配置厂商密钥。"
                : onlyFailing
                  ? "没有标出故障的模型——再看全部请关掉「只看有故障」。"
                  : "没有匹配的模型"}
          </div>
        )}
        {!loading &&
          groups.map(([provider, list]) => (
            <div key={provider} className="border-t border-line-soft py-1.5 first:border-t-0">
              <div className="flex items-center gap-2 py-1">
                <span className="label-micro uppercase text-dim">{provider}</span>
                <span className="text-[11px] text-dim">
                  {list.filter((m) => selectedRefs.has(refOf(m))).length}/{list.length} 可选
                </span>
                <button
                  onClick={() => {
                    const next = new Set(selectedRefs);
                    const allOn = list.every((m) => next.has(refOf(m)));
                    for (const m of list) {
                      if (allOn) next.delete(refOf(m));
                      else next.add(refOf(m));
                    }
                    applySelection(next);
                  }}
                  className="ml-auto cursor-pointer text-[11px] text-muted t-fast hover:text-accent"
                >
                  切换本组
                </button>
              </div>
              {list.map((m) => {
                const ref = refOf(m);
                const on = selectedRefs.has(ref);
                const isDefault = ref === defaultRef;
                const note = notes[ref]?.note;
                /* 行内故障标：健康数据下沉到模型行（变体 C 的核心），不再靠页底的独立面板 */
                const failingSummary = lookupModelHealth(health, m.provider, m.id);
                const failing = failingSummary?.status === "failing";
                const editing = editingRef === ref;
                return (
                  <div
                    key={ref}
                    data-testid="model-row"
                    data-failing={failing ? "true" : "false"}
                    className="group rounded-md t-fast hover:bg-hover"
                  >
                    <div className="flex w-full items-center gap-2 px-2 py-1.5">
                      <button
                        onClick={() => toggle(m)}
                        className={cn(
                          "flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left",
                          on ? "text-fg" : "text-dim",
                        )}
                      >
                        <span
                          className={cn(
                            "flex size-3.5 shrink-0 items-center justify-center rounded-sm border",
                            on ? "border-accent bg-accent text-accent-fg" : "border-line",
                          )}
                        >
                          {on && <Check size={10} />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12px]">{m.name || m.id}</span>
                          {/* 备注就该在选型路径上——藏在详情里等于没写 */}
                          {note && (
                            <span className="mt-0.5 block truncate text-[11px] text-dim" title={note}>
                              {note}
                            </span>
                          )}
                        </span>
                        {failing && failingSummary && (
                          <span
                            data-testid="model-failing-badge"
                            className="chip chip-danger shrink-0"
                            title={`近期有故障：${failingModelNote(failingSummary)}`}
                          >
                            {failingBadgeText(failingSummary)}
                          </span>
                        )}
                        {isDefault && <span className="chip chip-accent shrink-0">默认</span>}
                        <span className="shrink-0 font-mono text-[11px] text-dim">{m.id}</span>
                      </button>
                      <button
                        onClick={() => openNoteEditor(ref, note ?? "")}
                        title={note ? "编辑备注" : "加备注（擅长什么 / 贵不贵）"}
                        aria-label={note ? `编辑 ${m.name || m.id} 的备注` : `为 ${m.name || m.id} 添加备注`}
                        data-testid={`model-note-edit-${ref}`}
                        className={cn(
                          "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-dim t-fast hover:bg-panel-2 hover:text-fg",
                          note ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                        )}
                      >
                        <Pencil size={12} />
                      </button>
                    </div>
                    {editing && (
                      <div className="flex items-center gap-1.5 pb-2 pl-6 pr-2">
                        <input
                          autoFocus
                          value={noteDraft}
                          onChange={(e) => setNoteDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                              e.preventDefault();
                              void commitNote(m.provider, m.id, noteDraft);
                            } else if (e.key === "Escape") {
                              setEditingRef(null);
                              setNoteDraft("");
                            }
                          }}
                          maxLength={NOTE_MAX}
                          spellCheck={false}
                          data-testid={`model-note-input-${ref}`}
                          placeholder="备注：擅长什么 / 贵不贵（回车保存，Esc 取消）"
                          className="h-7 min-w-0 flex-1 rounded-md border border-line bg-panel-2 px-2.5 text-[12px] text-fg outline-none focus:border-accent/50"
                        />
                        <span className="shrink-0 text-[11px] text-dim">
                          {Array.from(noteDraft).length}/{NOTE_MAX}
                        </span>
                        <button
                          onClick={() => void commitNote(m.provider, m.id, noteDraft)}
                          disabled={savingNote}
                          data-testid={`model-note-save-${ref}`}
                          className="btn btn-sm btn-primary"
                        >
                          保存
                        </button>
                        {note && (
                          <button
                            onClick={() => void commitNote(m.provider, m.id, "")}
                            disabled={savingNote}
                            className="btn btn-sm btn-subtle"
                          >
                            清除
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
      </div>

      <div className="space-y-2 border-t border-line-soft px-4 py-3">
        {scoped && shownDefaultRef && !selectedRefs.has(shownDefaultRef) && (
          <div className="rounded-md bg-danger/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-danger">
            当前默认模型（{shownDefaultRef}）不在已选模型里，新会话会落到已选模型中的第一个。
          </div>
        )}

        <button
          onClick={() => setAdvancedOpen((v) => !v)}
          className="cursor-pointer text-[11px] text-muted t-fast hover:text-fg"
        >
          {advancedOpen ? "收起高级" : "高级：用通配模式筛选"}
        </button>

        {advancedOpen && (
          <div className="space-y-2">
            {globPatterns.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {globPatterns.map((p) => (
                  <span key={p} className="chip chip-mono flex items-center gap-1">
                    {p}
                    <button
                      onClick={() => setPatterns((prev) => prev.filter((x) => x !== p))}
                      className="cursor-pointer text-dim t-fast hover:text-danger"
                      aria-label={`移除模式 ${p}`}
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <input
                value={patternDraft}
                onChange={(e) => setPatternDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
                  const p = patternDraft.trim();
                  if (!p) return;
                  setPatterns((prev) => (prev.includes(p) ? prev : [...prev, p]));
                  setPatternDraft("");
                }}
                spellCheck={false}
                placeholder="如 deepseek/* 或 glm-* ，回车添加"
                className="h-8 flex-1 rounded-md border border-line bg-panel-2 px-2.5 font-mono text-[12px] text-fg outline-none focus:border-accent/50"
              />
              <button
                onClick={() => {
                  const p = patternDraft.trim();
                  if (!p) return;
                  setPatterns((prev) => (prev.includes(p) ? prev : [...prev, p]));
                  setPatternDraft("");
                }}
                disabled={!patternDraft.trim()}
                className={btn}
              >
                <Plus size={12} /> 添加
              </button>
            </div>
            <div className="text-[11px] leading-relaxed text-dim">
              <code className="font-mono">provider/*</code> 匹配整个厂商，<code className="font-mono">glm-*</code> 按模型名通配，
              <code className="font-mono">:high</code> 等后缀可为匹配到的模型固定推理强度。保存后新会话生效。
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
