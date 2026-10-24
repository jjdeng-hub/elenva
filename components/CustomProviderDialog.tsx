"use client";

import { AlertTriangle, Check, Download, Loader2, Plus, Search, Server, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/components/lib/utils";
import { toast } from "@/components/ui/dialog";

/**
 * 自定义模型（中转站 / 自建网关）接入对话框。
 *
 * 为什么要有：`models.json` 一直是唯一能接中转站的地方，但界面上只能编辑**已存在**的
 * provider —— 没有「新增」入口，也改不了 `models` 列表（拉回来的模型只显示不落盘）。
 * 于是换个中转厂商就得手改 JSON。这里把一条完整链路收进一个对话框：
 * 名称 / Base URL / 协议 / Key → 拉取网关模型列表（或手填 ID）→ 勾选 → 保存进 models.json。
 *
 * 注意：`models` 只写 `id` / `name`，其余字段（contextWindow、compat…）原样保留，
 * 手改过的 models.json 不会被这个对话框抹掉。
 */

export type CustomModelDef = {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  [key: string]: unknown;
};

export type CustomProviderPatch = {
  baseUrl: string;
  api: string;
  apiKey?: string;
  models: CustomModelDef[];
};

export interface CustomProviderSource {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  models?: CustomModelDef[];
}

const API_OPTIONS = [
  { value: "openai-completions", label: "OpenAI 兼容", hint: "绝大多数中转站 / vLLM / Ollama" },
  { value: "openai-responses", label: "OpenAI Responses", hint: "支持 /v1/responses 的网关" },
  { value: "anthropic-messages", label: "Anthropic 兼容", hint: "Claude 协议中转" },
  { value: "google-generative-ai", label: "Gemini 兼容", hint: "Google 协议中转" },
] as const;

const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function modelIdOf(model: CustomModelDef): string {
  return typeof model.id === "string" ? model.id : "";
}

function validBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function hasImageInput(model: CustomModelDef): boolean {
  return Array.isArray(model.input) && model.input.includes("image");
}

function formatWindow(tokens: number): string {
  return tokens >= 1_000_000 ? `${+(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1000)}K`;
}

/** 列表行右侧的参数摘要：200K · 图像 · 推理 */
function paramSummary(model: CustomModelDef): string {
  const parts: string[] = [];
  if (typeof model.contextWindow === "number" && model.contextWindow > 0) {
    parts.push(formatWindow(model.contextWindow));
  }
  if (hasImageInput(model)) parts.push("图像");
  if (model.reasoning) parts.push("推理");
  return parts.join(" · ");
}

function ParamToggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={cn(
        "relative h-5 w-9 shrink-0 cursor-pointer rounded-full t-fast",
        on ? "bg-accent" : "bg-line",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow-sm t-base",
          on ? "translate-x-4" : "translate-x-0",
        )}
      />
    </button>
  );
}

