"use client";

import { ArrowDown, ArrowUp, Fingerprint, History, Loader2, Plus, RefreshCw, RotateCcw, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/components/lib/utils";
import { EmptyState, PageHeader } from "@/components/ui/bits";
import { toast, dialogConfirm } from "@/components/ui/dialog";
import { relTime } from "@/lib/format";

/**
 * 「身份」页：设计这个人。
 *
 * 宿主提示词里 `## 你是谁` 那一段现在是受管数据（`~/.pi/agent/elenva-identity.json`），
 * 这里分段编辑（段落名只是标签，不注入）→ 保存（旧值自动进版本历史）→ 右侧实时预览
 * 「下次新会话会看到的宿主层」→ 可查看 / 恢复任意历史版本。
 *
 * 数据层与校验在 lib/identity.ts；装配在 lib/host-prompt.ts。
 * 预览走 POST /api/host-prompt（复用真正的装配函数，不另写一套拼接逻辑）。
 */

type IdentitySection = { id: string; title: string; body: string };
type HistoryEntry = { id: string; savedAt: string; chars: number; sections: { id: string; title: string }[] };

type IdentityPayload = {
  source: "file" | "default" | "fallback";
  path: string;
  revision: string;
  version: number;
  updatedAt: string;
  sections: IdentitySection[];
  heading: string;
  chars: number;
  limit: number;
  sectionBodyLimit: number;
  titleLimit: number;
  maxSections: number;
  historyCap: number;
  defaultSections: IdentitySection[];
  history: HistoryEntry[];
  error?: string;
};

const SOURCE_LABEL: Record<IdentityPayload["source"], string> = {
  file: "已保存（来自文件）",
  default: "内置默认（文件尚未创建）",
  fallback: "文件损坏，当前用内置默认",
};

const textareaCls =
  "w-full resize-y rounded-lg border border-line bg-panel-2 p-3 text-[12px] leading-relaxed text-fg outline-none t-fast focus:border-accent/60 disabled:opacity-50";
const inputCls =
  "h-8 min-w-0 flex-1 rounded-lg border border-line bg-panel-2 px-2 text-[12px] text-fg outline-none t-fast focus:border-accent/60";

export function IdentityPage() {
  const [data, setData] = useState<IdentityPayload | null>(null);
  const [sections, setSections] = useState<IdentitySection[]>([]);
  const [revision, setRevision] = useState<string>("absent");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [previewAssembled, setPreviewAssembled] = useState("");
  const [previewBusy, setPreviewBusy] = useState(false);
  const [historyView, setHistoryView] = useState<{ id: string; savedAt: string; sections: IdentitySection[] } | null>(null);
  /** 最近一次「已落盘」的段落，用来判断是否 dirty */
  const savedRef = useRef<string>("[]");
  const previewSeq = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/identity", { cache: "no-store" });
      const d = (await res.json()) as IdentityPayload & { error?: string };
      if (!res.ok) throw new Error(d.error ?? "读取失败");
      setData(d);
      setSections(d.sections.map((s) => ({ ...s })));
      setRevision(d.revision);
      savedRef.current = JSON.stringify(d.sections);
      setHistoryView(null);
    } catch (error) {
      toast(`读取身份失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = useMemo(() => JSON.stringify(sections) !== savedRef.current, [sections]);

  /** 客户端字数：与 lib/identity.ts 的 buildIdentityText 同口径（标题 + 空行 + 各段正文） */
  const draftChars = useMemo(() => {
    if (!data) return 0;
    const bodies = sections.map((s) => s.body.trim()).filter(Boolean);
    if (bodies.length === 0) return 0;
    return data.heading.length + 2 + bodies.join("\n\n").length;
  }, [sections, data]);

  const emptyBodyIndex = sections.findIndex((s) => !s.body.trim());
  const overLimit = data ? draftChars > data.limit : false;
  const canSave = dirty && !saving && emptyBodyIndex < 0 && !overLimit;

  /* 生效预览：改动后 500ms 防抖，用服务端装配函数拼一遍 */
  useEffect(() => {
    if (loading || !data) return;
    const seq = ++previewSeq.current;
    const timer = setTimeout(async () => {
      setPreviewBusy(true);
      try {
        const res = await fetch("/api/host-prompt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identitySections: sections }),
        });
        const d = (await res.json()) as { assembled?: string };
        if (seq === previewSeq.current) setPreviewAssembled(d.assembled ?? "");
      } catch {
        // 预览失败不打扰（保存路径才是硬校验）
      } finally {
        if (seq === previewSeq.current) setPreviewBusy(false);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [sections, loading, data]);

  const update = (index: number, patch: Partial<IdentitySection>) =>
    setSections((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));

  const move = (index: number, dir: -1 | 1) =>
    setSections((prev) => {
      const next = [...prev];
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  const add = () =>
    setSections((prev) => [
      ...prev,
      { id: `custom-${Date.now().toString(36)}`, title: "新段落", body: "" },
    ]);

  const remove = async (index: number) => {
    const section = sections[index];
    if (section.body.trim()) {
      const ok = await dialogConfirm({
        title: `删除「${section.title || "未命名"}」？`,
        message: "只从当前编辑中移除；保存前仍可从版本历史恢复。",
        confirmText: "删除",
        danger: true,
      });
      if (!ok) return;
    }
    setSections((prev) => prev.filter((_, i) => i !== index));
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/identity", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sections, revision }),
      });
      const d = (await res.json()) as { ok?: boolean; error?: string; revision?: string; history?: HistoryEntry[] };
      if (!res.ok || !d.ok) {
        toast(d.error ?? "保存失败");
        if (res.status === 409) await load();
        return;
      }
      savedRef.current = JSON.stringify(sections);
      setRevision(d.revision ?? revision);
      if (d.history) setData((prev) => (prev ? { ...prev, history: d.history!, chars: draftChars, source: "file", error: undefined } : prev));
      toast("已保存 · 两端新建会话生效");
    } catch (error) {
      toast(`保存失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  };

  const viewHistory = async (id: string) => {
    try {
      const res = await fetch(`/api/identity?history=${encodeURIComponent(id)}`, { cache: "no-store" });
      const d = (await res.json()) as { id?: string; savedAt?: string; sections?: IdentitySection[]; error?: string };
      if (!res.ok || !d.sections) {
        toast(d.error ?? "读取历史版本失败");
        return;
      }
      setHistoryView({ id: d.id ?? id, savedAt: d.savedAt ?? "", sections: d.sections });
    } catch (error) {
      toast(`读取历史版本失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const restore = async (id: string, savedAt: string) => {
    const ok = await dialogConfirm({
      title: "恢复到这个版本？",
      message: `${savedAt ? relTime(savedAt) : id} 的旧值会写回为当前身份；恢复前会先快照当前值，所以这次恢复也能再撤回。`,
      confirmText: "恢复",
    });
    if (!ok) return;
    setRestoringId(id);
    try {
      const res = await fetch("/api/identity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restore", id, revision }),
      });
      const d = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !d.ok) {
        toast(d.error ?? "恢复失败");
        if (res.status === 409) await load();
        return;
      }
      toast("已恢复（当前值也已进历史，可再撤回）");
      await load();
    } catch (error) {
      toast(`恢复失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRestoringId(null);
    }
  };

  const fillDefault = async () => {
    if (!data) return;
    const ok = await dialogConfirm({
      title: "填入内置默认？",
      message: "把编辑区替换为内置默认文本（与改造前逐字一致）。需再点「保存」才会落盘。",
      confirmText: "填入",
    });
    if (!ok) return;
    setSections(data.defaultSections.map((s) => ({ ...s })));
    toast("已填入内置默认，点「保存」生效");
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-page-scroll>
      <div className="page-col-form py-6">
        <PageHeader
          icon={<Fingerprint size={16} />}
          title="身份"
          subtitle="设计这个人：分段编辑宿主提示词里的「你是谁」，有版本历史，边改边看生效预览"
          actions={
            <>
              <button onClick={() => void fillDefault()} disabled={loading} className="btn btn-sm btn-ghost">
                <RotateCcw size={12} /> 内置默认
              </button>
              <button onClick={() => void load()} disabled={loading || saving} className="btn btn-sm btn-ghost">
                <RefreshCw size={12} className={loading ? "anim-spin" : undefined} /> 刷新
              </button>
              <button onClick={() => void save()} disabled={!canSave} className="btn btn-primary btn-sm" data-testid="identity-save">
                {saving ? <Loader2 size={12} className="anim-spin" /> : <Save size={12} />} 保存
              </button>
            </>
          }
        />

        {loading && !data ? (
          <EmptyState icon={<Loader2 size={16} className="anim-spin" />} title="正在读取身份…" />
        ) : (
          <div className="flex flex-col gap-5 xl:flex-row xl:items-start">
            {/* 左：分段编辑 */}
            <div className="flex min-w-0 flex-1 flex-col gap-3">
              <Card>
                <CardHeader>
                  <Fingerprint size={14} className="text-accent" />
                  <CardTitle>身份段落</CardTitle>
                  <span className={cn("ml-auto text-[11px] tabular-nums", overLimit ? "text-danger" : "text-dim")}>
                    {draftChars} / {data?.limit ?? 0} 字符
                  </span>
                </CardHeader>
                <div className="flex flex-col gap-3 px-4 py-3.5">
                  <p className="text-[12px] leading-relaxed text-dim">
                    每段一个编辑框，顺序即注入顺序。段落名只用于编辑与历史列表，<span className="text-muted">不注入提示词</span>；
                    注入的是各段正文（空行分隔），再加固定标题 <span className="font-mono text-muted">{data?.heading}</span>。
                    {data?.source === "fallback" && (
                      <span className="mt-1 flex items-center gap-1 text-danger">
                        文件损坏，当前显示内置默认；保存会以默认值修复文件（损坏内容已进历史）。
                      </span>
                    )}
                  </p>
                  <p className="text-[12px] leading-relaxed text-dim" data-testid="identity-scope">
                    <span className="text-muted">影响范围：</span>此编辑对 <span className="text-fg">Web 端</span>与{" "}
                    <span className="text-fg">CLI / 飞书侧</span>都生效 —— 两端读<span className="text-fg">同一份</span>{" "}
                    <span className="font-mono text-muted">{data?.path}</span>
                    （CLI / 飞书侧由扩展 <span className="font-mono text-muted">elenva-host-guard</span> 在会话启动时装配，与 Web 侧同源）。
                    <span className="text-fg">新建会话生效，已开会话不回溯</span>；恢复旧版也两端一致。
                  </p>

                  <div className="flex flex-col gap-3" data-testid="identity-sections">
                    {sections.map((section, i) => (
                      <div key={section.id} className="rounded-card border border-line-soft bg-panel-2/40 p-3">
                        <div className="flex items-center gap-2">
                          <span className="shrink-0 text-[10px] tabular-nums text-dim">{i + 1}</span>
                          <input
                            value={section.title}
                            onChange={(e) => update(i, { title: e.target.value })}
                            maxLength={data?.titleLimit ?? 40}
                            placeholder="段落名（仅标签）"
                            className={inputCls}
                          />
                          <button onClick={() => move(i, -1)} disabled={i === 0} className="btn btn-ghost btn-sm" title="上移">
                            <ArrowUp size={12} />
                          </button>
                          <button onClick={() => move(i, 1)} disabled={i === sections.length - 1} className="btn btn-ghost btn-sm" title="下移">
                            <ArrowDown size={12} />
                          </button>
                          <button onClick={() => void remove(i)} className="btn btn-ghost btn-sm text-danger" title="删除该段" data-testid={`identity-remove-${i}`}>
                            <Trash2 size={12} />
                          </button>
                        </div>
                        <textarea
                          value={section.body}
                          onChange={(e) => update(i, { body: e.target.value })}
                          spellCheck={false}
                          rows={Math.min(12, Math.max(3, section.body.split("\n").length + 1))}
                          placeholder="这段正文会原样进入系统提示"
                          className={cn(textareaCls, "mt-2")}
                          data-testid={`identity-body-${i}`}
                        />
                        <div className="mt-1 flex items-center gap-2 text-[10px] text-dim/80">
                          <span className="tabular-nums">
                            {section.body.trim().length} / {data?.sectionBodyLimit ?? 2000}
                          </span>
                          {!section.body.trim() && <span className="text-danger">正文不能为空</span>}
                        </div>
                      </div>
                    ))}
                  </div>

                  <button
                    onClick={add}
                    disabled={sections.length >= (data?.maxSections ?? 40)}
                    className="btn btn-sm btn-subtle self-start"
                    data-testid="identity-add"
                  >
                    <Plus size={12} /> 新增段落
                  </button>
                </div>
              </Card>
            </div>

            {/* 右：生效预览 + 版本历史 */}
            <div className="flex min-w-0 flex-1 flex-col gap-5">
              <Card>
                <CardHeader>
                  <History size={14} className="text-accent" />
                  <CardTitle>生效预览</CardTitle>
                  {previewBusy && <Loader2 size={12} className="anim-spin text-dim" />}
                  <span className="ml-auto text-[10px] text-dim">新建会话生效，已开会话不回溯</span>
                </CardHeader>
                <div className="px-4 py-3.5">
                  <p className="text-[12px] leading-relaxed text-dim">
                    用真实会话的装配路径拼出的宿主层（身份 + 环境事实），位于 pi 基座之后、项目
                    <span className="font-mono text-muted">AGENTS.md</span> 之前。
                    {dirty && <span className="text-warn"> 当前有未保存改动，预览已按编辑区内容拼接。</span>}
                  </p>
                  <pre
                    className="mt-2 max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-panel-2 px-2.5 py-2 text-[11px] leading-relaxed text-muted"
                    data-testid="identity-preview"
                  >
                    {previewAssembled || "（预览生成中…）"}
                  </pre>
                </div>
              </Card>

              <Card>
                <CardHeader>
                  <History size={14} className="text-accent" />
                  <CardTitle>版本历史</CardTitle>
                  <span className="ml-auto text-[11px] tabular-nums text-dim">
                    最近 {data?.history.length ?? 0} / {data?.historyCap ?? 50}
                  </span>
                </CardHeader>
                <div className="px-4 py-3.5">
                  {!data?.history.length ? (
                    <p className="text-[12px] text-dim">还没有历史版本。每次保存前都会把旧值快照到这里（上限 {data?.historyCap ?? 50} 条）。</p>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      {data.history.map((entry) => (
                        <div key={entry.id} className="flex items-center gap-2 text-[11px]" data-testid={`identity-history-${entry.id}`}>
                          <span className="shrink-0 tabular-nums text-muted" title={entry.savedAt}>{relTime(entry.savedAt)}</span>
                          <span className="min-w-0 flex-1 truncate text-dim" title={entry.sections.map((s) => s.title).join(" / ")}>
                            {entry.sections.map((s) => s.title).join(" / ")}
                          </span>
                          <span className="shrink-0 tabular-nums text-dim/80">{entry.chars} 字</span>
                          <button onClick={() => void viewHistory(entry.id)} className="btn btn-ghost btn-sm shrink-0">
                            查看
                          </button>
                          <button
                            onClick={() => void restore(entry.id, entry.savedAt)}
                            disabled={restoringId !== null}
                            className="btn btn-ghost btn-sm shrink-0"
                            data-testid={`identity-restore-${entry.id}`}
                          >
                            {restoringId === entry.id ? <Loader2 size={12} className="anim-spin" /> : <RotateCcw size={12} />} 恢复
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {historyView && (
                    <div className="mt-3 rounded-card border border-line-soft bg-panel-2/40 p-3">
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-muted">历史版本 · {historyView.savedAt ? relTime(historyView.savedAt) : historyView.id}</span>
                        <button
                          onClick={() => void restore(historyView.id, historyView.savedAt)}
                          disabled={restoringId !== null}
                          className="btn btn-sm btn-ghost ml-auto"
                        >
                          <RotateCcw size={12} /> 恢复到此版本
                        </button>
                        <button onClick={() => setHistoryView(null)} className="btn btn-sm btn-ghost">
                          关闭
                        </button>
                      </div>
                      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-panel px-2.5 py-2 text-[11px] leading-relaxed text-muted">
                        {historyView.sections.map((s) => `${s.title}\n${s.body}`).join("\n\n---\n\n")}
                      </pre>
                    </div>
                  )}
                </div>
              </Card>

              <Card>
                <div className="px-4 py-3 text-[11px] leading-relaxed text-dim">
                  <div className="text-muted">存储</div>
                  <div className="mt-1 font-mono break-all">{data?.path}</div>
                  <div className="mt-1">
                    状态：{data ? SOURCE_LABEL[data.source] : "—"}
                    {data?.updatedAt ? ` · 最近保存 ${relTime(data.updatedAt)}` : ""}
                  </div>
                </div>
              </Card>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
