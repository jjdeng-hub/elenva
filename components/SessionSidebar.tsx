"use client";

import { Check, ChevronDown, FileUp, Folder, FolderPlus, Loader2, MessageSquarePlus, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/components/lib/utils";
import { Resizer, usePersistedWidth } from "@/components/ui/Resizer";
import { basename, relTime, timeLabel } from "@/lib/format";
import { toast } from "@/components/ui/dialog";
import type { SessionInfo } from "@/lib/types";

const GROUP_PREVIEW_COUNT = 5;
const DEFAULT_GROUP_KEY = "__default__";
const MANUAL_EXPANDED_KEY = "elenva-session-groups-expanded";
const PROJECTS_SECTION_KEY = "elenva-projects-section-open";

/** 用户手动展开/收起过的组（优先于「最近活跃默认展开」规则） */
function readManualExpanded(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(MANUAL_EXPANDED_KEY);
    if (raw) return JSON.parse(raw) as Record<string, boolean>;
  } catch {
    /* 忽略坏数据 */
  }
  return {};
}

function readProjectsSectionOpen(): boolean {
  try {
    return localStorage.getItem(PROJECTS_SECTION_KEY) !== "0";
  } catch {
    return true;
  }
}

interface SessionGroup {
  key: string;
  /** 项目显示名（默认组固定「默认会话」） */
  name: string;
  /** 项目根（默认组无） */
  root?: string;
  sessions: SessionInfo[];
  latest: string;
  isProject: boolean;
}

