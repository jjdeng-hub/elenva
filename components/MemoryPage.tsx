"use client";

import { AlertTriangle, Brain, CalendarDays, FileText, Info, Loader2, Pencil, Plus, RefreshCw, Save, Trash2, User } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/components/lib/utils";
import { EmptyState, PageHeader } from "@/components/ui/bits";
import { toast } from "@/components/ui/dialog";
import { CopyButton } from "@/components/ui/widgets";
import { formatSize, relTime } from "@/lib/format";

type ContextFileEntry = {
  id: string;
  label: string;
  scope: "global" | "project";
  path: string | null;
  exists: boolean;
  content: string;
};

export interface MemoryProject {
  name: string;
  path: string;
}

type AgentMemoryFile = {
  id: string;
  label: string;
  kind: "user" | "memory" | "failures" | "project";
  path: string;
  exists: boolean;
  size: number;
  modified: string | null;
};

type AgentMemoryIndex = {
  dir: string;
  projectsDir: string;
  dirExists: boolean;
  installed: boolean;
  files: AgentMemoryFile[];
};

/** 一条记忆（GET /api/memory?file= 返回的结构化视图） */
type MemoryEntry = {
  text: string;
  created: string | null;
  last: string | null;
};

/** 单文件详情：原始内容（复制用）+ 结构化条目 + 版本 + 配额 */
type AgentMemoryDetail = {
  file: AgentMemoryFile;
  content: string;
  truncated: boolean;
  entries: MemoryEntry[];
  revision: string;
  chars: number;
  limit: number;
};

type MemoryTab = "agent" | "instructions";

/**
 * 记忆页：两个体系。
 *  - 「Agent 记忆」：pi-hermes-memory 扩展写的经历（USER.md 画像 / MEMORY.md 长期 / failures.md 失败 /
 *    项目级 MEMORY.md），存在本机 ~/.pi/agent/ 下，不进仓库 —— 条目可直接编辑（写入走 /api/memory，
 *    带配额校验、写前备份、并发检测；检索索引由扩展在会话启动时对齐）。
 *  - 「指令文件」：用户手写的长期指令（AGENTS.md / SYSTEM.md），会话启动时注入，可编辑、进 git。
 * 用户容易把两者混为一谈（"到底谁在写记忆"），所以页头用分段控件明确分开，不再靠一段说明文字解释。
 */
