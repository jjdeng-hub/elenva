"use client";

import { Check, Loader2, Plus, RefreshCw, Save, Search, X } from "lucide-react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "@/components/lib/utils";
import { toast } from "@/components/ui/dialog";

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
export function ModelScopeEditor() {
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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q),
    );
  }, [models, query]);

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
                : "没有匹配的模型"}
          </div>
        )}
        {!loading &&
          groups.map(([provider, list]) => (
            <div key={provider} className="border-t border-line-soft py-1.5 first:border-t-0">
              <div className="flex items-center gap-2 py-1">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-dim">{provider}</span>
                <span className="text-[11px] text-dim">
                  {list.filter((m) => selectedRefs.has(refOf(m))).length}/{list.length}
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
                return (
                  <button
                    key={ref}
                    onClick={() => toggle(m)}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left t-fast hover:bg-hover",
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
                    <span className="min-w-0 flex-1 truncate text-[12px]">{m.name || m.id}</span>
                    {isDefault && <span className="chip chip-accent shrink-0">默认</span>}
                    <span className="shrink-0 font-mono text-[11px] text-dim">{m.id}</span>
                  </button>
                );
              })}
            </div>
          ))}
      </div>

      <div className="space-y-2 border-t border-line-soft px-4 py-3">
        {scoped && defaultRef && !selectedRefs.has(defaultRef) && (
          <div className="rounded-md bg-danger/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-danger">
            当前默认模型（{defaultRef}）不在已选模型里，新会话会落到已选模型中的第一个。
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