export function SessionSidebar({
  sessions,
  runningIds,
  unreadIds,
  selectedId,
  onSelect,
  onDelete,
  onNewChat,
  onSessionsChanged,
  onCreateInProject,
  onCreateProject,
  defaultCwd,
  collapsed,
}: {
  sessions: SessionInfo[];
  runningIds: Set<string>;
  /** 已完成但用户未查看的会话（显示为绿点） */
  unreadIds?: Set<string>;
  selectedId: string | null;
  onSelect: (s: SessionInfo) => void;
  onDelete?: (s: SessionInfo) => void;
  onNewChat?: () => void;
  /** 导入成功后刷新会话列表（父级回调） */
  /** 会话列表发生变化（导入 / 重命名）——由父级重新拉取列表 */
  onSessionsChanged?: () => void;
  /** 在指定项目根下新建会话（项目行 hover 的 +） */
  onCreateInProject?: (cwd: string) => void;
  /** 新建项目（打开目录选择器） */
  onCreateProject?: () => void;
  /** 默认组 [+] 的落点目录 */
  defaultCwd?: string | null;
  collapsed: boolean;
}) {
  const [query, setQuery] = useState("");
  const [importing, setImporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  // 折叠状态：用户手动操作过的组以 localStorage 为准；没操作过的走默认规则
  // （默认会话组展开；项目组里只有最近活跃的一个展开，其余收起）。
  const [manual, setManual] = useState<Record<string, boolean>>({});
  const [projectsSectionOpen, setProjectsSectionOpen] = useState(true);
  useEffect(() => {
    setManual(readManualExpanded());
    setProjectsSectionOpen(readProjectsSectionOpen());
  }, []);

  const toggleGroup = (key: string) => {
    setManual((prev) => {
      const next = { ...prev, [key]: !(prev[key] ?? (key === DEFAULT_GROUP_KEY || key === latestProjectKeyRef.current)) };
      try {
        localStorage.setItem(MANUAL_EXPANDED_KEY, JSON.stringify(next));
      } catch {
        /* 忽略写入失败 */
      }
      return next;
    });
  };

  const groups = useMemo<{
    defaultGroup: SessionGroup | null;
    projectGroups: SessionGroup[];
    flat: SessionInfo[];
  }>(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? sessions.filter(
          (s) =>
            (s.name || s.firstMessage || "").toLowerCase().includes(q) ||
            s.cwd.toLowerCase().includes(q),
        )
      : sessions;

    const sortDesc = (list: SessionInfo[]) =>
      [...list].sort((a, b) => (b.modified || "").localeCompare(a.modified || ""));

    // 搜索时打平：分组会妨碍扫视命中结果
    if (q) {
      return { defaultGroup: null, projectGroups: [], flat: sortDesc(filtered) };
    }

    const defaultSessions: SessionInfo[] = [];
    const byRepo = new Map<string, SessionInfo[]>();
    for (const s of filtered) {
      if (s.isProject && s.repoKey) {
        const list = byRepo.get(s.repoKey);
        if (list) list.push(s);
        else byRepo.set(s.repoKey, [s]);
      } else {
        defaultSessions.push(s);
      }
    }

    const sortedDefaults = sortDesc(defaultSessions);
    const defaultGroup: SessionGroup | null =
      sortedDefaults.length > 0
        ? {
            key: DEFAULT_GROUP_KEY,
            name: "默认会话",
            sessions: sortedDefaults,
            latest: sortedDefaults[0]?.modified || "",
            isProject: false,
          }
        : null;

    const projectGroups: SessionGroup[] = [...byRepo.entries()]
      .map(([repoKey, list]) => {
        const sorted = sortDesc(list);
        const root = sorted[0]?.repoRoot ?? sorted[0]?.projectRoot ?? "";
        return {
          key: repoKey,
          name: root ? basename(root) : "(未知项目)",
          root: root || undefined,
          sessions: sorted,
          latest: sorted[0]?.modified || "",
          isProject: true,
        };
      })
      .sort((a, b) => b.latest.localeCompare(a.latest));

    // 重名项目：显示名追加父目录消歧（低频，仅在冲突时）
    const nameCount = new Map<string, number>();
    for (const g of projectGroups) nameCount.set(g.name, (nameCount.get(g.name) ?? 0) + 1);
    for (const g of projectGroups) {
      if ((nameCount.get(g.name) ?? 0) > 1 && g.root) {
        const parts = g.root.replace(/[\\/]+$/, "").split(/[\\/]/);
        const parent = parts[parts.length - 2];
        if (parent) g.name = `${g.name} · ${parent}`;
      }
    }

    return { defaultGroup, projectGroups, flat: [] };
  }, [sessions, query]);

  /** 最近活跃的项目（其默认展开；其余收起） */
  const latestProjectKey = useMemo(() => groups.projectGroups[0]?.key ?? null, [groups.projectGroups]);
  const latestProjectKeyRef = useRef(latestProjectKey);
  latestProjectKeyRef.current = latestProjectKey;

  const isExpanded = (key: string, isProject: boolean) => {
    if (key in manual) return manual[key];
    if (!isProject) return true; // 默认会话组默认展开
    return key === latestProjectKey;
  };

  const toggleProjectsSection = () => {
    const next = !projectsSectionOpen;
    setProjectsSectionOpen(next);
    try {
      localStorage.setItem(PROJECTS_SECTION_KEY, next ? "1" : "0");
    } catch {
      /* 忽略写入失败 */
    }
  };

  /* 行内重命名状态 */
  /* 会话列表宽度可拖拽（折叠态宽度为 0，手柄不渲染） */
  const { width: paneWidth, grow: growPane, reset: resetPane } = usePersistedWidth(
    "elenva-chat-sidebar-width",
    256,
    200,
    420,
  );

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const commitRename = async (s: SessionInfo) => {
    const name = renameDraft.trim();
    setRenamingId(null);
    if (!name || name === (s.name || s.firstMessage)) return;
    try {
      const res = await fetch(`/api/sessions/${s.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error("重命名失败");
      toast("已重命名");
      onSessionsChanged?.();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const importFile = async (file: File) => {
    if (importing) return;
    setImporting(true);
    try {
      const content = await file.text();
      const res = await fetch("/api/sessions/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, filename: file.name }),
      });
      const d = (await res.json()) as { error?: string; sessionId?: string };
      if (!res.ok) throw new Error(d.error || `导入失败（HTTP ${res.status}）`);
      toast(`已导入会话（${d.sessionId?.slice(0, 8)}…）`);
      onSessionsChanged?.();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  /**
   * 会话行。
   *
   * 行内重命名存在的理由：用户会在**列表里**改名，而不是先打开会话再用顶栏 ——
   * 实测反馈「鼠标放上去只看到删除按钮」正是指这里。改名走 PATCH /api/sessions/:id，
   * 成功后回调父级刷新列表。
   */
  const renderSession = (s: SessionInfo) => {
    const active = s.id === selectedId;
    const running = runningIds.has(s.id);
    const editing = renamingId === s.id;
    const title = s.name || s.firstMessage || "(无标题)";

    if (editing) {
      return (
        <div key={s.id} className="flex w-full items-center gap-1.5 rounded-md bg-active px-2 py-1">
          <input
            autoFocus
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && !e.nativeEvent.isComposing) void commitRename(s);
              else if (e.key === "Escape") setRenamingId(null);
            }}
            onBlur={() => setRenamingId(null)}
            data-testid="session-row-rename-input"
            className="h-6 min-w-0 flex-1 rounded-sm border border-accent/50 bg-panel px-1 font-mono text-[12px] text-fg outline-none"
          />
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void commitRename(s)}
            title="保存（Enter）"
            aria-label="保存"
            className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-success t-fast hover:bg-hover"
          >
            <Check size={12} />
          </button>
        </div>
      );
    }

    return (
      <div
        key={s.id}
        onClick={() => onSelect(s)}
        data-testid="session-row"
        className={cn(
          "group relative flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-left t-fast",
          active ? "bg-active" : "hover:bg-hover",
        )}
      >
        {/* 状态指示：运行中用转圈（表达「正在进行」），跑完未读用实心绿点（表达「有结果等你看」）。
            原来是「绿色 + 呼吸闪烁」——既没表达出「正在跑」，也和「已完成」的绿色撞车。 */}
        {running ? (
          <span className="flex size-3 shrink-0 items-center justify-center" title="运行中">
            <Loader2 size={10} className="anim-spin text-accent" />
          </span>
        ) : unreadIds?.has(s.id) ? (
          <span className="size-1.5 shrink-0 rounded-full bg-success" title="已完成（未查看）" />
        ) : null}
        <span className={cn("min-w-0 flex-1 truncate text-[12px]", active ? "text-fg" : "text-fg/85")}>
          {title}
        </span>
        {/* 右侧一个槽位两用：默认是相对时间，hover 时操作组（绝对定位在同一处）盖上来。
            不并排是因为时间自身长度随「刚刚 / 12 分钟前」变，行宽会跟着抖。 */}
        <span
          className="min-w-[3.25rem] shrink-0 text-right text-[10px] tabular-nums text-dim t-fast group-hover:opacity-0"
          title={timeLabel(s.modified)}
        >
          {relTime(s.modified)}
        </span>
        <span className="absolute right-2 top-1/2 flex shrink-0 -translate-y-1/2 items-center gap-0.5 opacity-0 t-fast group-hover:opacity-100">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setRenamingId(s.id);
              setRenameDraft(title);
            }}
            title="重命名"
            aria-label="重命名"
            data-testid="session-row-rename"
            className="flex size-5 cursor-pointer items-center justify-center rounded-sm text-dim t-fast hover:bg-hover hover:text-fg"
          >
            <Pencil size={12} />
          </button>
          {onDelete && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete(s);
              }}
              title="删除会话"
              aria-label="删除会话"
              className="flex size-5 cursor-pointer items-center justify-center rounded-sm text-dim t-fast hover:bg-danger/10 hover:text-accent"
            >
              <Trash2 size={12} />
            </button>
          )}
        </span>
      </div>
    );
  };

  const defaultExpanded = isExpanded(DEFAULT_GROUP_KEY, false);
  const defaultSessions = groups.defaultGroup?.sessions ?? [];

  /**
   * 「展开全部」状态：每组独立、内存态（刷新后回到预览态）。
   * 与组头的折叠/展开分工不同 —— 组头管整组进出；这里管「预览 5 条 ↔ 全部」，
   * 两者用同一颗按钮配对切换（用户反馈：原来的「收起」= 整组收起，和点组头重复）。
   */
  const [showAllGroups, setShowAllGroups] = useState<Record<string, boolean>>({});
  const toggleShowAll = (key: string) =>
    setShowAllGroups((prev) => ({ ...prev, [key]: !prev[key] }));

  /** 组内列表：默认只列最近 GROUP_PREVIEW_COUNT 条，展开后全部。 */
  const renderGroupBody = (list: SessionInfo[], key: string) => {
    const showAll = !!showAllGroups[key];
    const hidden = Math.max(0, list.length - GROUP_PREVIEW_COUNT);
    return (
      <>
        {(showAll ? list : list.slice(0, GROUP_PREVIEW_COUNT)).map(renderSession)}
        {hidden > 0 && (
          <button
            onClick={() => toggleShowAll(key)}
            data-testid="session-group-toggle"
            className="btn btn-subtle mt-0.5 w-full"
          >
            {showAll ? (
              <>
                <ChevronDown size={12} className="rotate-180" />
                收起
              </>
            ) : (
              <>
                <ChevronDown size={12} />
                展开全部（还有 {hidden} 条）
              </>
            )}
          </button>
        )}
      </>
    );
  };

  const pane = (
    <div
      className={cn(
        "flex h-full flex-col border-r border-line bg-panel t-pane",
        // 收起时内容整体淡出：只靠 overflow 裁切会「文字还在、只是被切掉」，
        // 与工作站侧栏的淡出不是一个语言（用户反馈过三栏观感不一致）
        collapsed && "w-0 overflow-hidden opacity-0",
      )}
      style={collapsed ? undefined : { width: paneWidth }}
    >
      {/* New chat / new project / import */}
      {onNewChat && (
        <div className="px-3 pt-3 pb-2">
          <div className="flex gap-1.5">
            <button
              onClick={onNewChat}
              className="flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent text-[12px] font-semibold text-accent-fg t-fast hover:bg-accent-hover cursor-pointer"
            >
              <MessageSquarePlus size={14} />
              新建会话
            </button>
            {onCreateProject && (
              <button
                onClick={onCreateProject}
                title="打开文件夹：选一个目录作为本会话的工作区（目录是 git 仓库时会被归入「项目」分组）"
                className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-line bg-panel-2 text-muted t-fast hover:border-accent/40 hover:text-fg"
              >
                <FolderPlus size={14} />
              </button>
            )}
            <button
              onClick={() => importInputRef.current?.click()}
              disabled={importing}
              title="导入 pi CLI 导出的 JSONL 会话文件"
              className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-line bg-panel-2 text-muted t-fast hover:border-accent/40 hover:text-fg disabled:opacity-50"
            >
              <FileUp size={14} />
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept=".jsonl,application/jsonl,text/plain"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importFile(f);
                e.target.value = "";
              }}
            />
          </div>
        </div>
      )}

      {/* Search */}
      <div className="px-3 pb-2">
        <div className="flex h-7 items-center gap-1.5 rounded-md border border-line bg-panel-2 px-2 text-dim focus-within:border-accent/50">
          <Search size={12} />
          <input
            id="session-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索会话…"
            className="w-full bg-transparent text-[12px] text-fg outline-none placeholder:text-dim"
          />
        </div>
      </div>

      {/* Session list */}
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        {/* 搜索结果：打平 */}
        {query.trim() && (
          <>
            {groups.flat.length === 0 && (
              <div className="px-3 py-6 text-center text-[12px] text-dim">无匹配结果</div>
            )}
            {groups.flat.map(renderSession)}
          </>
        )}

        {/* 默认会话组（非项目目录的会话，平铺、无文件夹名） */}
        {!query.trim() && groups.defaultGroup && (
          <div className="mb-2">
            <div className="group/hd flex items-center gap-1 rounded-md px-2 py-1 hover:bg-hover">
              <button
                onClick={() => toggleGroup(DEFAULT_GROUP_KEY)}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-left"
              >
                <ChevronDown size={12} className={cn("shrink-0 text-dim transition-transform", !defaultExpanded && "-rotate-90")} />
                <span className="text-[10px] font-medium tracking-[0.04em] text-dim">默认会话</span>
              </button>
              {onCreateInProject && defaultCwd && (
                <button
                  onClick={() => onCreateInProject(defaultCwd)}
                  title="新建会话（使用默认目录）"
                  className="shrink-0 cursor-pointer rounded-sm p-0.5 text-dim opacity-0 transition-opacity hover:text-accent group-hover/hd:opacity-100"
                >
                  <Plus size={12} />
                </button>
              )}
            </div>
            {defaultExpanded && renderGroupBody(defaultSessions, DEFAULT_GROUP_KEY)}
          </div>
        )}

        {/* 项目组 */}
        {!query.trim() && groups.projectGroups.length > 0 && (
          <div className="mb-2">
            <div className="flex items-center gap-1.5 px-2 py-1">
              <button
                onClick={toggleProjectsSection}
                className="flex min-w-0 cursor-pointer items-center gap-1 text-[10px] font-medium tracking-[0.04em] text-dim t-fast hover:text-fg"
              >
                <ChevronDown size={12} className={cn("shrink-0 transition-transform", !projectsSectionOpen && "-rotate-90")} />
                项目
              </button>
            </div>
            {projectsSectionOpen &&
              groups.projectGroups.map((g) => {
                const expanded = isExpanded(g.key, true);
                return (
                  <div key={g.key} className="mb-1.5">
                    <div className="group/proj flex items-center gap-1 rounded-md px-2 py-1 hover:bg-hover">
                      <button
                        onClick={() => toggleGroup(g.key)}
                        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-left"
                      >
                        <ChevronDown size={12} className={cn("shrink-0 text-dim transition-transform", !expanded && "-rotate-90")} />
                        <Folder size={10} className="shrink-0 text-dim" />
                        <span className="min-w-0 truncate text-[10px] font-medium tracking-[0.04em] text-dim" title={g.root}>
                          {g.name}
                        </span>
                      </button>
                      {onCreateInProject && g.root && (
                        <button
                          onClick={() => onCreateInProject(g.root!)}
                          title={`在「${g.name}」中新建会话`}
                          className="shrink-0 cursor-pointer rounded-sm p-0.5 text-dim opacity-0 transition-opacity hover:text-accent group-hover/proj:opacity-100"
                        >
                          <Plus size={12} />
                        </button>
                      )}
                    </div>
                    {expanded && renderGroupBody(g.sessions, g.key)}
                  </div>
                );
              })}
          </div>
        )}

        {/* 空态 */}
        {!query.trim() && !groups.defaultGroup && groups.projectGroups.length === 0 && (
          <div className="px-3 py-6 text-center text-[12px] text-dim">
            {sessions.length === 0 ? "暂无会话记录" : ""}
          </div>
        )}
      </div>
    </div>
  );

  /* 折叠时宽度为 0，手柄没有意义；只在展开态渲染 */
  if (collapsed) return pane;
  return (
    <>
      {pane}
      <Resizer onDrag={growPane} onDoubleClick={resetPane} label="调整会话列表宽度" />
    </>
  );
}