export function MemoryPage({ projects }: { projects: MemoryProject[] }) {
  const [tab, setTab] = useState<MemoryTab>("agent");

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="page-col-form py-6">
        <PageHeader
          icon={<Brain size={16} />}
          title="记忆"
          subtitle="Agent 自己积累的经历 · 你手写的长期指令"
          actions={
            <div className="flex items-center rounded-lg border border-line bg-panel-2 p-0.5">
              <TabButton active={tab === "agent"} onClick={() => setTab("agent")} icon={<Brain size={12} />}>
                Agent 记忆
              </TabButton>
              <TabButton active={tab === "instructions"} onClick={() => setTab("instructions")} icon={<FileText size={12} />}>
                指令文件
              </TabButton>
            </div>
          }
        />
        {tab === "agent" ? <AgentMemoryView /> : <InstructionFilesView projects={projects} />}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[12px] t-fast",
        active ? "bg-active font-medium text-accent" : "text-muted hover:text-fg",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

/* ============================ Agent 记忆（只读） ============================ */

function AgentMemoryView() {
  const [index, setIndex] = useState<AgentMemoryIndex | null>(null);
  const [activeId, setActiveId] = useState("memory");
  const [detail, setDetail] = useState<AgentMemoryDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  /** 刷新按钮的计数器：同时驱动索引与当前文件内容重读 */
  const [reloadKey, setReloadKey] = useState(0);
  /** 正在编辑的条目下标（null = 无） */
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  /** 待确认删除的条目下标 */
  const [confirmIndex, setConfirmIndex] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [newDraft, setNewDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const detailSeq = useRef(0);
  const pickedInitial = useRef(false);

  const loadIndex = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/memory", { cache: "no-store" });
      const d = (await res.json()) as AgentMemoryIndex & { error?: string };
      if (!res.ok) throw new Error(d.error || `加载失败（HTTP ${res.status}）`);
      setIndex(d);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadIndex();
  }, [loadIndex, reloadKey]);

  // 首次拿到索引时，若 MEMORY.md 还是空的就落到第一个有内容的文件，避免一进来就是空白
  useEffect(() => {
    if (!index || pickedInitial.current) return;
    pickedInitial.current = true;
    if (index.files.some((f) => f.id === activeId && f.exists)) return;
    const first = index.files.find((f) => f.exists);
    if (first) setActiveId(first.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  useEffect(() => {
    const seq = ++detailSeq.current;
    setDetailLoading(true);
    // 切换文件时清掉编辑态，免得把 A 文件的草稿存进 B 文件
    setEditIndex(null);
    setConfirmIndex(null);
    setAdding(false);
    setNewDraft("");
    (async () => {
      try {
        const res = await fetch(`/api/memory?file=${encodeURIComponent(activeId)}`, { cache: "no-store" });
        const d = (await res.json()) as AgentMemoryDetail & { error?: string };
        if (!res.ok) throw new Error(d.error || `加载失败（HTTP ${res.status}）`);
        if (seq !== detailSeq.current) return; // 切换过快时丢弃过期响应
        setDetail(d);
      } catch (e) {
        if (seq === detailSeq.current) toast(e instanceof Error ? e.message : String(e));
      } finally {
        if (seq === detailSeq.current) setDetailLoading(false);
      }
    })();
  }, [activeId, reloadKey]);

  /** 保存整份条目（改 / 删 / 增都走这一条路径，序列化与配额由服务端负责） */
  const saveEntries = useCallback(
    async (entries: MemoryEntry[]) => {
      if (!detail) return;
      setSaving(true);
      try {
        const res = await fetch("/api/memory", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file: detail.file.id, entries, revision: detail.revision }),
        });
        const d = (await res.json()) as { ok?: boolean; error?: string };
        if (!res.ok || !d.ok) throw new Error(d.error || `保存失败（HTTP ${res.status}）`);
        toast("已保存 · 下一轮对话的常驻索引立即生效");
        setEditIndex(null);
        setConfirmIndex(null);
        setAdding(false);
        setNewDraft("");
        setReloadKey((k) => k + 1);
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
    },
    [detail],
  );

  const files = index?.files ?? [];
  const profile = files.filter((f) => f.kind === "user");
  const core = files.filter((f) => f.kind === "memory" || f.kind === "failures");
  const projectsMem = files.filter((f) => f.kind === "project");
  const active = files.find((f) => f.id === activeId) ?? null;
  const nothingSaved = Boolean(index) && !files.some((f) => f.exists);
  const entries = detail?.entries ?? [];
  /** 落盘占用（含元数据），与扩展的配额口径一致 */
  const capacity = detail && detail.limit > 0 ? detail.chars / detail.limit : 0;

  return (
    <div className="flex flex-col gap-3">
      {/* 两个记忆体系的分工。用户会把它们混为一谈（"到底谁在写记忆"），
          这里点明本页是只读的，要改就让 Agent 用 memory_add 改。 */}
      <div className="rounded-lg border border-line-soft bg-panel-2 px-3 py-2 text-[11px] leading-relaxed text-dim">
        这里是 Agent 自己积累的<strong className="font-medium text-fg">经历</strong>，分三层：
        <span className="font-mono">USER.md</span> 是它对你的画像，
        <span className="font-mono">MEMORY.md</span> 是跨项目的事实与教训，
        项目细节各自记在项目名下。全部有字符上限（满额会硬拒写入）——
        <strong className="font-medium text-fg">每条都能直接改</strong>，也可以让 Agent 用{" "}
        <span className="font-mono">memory_add</span> 改；你手写的长期指令在旁边的「指令文件」里。
      </div>

      {loading && !index ? (
        <div className="flex items-center gap-2 rounded-card border border-line bg-panel px-4 py-10 text-[12px] text-dim">
          <Loader2 size={14} className="anim-spin" /> 读取记忆目录…
        </div>
      ) : !index ? null : nothingSaved ? (
        <div className="rounded-card border border-line bg-panel">
          <EmptyState
            icon={<Brain size={20} />}
            title="这里还没有内容"
            hint={
              <>
                记忆目录 <span className="font-mono">{index.dir}</span>{" "}
                里还没写过任何条目。
                {index.installed
                  ? " 记忆扩展已装上，下次会话里让 Agent 记点什么就会出现。"
                  : " 本机 ~/.pi/agent/settings.json 的 packages 里没有 pi-hermes-memory —— 装上带记忆工具的扩展后才会写。"}
              </>
            }
          />
        </div>
      ) : (
        <div className="rounded-card border border-line bg-panel">
          <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-4 py-3">
            <span className="text-[13px] font-semibold text-fg">Agent 记忆</span>
            {index.installed ? (
              <span className="chip chip-accent">pi-hermes-memory 已启用</span>
            ) : (
              <span className="chip chip-warn">未检测到 pi-hermes-memory</span>
            )}
            <span className="ml-auto hidden truncate font-mono text-[10px] text-dim lg:block" title={index.dir}>
              {index.dir}
            </span>
            <button
              onClick={() => setReloadKey((k) => k + 1)}
              disabled={loading}
              title="重新读取磁盘上的记忆文件"
              className="btn btn-ghost btn-sm shrink-0"
            >
              <RefreshCw size={12} className={cn(loading && "anim-spin")} /> 刷新
            </button>
          </div>

          <div className="flex flex-col md:flex-row">
            {/* 文件清单 */}
            <aside className="shrink-0 border-b border-line-soft p-2 md:w-64 md:border-b-0 md:border-r">
              <MemoryGroup icon={<User size={12} />} label="画像" files={profile} activeId={activeId} onSelect={setActiveId} />
              <MemoryGroup
                icon={<FileText size={12} />}
                label="核心"
                files={core}
                activeId={activeId}
                onSelect={setActiveId}
                emptyHint="还没写过核心记忆"
              />
              <MemoryGroup
                icon={<CalendarDays size={12} />}
                label="项目"
                files={projectsMem}
                activeId={activeId}
                onSelect={setActiveId}
                emptyHint="还没有项目级记忆（在某个项目里聊过一次后出现）"
              />
            </aside>

            {/* 内容 */}
            <section className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-4 py-2.5">
                <span className="flex items-center gap-1.5 font-mono text-[12px] font-medium text-fg">
                  {active?.kind === "user"
                    ? <User size={12} className="text-dim" />
                    : active?.kind === "failures"
                      ? <AlertTriangle size={12} className="text-dim" />
                      : <FileText size={12} className="text-dim" />}
                  {active?.label ?? ""}
                </span>
                {active?.exists ? (
                  <span className="text-[11px] text-dim">
                    <span className="tabular-nums">{formatSize(active.size)}</span>
                    {active.modified && <> · 更新于 {relTime(active.modified)}</>}
                  </span>
                ) : (
                  <span className="chip">空</span>
                )}
                {detail?.truncated && <span className="chip chip-warn">超出 512KB，仅显示前段</span>}
                {detail && detail.limit > 0 && (
                  <span
                    className="flex items-center gap-1.5"
                    title={`落盘 ${detail.chars} / 上限 ${detail.limit} 字符（含元数据；满额会硬拒写入）`}
                  >
                    <span className="h-1 w-20 overflow-hidden rounded-full bg-panel-2">
                      <span
                        className={cn(
                          "block h-full rounded-full t-base",
                          capacity >= 0.85 ? "bg-danger" : capacity >= 0.7 ? "bg-warn" : "bg-accent",
                        )}
                        style={{ width: `${Math.min(100, Math.round(capacity * 100))}%` }}
                      />
                    </span>
                    <span className={cn("text-[10px] tabular-nums", capacity >= 0.85 ? "text-danger" : "text-dim")}>
                      {Math.round(capacity * 100)}%
                    </span>
                  </span>
                )}
                {detailLoading && <Loader2 size={12} className="anim-spin text-dim" />}
                <div className="ml-auto flex shrink-0 items-center gap-1">
                  {detail?.content && <CopyButton text={detail.content} />}
                </div>
              </div>
              <div className="px-4 pb-3 pt-2">
                <div className="hidden truncate font-mono text-[10px] text-dim md:block" title={active?.path}>
                  {active?.path}
                </div>
                <div className="mt-2 flex flex-col">
                  {!active?.exists && (
                    <div className="flex items-center gap-2 py-2 text-[12px] text-dim">
                      <Info size={14} /> 这个文件还没写过 —— 在下面写第一条
                    </div>
                  )}
                  {/* 条目之间用 `§` 分隔（扩展的落盘格式），逐条渲染、单独编辑 */}
                  {entries.map((entry, i) => (
                    <div key={i} className={i > 0 ? "mt-3 border-t border-line-soft pt-3" : undefined}>
                      {editIndex === i ? (
                        <div>
                          <textarea
                            value={editDraft}
                            onChange={(e) => setEditDraft(e.target.value)}
                            disabled={saving}
                            spellCheck={false}
                            className="h-40 w-full resize-y rounded-lg border border-line bg-panel-2 p-3 font-mono text-[12px] leading-relaxed text-fg outline-none t-fast focus:border-accent/60 disabled:opacity-50"
                          />
                          <div className="mt-2 flex items-center gap-2">
                            <button
                              onClick={() =>
                                void saveEntries(entries.map((e, k) => (k === i ? { ...e, text: editDraft } : e)))
                              }
                              disabled={saving || !editDraft.trim()}
                              className="btn btn-primary btn-sm"
                            >
                              {saving ? <Loader2 size={12} className="anim-spin" /> : <Save size={12} />} 保存
                            </button>
                            <button onClick={() => setEditIndex(null)} disabled={saving} className="btn btn-ghost btn-sm">
                              取消
                            </button>
                            <span className="ml-auto text-[10px] tabular-nums text-dim">{editDraft.length} 字符</span>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="flex items-start gap-2">
                            <pre className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-fg">
                              {entry.text}
                            </pre>
                            <div className="flex shrink-0 items-center gap-1">
                              {confirmIndex === i ? (
                                <>
                                  <button
                                    onClick={() => void saveEntries(entries.filter((_, k) => k !== i))}
                                    disabled={saving}
                                    className="btn btn-sm text-danger"
                                  >
                                    确认删除
                                  </button>
                                  <button
                                    onClick={() => setConfirmIndex(null)}
                                    disabled={saving}
                                    className="btn btn-ghost btn-sm"
                                  >
                                    取消
                                  </button>
                                </>
                              ) : (
                                <>
                                  <button
                                    onClick={() => {
                                      setEditIndex(i);
                                      setEditDraft(entry.text);
                                    }}
                                    title="编辑这条"
                                    className="btn btn-icon"
                                  >
                                    <Pencil size={12} />
                                  </button>
                                  <button onClick={() => setConfirmIndex(i)} title="删除这条" className="btn btn-icon">
                                    <Trash2 size={12} />
                                  </button>
                                </>
                              )}
                            </div>
                          </div>
                          {entry.created && (
                            <div className="mt-1 text-[10px] tabular-nums text-dim">
                              建于 {entry.created}
                              {entry.last && entry.last !== entry.created ? ` · 最近 ${entry.last}` : ""}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  ))}

                  {/* 新增条目 */}
                  <div className={entries.length > 0 ? "mt-3 border-t border-line-soft pt-3" : "mt-1"}>
                    {adding ? (
                      <div>
                        <textarea
                          value={newDraft}
                          onChange={(e) => setNewDraft(e.target.value)}
                          disabled={saving}
                          spellCheck={false}
                          placeholder="写一条新记忆…"
                          className="h-32 w-full resize-y rounded-lg border border-line bg-panel-2 p-3 font-mono text-[12px] leading-relaxed text-fg outline-none t-fast focus:border-accent/60 disabled:opacity-50"
                        />
                        <div className="mt-2 flex items-center gap-2">
                          <button
                            onClick={() => void saveEntries([...entries, { text: newDraft, created: null, last: null }])}
                            disabled={saving || !newDraft.trim()}
                            className="btn btn-primary btn-sm"
                          >
                            {saving ? <Loader2 size={12} className="anim-spin" /> : <Save size={12} />} 保存
                          </button>
                          <button
                            onClick={() => {
                              setAdding(false);
                              setNewDraft("");
                            }}
                            disabled={saving}
                            className="btn btn-ghost btn-sm"
                          >
                            取消
                          </button>
                          <span className="ml-auto text-[10px] tabular-nums text-dim">{newDraft.length} 字符</span>
                        </div>
                      </div>
                    ) : (
                      <button onClick={() => setAdding(true)} className="btn btn-subtle btn-sm">
                        <Plus size={12} /> 新增条目
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

function MemoryGroup({
  icon,
  label,
  files,
  activeId,
  onSelect,
  emptyHint,
}: {
  icon: React.ReactNode;
  label: string;
  files: AgentMemoryFile[];
  activeId: string;
  onSelect: (id: string) => void;
  emptyHint?: string;
}) {
  return (
    <div className="mb-1">
      <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-2 text-[11px] text-dim">
        {icon}
        {label}
      </div>
      {files.length === 0 && emptyHint && <div className="px-2.5 py-1 text-[11px] text-dim/80">{emptyHint}</div>}
      {files.map((f) => (
        <button
          key={f.id}
          onClick={() => onSelect(f.id)}
          className={cn(
            "flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left t-fast",
            f.id === activeId ? "bg-active text-accent" : "text-muted hover:bg-hover hover:text-fg",
          )}
        >
          <span className={cn("min-w-0 flex-1 truncate text-[12px]", f.kind !== "project" && "font-mono")}>{f.label}</span>
          {f.exists ? (
            <span className="shrink-0 text-[10px] tabular-nums text-dim">{formatSize(f.size)}</span>
          ) : (
            <span className="shrink-0 text-[10px] text-dim">空</span>
          )}
        </button>
      ))}
    </div>
  );
}

/* ======================= 指令文件（用户手写，可编辑） ======================= */

function InstructionFilesView({ projects }: { projects: MemoryProject[] }) {
  const [scope, setScope] = useState<"global" | "project">("global");
  const [projectPath, setProjectPath] = useState<string>(projects[0]?.path ?? "");
  const [files, setFiles] = useState<ContextFileEntry[]>([]);
  const [activeId, setActiveId] = useState<string>("global-agents");
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const activeCwd = scope === "project" ? projectPath : "";

  // projects 异步到达后补齐默认选中（直接深链进入本页时，挂载时 projects 还是空数组）
  useEffect(() => {
    setProjectPath((prev) => prev || projects[0]?.path || "");
  }, [projects]);

  const load = useCallback(async (dir?: string) => {
    setLoading(true);
    try {
      const q = dir ? `?cwd=${encodeURIComponent(dir)}` : "";
      const res = await fetch(`/api/context-files${q}`, { cache: "no-store" });
      const d = (await res.json()) as { files?: ContextFileEntry[]; error?: string };
      if (!res.ok) throw new Error(d.error || `加载失败（HTTP ${res.status}）`);
      setFiles(d.files ?? []);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // 项目作用域但项目列表未就绪：不发起加载，避免退回全局文件列表
    if (scope === "project" && !projectPath) return;
    void load(activeCwd || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, activeCwd, scope, projectPath]);

  const visibleFiles = useMemo(
    () => files.filter((f) => f.scope === scope),
    [files, scope],
  );

  // scope/项目切换后落到该作用域的第一个文件
  useEffect(() => {
    if (!visibleFiles.some((f) => f.id === activeId)) {
      setActiveId(visibleFiles[0]?.id ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, projectPath, files]);

  const active = visibleFiles.find((f) => f.id === activeId) ?? null;

  useEffect(() => {
    setDraft(active?.content ?? "");
  }, [active?.id, active?.content]);

  const dirty = active ? draft !== active.content : false;

  const save = async (content?: string) => {
    if (!active) return;
    const payload = content ?? draft;
    setSaving(true);
    try {
      const res = await fetch("/api/context-files", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: active.id, content: payload, cwd: activeCwd || undefined }),
      });
      const d = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(d.error || `保存失败（HTTP ${res.status}）`);
      toast(payload.trim() ? "已保存，新会话生效" : "已移除该文件");
      await load(activeCwd || undefined);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-line-soft bg-panel-2 px-3 py-2 text-[11px] leading-relaxed text-dim">
        这里管的是 <span className="text-fg">你手写</span>的长期指令：会话启动时注入系统提示，
        进 git、可随项目共享。Agent 自己积累的经历不在这里 —— 切到上面的「Agent 记忆」看。
      </div>

      <div className="rounded-card border border-line bg-panel">
        {/* 作用域 + 项目选择 */}
        <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-4 py-3">
          <div className="flex items-center rounded-lg border border-line bg-panel-2 p-0.5">
            <button
              onClick={() => setScope("global")}
              aria-pressed={scope === "global"}
              className={cn(
                "flex h-7 cursor-pointer items-center rounded-md px-2.5 text-[12px] t-fast",
                scope === "global" ? "bg-active font-medium text-accent" : "text-muted hover:text-fg",
              )}
            >
              全局
            </button>
            <button
              onClick={() => projects.length > 0 && setScope("project")}
              disabled={projects.length === 0}
              aria-pressed={scope === "project"}
              className={cn(
                "flex h-7 cursor-pointer items-center rounded-md px-2.5 text-[12px] t-fast disabled:cursor-not-allowed disabled:opacity-50",
                scope === "project" ? "bg-active font-medium text-accent" : "text-muted hover:text-fg",
              )}
            >
              项目
            </button>
          </div>
          {scope === "project" && (
            <select
              value={projectPath}
              onChange={(e) => setProjectPath(e.target.value)}
              className="h-7 max-w-72 cursor-pointer rounded-lg border border-line bg-panel-2 px-2 text-[12px] text-fg outline-none t-fast focus:border-accent/60"
            >
              {projects.map((p) => (
                <option key={p.path} value={p.path}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          {active?.path && (
            <span className="ml-auto hidden truncate font-mono text-[10px] text-dim lg:block" title={active.path}>
              {active.path}
            </span>
          )}
        </div>

        {/* 文件切换：用下划线式页签与上方「全局/项目」分段控件拉开层级，
            否则两层长得一样，用户分不清哪层在切作用域、哪层在切文件 */}
        <div className="flex flex-wrap items-center gap-4 border-b border-line px-4">
          {visibleFiles.map((f) => (
            <button
              key={f.id}
              onClick={() => setActiveId(f.id)}
              className={cn(
                "-mb-px flex h-9 cursor-pointer items-center gap-1.5 border-b-2 text-[12px] t-fast",
                f.id === activeId
                  ? "border-accent font-semibold text-accent"
                  : "border-transparent text-dim hover:text-fg",
              )}
            >
              <span className="font-mono">{f.label}</span>
              {f.exists && <span className="size-1.5 rounded-full bg-accent/70" title="文件已存在" />}
            </button>
          ))}
          {loading && <Loader2 size={12} className="anim-spin text-dim" />}
        </div>

        {/* 编辑器 */}
        <div className="px-4 pb-4 pt-3">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={loading || !active}
            spellCheck={false}
            placeholder={
              "在这里写 Markdown。\n\n例：\n# 项目约定\n- 包管理器用 npm\n- 提交信息用中文\n- 不要动 dist/ 目录\n\n# 记忆\n- 重要决定、偏好、踩过的坑，主动用 memory_write 记下来\n- 用户说“记住”时立即写"
            }
            className="h-72 w-full resize-y rounded-lg border border-line bg-panel-2 p-3 font-mono text-[12px] leading-relaxed text-fg outline-none t-fast focus:border-accent/60 disabled:opacity-50"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              onClick={() => void save()}
              disabled={loading || saving || !active || !draft.trim() || !dirty}
              className="btn btn-primary"
            >
              {saving ? <Loader2 size={12} className="anim-spin" /> : <Save size={12} />} 保存
            </button>
            <button
              onClick={() => void load(activeCwd || undefined)}
              disabled={loading || !dirty}
              title="放弃未保存修改并从磁盘重新加载"
              className="btn btn-ghost"
            >
              <RefreshCw size={12} /> 重置
            </button>
            {dirty && <span className="text-[11px] text-warn">有未保存修改</span>}
            {active?.exists && !dirty && (
              <button
                onClick={() => void save("")}
                disabled={loading || saving}
                title="移除该上下文文件（内容清空即删除）"
                className="btn btn-subtle text-danger"
              >
                <Trash2 size={12} /> 移除文件
              </button>
            )}
            <span className="ml-auto flex items-center gap-3 text-[11px] text-dim">
              <span className="tabular-nums">{draft.length} 字符</span>
              <span>新会话生效</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