export function CustomProviderDialog({
  open,
  mode,
  providerName,
  provider,
  existingNames,
  onClose,
  onSave,
}: {
  open: boolean;
  mode: "create" | "edit";
  /** 编辑时是原有 provider id；新增时可作为预填名 */
  providerName?: string;
  provider?: CustomProviderSource;
  existingNames: string[];
  onClose: () => void;
  onSave: (
    name: string,
    patch: CustomProviderPatch,
  ) => Promise<{ scopeAdded?: number; scopeError?: string } | void>;
}) {
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [api, setApi] = useState<string>(API_OPTIONS[0].value);
  const [apiKey, setApiKey] = useState("");
  const [known, setKnown] = useState<CustomModelDef[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [manualId, setManualId] = useState("");
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedModel, setExpandedModel] = useState<string | null>(null);
  /* 全局压缩预留：上下文窗口 ≤ 预留时压缩会每轮触发，展开模型参数时用来提醒 */
  const [reserveTokens, setReserveTokens] = useState<number | null>(null);

  /* 每次打开都从当前配置重置，避免上一次的草稿串到下一次 */
  useEffect(() => {
    if (!open) return;
    const models = provider?.models ?? [];
    setName(providerName ?? "");
    setBaseUrl(provider?.baseUrl ?? "");
    setApi(provider?.api ?? API_OPTIONS[0].value);
    setApiKey(provider?.apiKey ?? "");
    setKnown(models.filter((model) => modelIdOf(model)));
    setSelected(models.map(modelIdOf).filter(Boolean));
    setQuery("");
    setManualId("");
    setDiscoverError(null);
    setError(null);
    setExpandedModel(null);
  }, [open, providerName, provider]);

  useEffect(() => {
    if (!open) return;
    fetch("/api/pi-settings", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { settings?: { compaction?: { enabled?: boolean; reserveTokens?: number } } }) => {
        const compaction = d.settings?.compaction;
        setReserveTokens(
          compaction?.enabled === false || typeof compaction?.reserveTokens !== "number"
            ? null
            : compaction.reserveTokens,
        );
      })
      .catch(() => setReserveTokens(null));
  }, [open]);

  const editing = mode === "edit";
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const filteredModels = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? known.filter((model) => `${model.id} ${model.name ?? ""}`.toLowerCase().includes(q)) : known;
  }, [known, query]);

  const toggle = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((entry) => entry !== id) : [...prev, id]));
  };

  /** 改单个模型的参数；传 undefined 表示删掉该字段（回到内核默认） */
  const patchModel = (id: string, patch: Partial<CustomModelDef>) => {
    setKnown((prev) => prev.map((model) => {
      if (model.id !== id) return model;
      const next = { ...model, ...patch };
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete next[key];
      }
      return next;
    }));
  };

  const setModelNumber = (id: string, key: "contextWindow" | "maxTokens", raw: string) => {
    if (!raw.trim()) {
      patchModel(id, { [key]: undefined });
      return;
    }
    const value = Number(raw);
    patchModel(id, { [key]: Number.isFinite(value) ? value : undefined });
  };

  const addManual = () => {
    const id = manualId.trim();
    if (!id) return;
    if (!selectedSet.has(id)) setSelected((prev) => [...prev, id]);
    setKnown((prev) => (prev.some((model) => model.id === id) ? prev : [...prev, { id }]));
    setManualId("");
  };

  const discover = async () => {
    const url = baseUrl.trim();
    if (!validBaseUrl(url)) {
      setDiscoverError("先填一个有效的 Base URL（http:// 或 https://）");
      return;
    }
    setDiscovering(true);
    setDiscoverError(null);
    try {
      const res = await fetch("/api/models-config/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerName: name.trim() || "custom",
          provider: {
            baseUrl: url,
            api,
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          },
        }),
      });
      const data = (await res.json()) as {
        models?: { id: string; name?: string }[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || `拉取失败（HTTP ${res.status}）`);
      const found = (data.models ?? []).filter((model) => model.id);
      if (found.length === 0) throw new Error("网关没有返回任何模型");
      setKnown((prev) => {
        const byId = new Map(prev.map((model) => [model.id, model]));
        for (const model of found) byId.set(model.id, { ...byId.get(model.id), ...model });
        return [...byId.values()];
      });
      // 第一次拉取（还没选任何模型）时默认全选，省掉逐个勾；编辑时只补充候选、不动已选
      setSelected((prev) => (prev.length > 0 ? prev : found.map((model) => model.id)));
      toast(`发现 ${found.length} 个模型`);
    } catch (e) {
      setDiscoverError(e instanceof Error ? e.message : String(e));
    } finally {
      setDiscovering(false);
    }
  };

  const save = async () => {
    const id = name.trim();
    if (!editing && !PROVIDER_ID_RE.test(id)) {
      setError("名称只能用字母、数字、点、下划线、短横线，且不能以符号开头");
      return;
    }
    if (!editing && existingNames.includes(id)) {
      setError(`已存在同名厂商「${id}」，换个名字，或直接编辑它`);
      return;
    }
    const url = baseUrl.trim();
    if (!validBaseUrl(url)) {
      setError("Base URL 必须是有效的 http:// 或 https:// 地址");
      return;
    }
    if (selected.length === 0) {
      setError("至少选一个模型（拉取列表或手动填模型 ID）");
      return;
    }

    // 只覆盖本对话框管理的字段；手改过的 contextWindow / compat 等原样带回
    const byId = new Map(known.map((model) => [model.id, model]));
    const models = selected.map((modelId) => {
      const { id: _ignored, ...rest } = byId.get(modelId) ?? { id: modelId };
      const next: CustomModelDef = { ...rest, id: modelId };
      if (!next.name) delete next.name;
      return next;
    });

    for (const model of models) {
      const label = model.name ?? model.id;
      if (model.contextWindow !== undefined
        && (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0)) {
        setError(`「${label}」的上下文窗口必须是正整数（tokens）`);
        return;
      }
      if (model.maxTokens !== undefined
        && (!Number.isSafeInteger(model.maxTokens) || model.maxTokens <= 0)) {
        setError(`「${label}」的最大输出必须是正整数（tokens）`);
        return;
      }
    }

    setSaving(true);
    setError(null);
    try {
      const result = await onSave(id, {
        baseUrl: url,
        api,
        models,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      let message = editing
        ? `已保存「${id}」`
        : `已接入「${id}」，共 ${models.length} 个模型`;
      if (result?.scopeAdded) message += ` · ${result.scopeAdded} 个已加入模型库`;
      if (result?.scopeError) message += ` · 加入模型库失败：${result.scopeError}`;
      toast(message);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-[120] flex items-center justify-center bg-overlay p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={editing ? "编辑自定义模型" : "接入自定义模型"}
        data-testid="custom-provider"
        className="flex max-h-[88vh] w-[680px] max-w-full flex-col overflow-hidden rounded-card border border-line bg-panel shadow-lg"
      >
        <div className="flex items-center gap-2.5 border-b border-line-soft px-5 py-3.5">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-card bg-accent-soft text-accent">
            <Server size={16} />
          </div>
          <div className="min-w-0">
            <div className="text-[14px] font-bold text-fg">{editing ? `编辑「${providerName}」` : "接入自定义模型"}</div>
            <div className="truncate text-[11px] text-dim">
              中转站 / 自建网关 · 写入 ~/.pi/agent/models.json，保存后即可在模型选择器里选
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={saving}
            aria-label="关闭"
            className="btn btn-icon btn-subtle ml-auto shrink-0"
          >
            <X size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-[11px] text-dim">名称</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={editing}
                placeholder="如 myrelay"
                className="h-8 w-full rounded-md border border-line bg-panel-2 px-2.5 font-mono text-[12px] text-fg outline-none focus:border-accent/50 disabled:text-dim"
              />
              <span className="mt-1 block text-[11px] text-dim">模型在界面里显示为「名称 / 模型 ID」</span>
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] text-dim">协议</span>
              <select
                value={api}
                onChange={(e) => setApi(e.target.value)}
                className="h-8 w-full cursor-pointer rounded-md border border-line bg-panel-2 px-2 text-[12px] text-fg outline-none focus:border-accent/50"
              >
                {API_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label} · {option.hint}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-[11px] text-dim">中转站绝大多数是 OpenAI 兼容</span>
            </label>
          </div>

          <label className="mt-3 block">
            <span className="mb-1 block text-[11px] text-dim">Base URL</span>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://your-relay.com/v1"
              className="h-8 w-full rounded-md border border-line bg-panel-2 px-2.5 font-mono text-[12px] text-fg outline-none focus:border-accent/50"
            />
            <span className="mt-1 block text-[11px] text-dim">
              以厂商文档为准；一般到 /v1 为止，不要带 /chat/completions
            </span>
          </label>

          <label className="mt-3 block">
            <span className="mb-1 block text-[11px] text-dim">API Key</span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={editing ? "留空则保留原有密钥" : "sk-…（本地网关可留空）"}
              className="h-8 w-full rounded-md border border-line bg-panel-2 px-2.5 font-mono text-[12px] text-fg outline-none focus:border-accent/50"
            />
            <span className="mt-1 block text-[11px] text-dim">
              以明文写入本机 models.json（文件权限 0600）；也可以用 $ENV_VAR 引用环境变量
            </span>
          </label>

          {/* 模型列表 */}
          <div className="mt-4 rounded-lg border border-line bg-panel-2">
            <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-3 py-2">
              <span className="text-[12px] font-semibold text-fg">模型</span>
              <span className="text-[11px] text-dim">已选 {selected.length} 个</span>
              <div className="ml-auto flex items-center gap-1.5">
                <button
                  onClick={() => setSelected(filteredModels.map((model) => model.id))}
                  disabled={known.length === 0}
                  className="btn btn-sm btn-subtle"
                >
                  全选
                </button>
                <button
                  onClick={() => setSelected([])}
                  disabled={selected.length === 0}
                  className="btn btn-sm btn-subtle"
                >
                  清空
                </button>
                <button
                  onClick={() => void discover()}
                  disabled={discovering}
                  data-testid="discover-models"
                  className="btn btn-sm btn-ghost"
                  title="请求该网关的 /models 端点，列出实际可用的模型"
                >
                  {discovering ? <Loader2 size={12} className="anim-spin" /> : <Download size={12} />}
                  拉取模型列表
                </button>
              </div>
            </div>

            {discoverError && (
              <div className="border-b border-line-soft px-3 py-2 text-[12px] text-danger">{discoverError}</div>
            )}

            {known.length > 8 && (
              <div className="flex h-8 items-center gap-2 border-b border-line-soft px-3 text-dim">
                <Search size={12} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="筛选模型 ID"
                  className="w-full bg-transparent text-[12px] text-fg outline-none placeholder:text-dim"
                />
              </div>
            )}

            <div className="max-h-64 overflow-y-auto p-1">
              {known.length === 0 && (
                <div className="px-2 py-3 text-[12px] leading-relaxed text-dim">
                  还没有模型。先点右上角「拉取模型列表」；网关不提供 /models 时，在下面手动填模型 ID。
                </div>
              )}
              {filteredModels.map((model) => {
                const on = selectedSet.has(model.id);
                const expanded = expandedModel === model.id;
                const summary = paramSummary(model);
                const effectiveWindow = model.contextWindow ?? 128000;
                const reserveLabel = reserveTokens === null ? "" : formatWindow(reserveTokens);
                const windowTooSmall = reserveTokens !== null && effectiveWindow <= reserveTokens;
                return (
                  <div key={model.id} className="rounded-md t-fast hover:bg-hover">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => toggle(model.id)}
                        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 py-1.5 text-left"
                      >
                        <span
                          className={cn(
                            "flex size-4 shrink-0 items-center justify-center rounded-sm border",
                            on ? "border-accent bg-accent text-accent-fg" : "border-line bg-panel text-transparent",
                          )}
                        >
                          <Check size={10} />
                        </span>
                        <span className="shrink-0 font-mono text-[12px] text-fg">{model.id}</span>
                        {model.name && model.name !== model.id && (
                          <span className="truncate text-[11px] text-dim">{model.name}</span>
                        )}
                      </button>
                      {summary && <span className="shrink-0 text-[10px] text-dim">{summary}</span>}
                      <button
                        onClick={() => setExpandedModel(expanded ? null : model.id)}
                        aria-label={`模型参数：${model.id}`}
                        aria-expanded={expanded}
                        title="模型参数（上下文 / 输出 / 图像 / 推理）"
                        className={cn("btn btn-icon btn-subtle mr-1 size-6 shrink-0", expanded && "text-accent")}
                      >
                        <SlidersHorizontal size={12} />
                      </button>
                    </div>
                    {expanded && (
                      <div className="mx-1 mb-1.5 rounded-md border border-line bg-panel px-2.5 py-2">
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          <div>
                            <label className="block">
                              <span className="mb-1 block text-[11px] text-dim">上下文窗口（tokens）</span>
                              <input
                                type="number"
                                min={1}
                                step={1000}
                                value={model.contextWindow ?? ""}
                                onChange={(e) => setModelNumber(model.id, "contextWindow", e.target.value)}
                                placeholder="默认 128000"
                                className="h-7 w-full rounded-md border border-line bg-panel-2 px-2 font-mono text-[12px] text-fg outline-none focus:border-accent/50"
                              />
                            </label>
                            <div className="mt-1 flex items-center gap-1.5 text-[10px] text-dim">
                              <span>常用</span>
                              {[128000, 200000, 1000000].map((value) => (
                                <button
                                  key={value}
                                  onClick={() => patchModel(model.id, { contextWindow: value })}
                                  className="cursor-pointer text-accent hover:underline"
                                >
                                  {formatWindow(value)}
                                </button>
                              ))}
                            </div>
                          </div>
                          <label className="block">
                            <span className="mb-1 block text-[11px] text-dim">最大输出（tokens）</span>
                            <input
                              type="number"
                              min={1}
                              step={1000}
                              value={model.maxTokens ?? ""}
                              onChange={(e) => setModelNumber(model.id, "maxTokens", e.target.value)}
                              placeholder="默认 16384"
                              className="h-7 w-full rounded-md border border-line bg-panel-2 px-2 font-mono text-[12px] text-fg outline-none focus:border-accent/50"
                            />
                            <span className="mt-1 block text-[10px] text-dim">单轮回复上限，留空 = 内核默认</span>
                          </label>
                          <div className="flex items-center justify-between gap-2 rounded-md border border-line bg-panel-2 px-2 py-1.5">
                            <span className="text-[12px] text-fg">图像输入</span>
                            <ParamToggle
                              on={hasImageInput(model)}
                              onChange={(next) => patchModel(model.id, { input: next ? ["text", "image"] : undefined })}
                              label={`${model.id} 支持图像输入`}
                            />
                          </div>
                          <div className="flex items-center justify-between gap-2 rounded-md border border-line bg-panel-2 px-2 py-1.5">
                            <span className="text-[12px] text-fg">推理模型</span>
                            <ParamToggle
                              on={Boolean(model.reasoning)}
                              onChange={(next) => patchModel(model.id, { reasoning: next ? true : undefined })}
                              label={`${model.id} 是推理模型`}
                            />
                          </div>
                        </div>
                        <div className="mt-1.5 text-[10px] leading-relaxed text-dim">
                          留空 = 内核默认（上下文 128000 / 输出 16384）。推理开关决定是否暴露思考档位，部分中转不支持相关字段时报错就关掉。
                          上下文窗口在会话启动时读取，改完要新会话（或旧会话空闲回收后重开）才生效。
                        </div>
                        {windowTooSmall && (
                          <div className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-relaxed text-warn">
                            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                            <span>
                              有效上下文 {formatWindow(effectiveWindow)} ≤ 全局压缩预留 {reserveLabel}，压缩会每轮触发。
                              把窗口填大，或到设置页调小 compaction.reserveTokens。
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {known.length > 0 && filteredModels.length === 0 && (
                <div className="px-2 py-3 text-[12px] text-dim">没有匹配的模型</div>
              )}
            </div>

            <div className="flex items-center gap-2 border-t border-line-soft px-3 py-2">
              <input
                value={manualId}
                onChange={(e) => setManualId(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addManual();
                  }
                }}
                placeholder="手动添加模型 ID，如 gpt-4o-mini"
                className="h-7 min-w-0 flex-1 rounded-md border border-line bg-panel px-2 font-mono text-[12px] text-fg outline-none focus:border-accent/50"
              />
              <button onClick={addManual} disabled={!manualId.trim()} className="btn btn-sm btn-ghost shrink-0">
                <Plus size={12} /> 添加
              </button>
            </div>
          </div>

          {error && (
            <div className="mt-3 rounded-md bg-danger/10 px-2.5 py-1.5 text-[12px] text-danger">{error}</div>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-line-soft bg-panel-2/60 px-5 py-3">
          <span className="text-[11px] text-dim">
            {editing ? "留空 / 关闭 = 跟随内核默认；新会话生效" : "留空 / 关闭 = 跟随内核默认；保存后新会话生效"}
          </span>
          <button onClick={onClose} disabled={saving} className="btn btn-subtle ml-auto">
            取消
          </button>
          <button
            onClick={() => void save()}
            disabled={saving}
            data-testid="custom-provider-save"
            className="btn btn-primary"
          >
            {saving ? <Loader2 size={12} className="anim-spin" /> : <Check size={12} />} 保存
          </button>
        </div>
      </div>
    </div>
  );
}
