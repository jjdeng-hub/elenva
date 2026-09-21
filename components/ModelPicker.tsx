"use client";

import { Check, ChevronDown, Cpu, Loader2, RefreshCw, Star, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@/components/ui/dialog";
import { cn } from "@/components/lib/utils";
import type { ThinkingLevelOption } from "@/hooks/useAgentSession";

type ModelEntry = { id: string; name: string; provider: string };
type Defaults = { defaultProvider?: string; defaultModel?: string; defaultThinkingLevel?: string };

export function ModelPicker({
  modelList,
  displayModel,
  modelNames,
  switching,
  thinkingLevel,
  thinkingLevels,
  onModelChange,
  onThinkingLevelChange,
  onReloadModels,
}: {
  modelList: ModelEntry[];
  displayModel: { provider: string; modelId: string } | null;
  modelNames: Record<string, string>;
  switching: boolean;
  thinkingLevel: string;
  thinkingLevels: string[];
  onModelChange: (provider: string, modelId: string) => void;
  onThinkingLevelChange: (level: ThinkingLevelOption) => void;
  /** 刷新模型库后重新拉取列表（由 useAgentSession 的 loadModels 提供）。 */
  onReloadModels?: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [defaults, setDefaults] = useState<Defaults>({});
  const [savingDefault, setSavingDefault] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  const loadDefaults = useCallback(() => {
    fetch("/api/pi-settings", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setDefaults(d?.settings ?? {}))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (open) loadDefaults();
  }, [open, loadDefaults]);

  const refreshModels = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/models/refresh", { method: "POST" });
      const d = (await res.json()) as { error?: string; added?: number };
      if (!res.ok) throw new Error(d.error || `刷新失败（HTTP ${res.status}）`);
      await onReloadModels?.();
      toast((d.added ?? 0) > 0 ? `模型库已更新，新增 ${d.added} 个模型` : "模型库已是最新");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }, [onReloadModels]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const currentKey = displayModel ? `${displayModel.provider}/${displayModel.modelId}` : null;
  const currentName = displayModel
    ? modelNames[currentKey!] || displayModel.modelId
    : "自动选择";

  const q = query.trim().toLowerCase();
  const filtered = q
    ? modelList.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          m.id.toLowerCase().includes(q) ||
          m.provider.toLowerCase().includes(q),
      )
    : modelList;

  // 按 provider 分组
  const groups = useMemo(() => {
    const map = new Map<string, ModelEntry[]>();
    for (const m of filtered) {
      const list = map.get(m.provider) ?? [];
      list.push(m);
      map.set(m.provider, list);
    }
    return [...map.entries()];
  }, [filtered]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 max-w-64 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-[12px] text-muted t-fast hover:bg-hover hover:text-fg"
      >
        {switching ? (
          <Loader2 size={12} className="animate-spin text-accent" />
        ) : (
          <Cpu size={12} className="shrink-0 text-dim" />
        )}
        {/* 文字标签去掉：Cpu 图标 + 模型名已经表意，省下的宽度留给长模型名 */}
        <span className="truncate">{currentName}</span>
        <ChevronDown size={12} className={cn("shrink-0 text-dim transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="absolute bottom-9 right-0 z-50 w-80 overflow-hidden rounded-card border border-line bg-panel shadow-lg">
          <div className="flex items-center gap-1.5 border-b border-line-soft p-2">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索模型…"
              className="min-w-0 flex-1 rounded-md bg-panel-2 px-2.5 py-1.5 text-[12px] text-fg outline-none placeholder:text-dim"
            />
            <button
              onClick={() => void refreshModels()}
              disabled={refreshing}
              title="向 pi.dev 拉取厂商最新模型目录"
              aria-label="刷新模型库"
              className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-dim t-fast hover:bg-hover hover:text-fg disabled:opacity-50"
            >
              {refreshing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            </button>
          </div>
          <div className="max-h-80 overflow-y-auto py-1">
            {groups.length === 0 && (
              <div className="px-3 py-6 text-center text-[12px] text-dim">没有匹配的模型</div>
            )}
            {groups.map(([provider, models]: [string, ModelEntry[]]) => (
              <div key={provider}>
                <div className="px-3 pb-0.5 pt-2 text-[11px] font-semibold uppercase tracking-wide text-dim">
                  {provider}
                </div>
                {models.map((m) => {
                  const key = `${m.provider}/${m.id}`;
                  const active = key === currentKey;
                  return (
                    <button
                      key={key}
                      onClick={() => {
                        onModelChange(m.provider, m.id);
                        setOpen(false);
                      }}
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[12px] t-fast hover:bg-hover",
                        active ? "text-accent" : "text-fg",
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">{m.name || m.id}</span>
                      {active && <Check size={14} className="shrink-0" />}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          {/* 推理强度已提为工具行里的常驻 ThinkingPicker（避免两处控制同一件事） */}

          {/* 启动默认（对应 CLI 选择器 Ctrl+S）：写入 settings.json 的 defaultProvider/defaultModel/defaultThinkingLevel */}
          {displayModel && (
            <div className="flex items-center gap-2 border-t border-line-soft px-3 py-2">
              {defaults.defaultModel === displayModel.modelId && defaults.defaultProvider === displayModel.provider ? (
                <span className="flex items-center gap-1 text-[11px] text-accent">
                  <Star size={12} className="fill-current" />
                  当前选择已是启动默认
                </span>
              ) : (
                <button
                  onClick={async () => {
                    setSavingDefault(true);
                    try {
                      const body: Defaults = {
                        defaultProvider: displayModel.provider,
                        defaultModel: displayModel.modelId,
                      };
                      if (thinkingLevel !== "auto") body.defaultThinkingLevel = thinkingLevel;
                      const res = await fetch("/api/pi-settings", {
                        method: "PUT",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(body),
                      });
                      const d = (await res.json()) as { error?: string };
                      if (!res.ok) throw new Error(d.error || "保存失败");
                      toast("已设为启动默认，新会话生效");
                      loadDefaults();
                    } catch (e) {
                      toast(e instanceof Error ? e.message : String(e));
                    } finally {
                      setSavingDefault(false);
                    }
                  }}
                  disabled={savingDefault}
                  className="flex cursor-pointer items-center gap-1 text-[11px] text-muted t-fast hover:text-fg disabled:opacity-50"
                >
                  {savingDefault ? <Loader2 size={12} className="animate-spin" /> : <Star size={12} />}
                  设为启动默认{thinkingLevels.length > 0 && thinkingLevel !== "auto" ? `（含推理强度 ${thinkingLevel}）` : ""}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
