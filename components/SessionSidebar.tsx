"use client";

import { Check, ChevronDown, FileUp, Folder, FolderPlus, Hash, Loader2, MessageSquarePlus, Pencil, Plus, Search, Star, Trash2 } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@/components/lib/utils";
import { Resizer, usePersistedWidth } from "@/components/ui/Resizer";
import { basename, relTime, timeLabel } from "@/lib/format";
import { dialogPrompt, toast } from "@/components/ui/dialog";
import type { SessionMeta } from "@/lib/session-meta";
import type { SessionInfo } from "@/lib/types";

/** /api/sessions/search 返回的单会话结果（P4c：从只搜标题升级到搜消息内容） */
type SessionContentHit = {
  sessionId: string;
  title: string | null;
  count: number;
  hits: { text: string }[];
};

/** 内容搜索的去抖间隔（输入还在打时不打后端） */
const CONTENT_SEARCH_DEBOUNCE_MS = 300;

/** 命中片段里高亮关键词（大小写不敏感；语义色 text-accent，不写死原生色） */
function HitText({ text, q }: { text: string; q: string }) {
  const parts: ReactNode[] = [];
  const lowerText = text.toLowerCase();
  const lowerQ = q.toLowerCase();
  let from = 0;
  let guard = 0;
  while (guard++ < 50) {
    const idx = lowerText.indexOf(lowerQ, from);
    if (idx < 0) {
      parts.push(text.slice(from));
      break;
    }
    parts.push(text.slice(from, idx));
    parts.push(
      <span key={idx} className="font-semibold text-accent">
        {text.slice(idx, idx + q.length)}
      </span>,
    );
    from = idx + q.length;
  }
  return <>{parts}</>;
}

const GROUP_PREVIEW_COUNT = 5;
/** 行内标签最多显示几个（多出的折成 +N） */
const TAG_PREVIEW_COUNT = 2;
/** 过滤行最多列几个在用标签 */
const TAG_CHIP_LIMIT = 12;
const DEFAULT_GROUP_KEY = "__default__";
const MANUAL_EXPANDED_KEY = "elenva-session-groups-expanded";
const PROJECTS_SECTION_KEY = "elenva-projects-section-open";
const SESSION_FILTER_KEY = "elenva-session-filter";

/** 侧栏过滤条件：全部 / 只看收藏 / 只看某个标签 */
type SessionFilter = { kind: "all" | "fav" | "tag"; tag?: string };

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

/** 过滤条件持久化：坏数据一律回落「全部」（宁可多显示，不可空列表说不清） */
function readSessionFilter(): SessionFilter {
  try {
    const raw = localStorage.getItem(SESSION_FILTER_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { kind?: unknown; tag?: unknown };
      if (parsed?.kind === "fav") return { kind: "fav" };
      if (parsed?.kind === "tag" && typeof parsed.tag === "string" && parsed.tag) {
        return { kind: "tag", tag: parsed.tag };
      }
    }
  } catch {
    /* 忽略坏数据 */
  }
  return { kind: "all" };
}

/** 「修复 bug, 归档，修复 bug」→ ["修复 bug","归档"]（中英文逗号都切、去空、去重保序） */
function splitTagInput(input: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of input.split(/[,，]/)) {
    const tag = raw.trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

/** 元数据过滤：标签按原样精确匹配（服务端已按大小写不敏感去重、保留原大小写） */
function matchesSessionFilter(
  s: SessionInfo,
  meta: Record<string, SessionMeta>,
  filter: SessionFilter,
): boolean {
  if (filter.kind === "fav") return meta[s.id]?.fav === true;
  if (filter.kind === "tag") return (meta[s.id]?.tags ?? []).includes(filter.tag ?? "");
  return true;
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
  searchRuntime,
  searchProfile,
  collapsed,
}: {
  sessions: SessionInfo[];
  /** 内容搜索范围（P4c）：切换 Agent 时跟着变 —— pi 搜 jsonl，hermes 搜该 profile 的 state.db */
  searchRuntime?: "pi" | "hermes";
  searchProfile?: string;
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

  /** 内容搜索结果（P4c）：sessionId → 命中片段/条数。搜的是消息内容，不只是标题 */
  const [contentHits, setContentHits] = useState<Record<string, SessionContentHit>>({});
  const [contentSearching, setContentSearching] = useState(false);
  /** P4d：truncated = 未搜完（索引未追上 / 超时截断）——跟「真没找到」区分开 */
  const [contentTruncated, setContentTruncated] = useState(false);
  /** 重建索引进行中（显式动作， POST /api/sessions/search/reindex） */
  const [reindexing, setReindexing] = useState(false);
  /** 重建完成后 +1 触发搜索重跑 */
  const [reindexNonce, setReindexNonce] = useState(0);
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setContentHits({});
      setContentSearching(false);
      setContentTruncated(false);
      return;
    }
    setContentSearching(true);
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q });
      if (searchRuntime) params.set("runtime", searchRuntime);
      if (searchProfile) params.set("profile", searchProfile);
      let alive = true;
      fetch(`/api/sessions/search?${params.toString()}`, { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { results?: SessionContentHit[]; truncated?: boolean } | null) => {
          if (!alive) return;
          const next: Record<string, SessionContentHit> = {};
          for (const hit of data?.results ?? []) next[hit.sessionId] = hit;
          setContentHits(next);
          setContentTruncated(Boolean(data?.truncated));
        })
        .catch(() => {
          /* 搜索故障不拖垮侧栏 */
        })
        .finally(() => {
          if (alive) setContentSearching(false);
        });
      return () => {
        alive = false;
      };
    }, CONTENT_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, searchRuntime, searchProfile, reindexNonce]);

  /** 重建索引：清掉该 profile 的行 → FTS rebuild → 全量重同步，完成后重跑当前搜索 */
  const handleReindex = () => {
    if (reindexing) return;
    setReindexing(true);
    const profile = searchProfile && /^[a-z0-9][a-z0-9-]{0,63}$/.test(searchProfile) ? searchProfile : "default";
    fetch(`/api/sessions/search/reindex?profile=${encodeURIComponent(profile)}`, { method: "POST" })
      .catch(() => undefined)
      .finally(() => {
        setReindexing(false);
        setReindexNonce((n) => n + 1);
      });
  };

  // 折叠状态：用户手动操作过的组以 localStorage 为准；没操作过的走默认规则
  // （默认会话组展开；项目组里只有最近活跃的一个展开，其余收起）。
  const [manual, setManual] = useState<Record<string, boolean>>({});
  const [projectsSectionOpen, setProjectsSectionOpen] = useState(true);
  useEffect(() => {
    setManual(readManualExpanded());
    setProjectsSectionOpen(readProjectsSectionOpen());
    setFilter(readSessionFilter());
  }, []);

  /**
   * 收藏 / 标签是**服务端元数据**（`~/.pi/agent/elenva-session-meta.json`，见 lib/session-meta.ts）：
   * 只加载一次，之后的写操作就地更新本地副本（不再全量拉取）。拉不到就当没这层 ——
   * 「无收藏无标签 = 与今天零差异」，元数据故障不该拖垮会话列表。
   */
  const [meta, setMeta] = useState<Record<string, SessionMeta>>({});
  const [filter, setFilter] = useState<SessionFilter>({ kind: "all" });
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/session-meta", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { meta?: Record<string, SessionMeta> };
        if (alive && data?.meta && typeof data.meta === "object") setMeta(data.meta);
      } catch {
        /* 忽略：没有元数据等于没有收藏 / 标签 */
      }
    })();
    return () => {
      alive = false;
    };
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
    // 先过滤（收藏 / 标签），再搜索 —— 两个条件叠加时取交集
    const scoped = sessions.filter((s) => matchesSessionFilter(s, meta, filter));
    const filtered = q
      ? scoped.filter(
          (s) =>
            (s.name || s.firstMessage || "").toLowerCase().includes(q) ||
            s.cwd.toLowerCase().includes(q),
        )
      : scoped;

    const sortDesc = (list: SessionInfo[]) =>
      [...list].sort((a, b) => (b.modified || "").localeCompare(a.modified || ""));

    // 搜索或过滤激活时打平：分组会妨碍扫视命中结果
    if (q || filter.kind !== "all") {
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
  }, [sessions, query, meta, filter]);

  /**
   * 内容命中但标题不匹配的会话（P4c）：标题搜索只命中了名字，消息内容命中的
   * 会话也要出现在结果里 —— 把它们追加到打平列表的尾部（按命中条数降序）。
   */
  const contentHitSessions = useMemo(() => {
    if (!query.trim()) return [];
    const known = new Set(groups.flat.map((s) => s.id));
    const extra: { s: SessionInfo; count: number }[] = [];
    for (const [id, hit] of Object.entries(contentHits)) {
      if (known.has(id)) continue;
      const s = sessions.find((x) => x.id === id);
      if (s) extra.push({ s, count: hit.count });
    }
    return extra.sort((a, b) => b.count - a.count).map((e) => e.s);
  }, [query, groups.flat, contentHits, sessions]);

  /** 最近活跃的项目（其默认展开；其余收起） */
  const latestProjectKey = useMemo(() => groups.projectGroups[0]?.key ?? null, [groups.projectGroups]);
  const latestProjectKeyRef = useRef(latestProjectKey);
  latestProjectKeyRef.current = latestProjectKey;

  /** 过滤激活 = 打平（与搜索同一条理由） */
  const filterActive = filter.kind !== "all";
  const flatMode = query.trim().length > 0 || filterActive;
  /** 出现过任何收藏或标签吗 —— 没有则过滤行整体不渲染（与今天零视觉差异） */
  const hasAnyMeta = useMemo(
    () => Object.values(meta).some((entry) => entry.fav === true || (entry.tags?.length ?? 0) > 0),
    [meta],
  );
  /** 在用标签：按出现次数降序（同频按名称），最多 TAG_CHIP_LIMIT 个 */
  const tagOptions = useMemo(() => {
    const counts = new Map<string, { label: string; count: number }>();
    for (const entry of Object.values(meta)) {
      for (const tag of entry.tags ?? []) {
        const key = tag.toLowerCase();
        const hit = counts.get(key);
        if (hit) hit.count += 1;
        else counts.set(key, { label: tag, count: 1 });
      }
    }
    return [...counts.values()]
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "zh"))
      .slice(0, TAG_CHIP_LIMIT);
  }, [meta]);

  const chooseFilter = (next: SessionFilter) => {
    setFilter(next);
    try {
      localStorage.setItem(SESSION_FILTER_KEY, JSON.stringify(next));
    } catch {
      /* 忽略写入失败 */
    }
  };

  /** 本地合并（与 lib/session-meta.ts 的合并语义一致）：空条目直接删 key */
  const applyLocalMeta = (sessionId: string, patch: { fav?: boolean; tags?: string[] }) => {
    setMeta((prev) => {
      const current = prev[sessionId];
      const fav = patch.fav !== undefined ? patch.fav : current?.fav === true;
      const tags = patch.tags !== undefined ? patch.tags : current?.tags ?? [];
      const next = { ...prev };
      if (!fav && tags.length === 0) {
        delete next[sessionId];
        return next;
      }
      next[sessionId] = {
        ...(fav ? { fav: true } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        updatedAt: new Date().toISOString(),
      };
      return next;
    });
  };

  /** 用服务端返回的条目覆盖本地（写操作后的权威值） */
  const commitServerEntry = (sessionId: string, entry: SessionMeta | null | undefined) => {
    setMeta((prev) => {
      const next = { ...prev };
      if (entry) next[sessionId] = entry;
      else delete next[sessionId];
      return next;
    });
  };

  const postSessionMeta = async (body: Record<string, unknown>): Promise<SessionMeta | null> => {
    const res = await fetch("/api/session-meta", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; entry?: SessionMeta | null };
    if (!res.ok) throw new Error(data.error || `操作失败（HTTP ${res.status}）`);
    return data.entry ?? null;
  };

  /**
   * 收藏切换：乐观更新（先改本地、再 POST），失败回滚 + toast。
   * 乐观是为了让 ★ 即时变色 —— 这一下点击的反馈延迟是最刺眼的。
   */
  const toggleFav = async (s: SessionInfo) => {
    const before = meta[s.id];
    const nextFav = !(before?.fav === true);
    applyLocalMeta(s.id, { fav: nextFav });
    try {
      commitServerEntry(s.id, await postSessionMeta({ action: "set", sessionId: s.id, fav: nextFav }));
    } catch (e) {
      setMeta((prev) => {
        const next = { ...prev };
        if (before) next[s.id] = before;
        else delete next[s.id];
        return next;
      });
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  /** 标签编辑：整串覆盖（服务端规范化与上限校验，超限原样报错、本地不动） */
  const editTags = async (s: SessionInfo) => {
    const input = await dialogPrompt({
      title: "编辑标签",
      message: "用逗号分隔；最多 8 个、单个不超过 12 字",
      defaultValue: (meta[s.id]?.tags ?? []).join(", "),
      select: true,
      // 空串是「清空标签」这个有效意图，必须与「取消」（null）分开
      allowEmpty: true,
    });
    if (input === null) return;
    try {
      commitServerEntry(s.id, await postSessionMeta({ action: "set", sessionId: s.id, tags: splitTagInput(input) }));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const chipClass = (active: boolean) =>
    cn("chip cursor-pointer t-fast", active ? "chip-accent" : "hover:border-accent/40 hover:text-fg");

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
    const entry = meta[s.id];
    const isFav = entry?.fav === true;
    const tags = entry?.tags ?? [];

    /** ★ 一共只渲染一颗：未收藏时躲在 hover 集群里，已收藏时恒显在标题右侧 */
    const favButton = (className: string) => (
      <button
        onClick={(e) => {
          e.stopPropagation();
          void toggleFav(s);
        }}
        title={isFav ? "取消收藏" : "收藏"}
        aria-label={isFav ? "取消收藏" : "收藏"}
        aria-pressed={isFav}
        data-testid="session-fav"
        className={cn(
          "relative flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm t-fast after:absolute after:-inset-0.5 after:content-[''] hover:bg-hover",
          className,
        )}
      >
        <Star size={12} className={cn(isFav && "fill-current")} />
      </button>
    );

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
            className="relative flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-success t-fast after:absolute after:-inset-0.5 after:content-[''] hover:bg-hover"
          >
            <Check size={12} />
          </button>
        </div>
      );
    }

    const hit = query.trim() ? contentHits[s.id] : undefined;
    const qTrim = query.trim();

    return (
      <Fragment key={s.id}>
      <div
        onClick={() => {
          onSelect(s);
          // 内容命中：消息级定位由会话视图接手前，先在会话顶部提示命中数量
          if (hit) toast(`「${qTrim}」命中 ${hit.count} 处`);
        }}
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
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className={cn("truncate text-[12px]", active ? "text-fg" : "text-fg/85")}>{title}</span>
          {/* 内容命中（P4e）：标题下带一段命中片段（含高亮），让「为什么命中」可见 */}
          {hit && (
            <span className="truncate text-[10px] text-dim" title={hit.hits.map((h) => h.text).join(" / ")}>
              {hit.hits[0] && <HitText text={hit.hits[0].text} q={qTrim} />}
            </span>
          )}
        </span>
        {/* 已收藏：★ 恒显在标题右侧（再往右才是标签、时间）。
            放这里而不是 hover 集群里，是因为集群绝对定位在右端、hover 时会把它盖住，
            那样「想取消收藏」反而点不到。 */}
        {isFav && favButton("text-accent")}
        {/* 标签：标题尾部 #tag，最多 TAG_PREVIEW_COUNT 个，多出的折成 +N */}
        {tags.length > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-[10px] text-dim">
            {tags.slice(0, TAG_PREVIEW_COUNT).map((tag) => (
              <span key={tag} className="max-w-20 truncate" title={`#${tag}`}>
                #{tag}
              </span>
            ))}
            {tags.length > TAG_PREVIEW_COUNT && (
              <span title={tags.slice(TAG_PREVIEW_COUNT).map((tag) => `#${tag}`).join(" ")}>
                +{tags.length - TAG_PREVIEW_COUNT}
              </span>
            )}
          </span>
        )}
        {/* 右侧一个槽位两用：默认是相对时间，hover 时操作组（绝对定位在同一处）盖上来。
            不并排是因为时间自身长度随「刚刚 / 12 分钟前」变，行宽会跟着抖。 */}
        <span
          className="min-w-[3.25rem] shrink-0 text-right text-[10px] tabular-nums text-dim t-fast group-hover:opacity-0"
          title={timeLabel(s.modified)}
        >
          {relTime(s.modified)}
        </span>
        <span className="absolute right-2 top-1/2 flex shrink-0 -translate-y-1/2 items-center gap-0.5 opacity-0 t-fast group-hover:opacity-100">
          {/* 排布 [★][#][✎][🗑]：未收藏时 ★ 在这里（hover 显现），已收藏时它已恒显于标题右侧 */}
          {!isFav && favButton("text-dim hover:text-accent")}
          <button
            onClick={(e) => {
              e.stopPropagation();
              void editTags(s);
            }}
            title="编辑标签"
            aria-label="编辑标签"
            data-testid="session-tags"
            className="relative flex size-5 cursor-pointer items-center justify-center rounded-sm text-dim t-fast after:absolute after:-inset-0.5 after:content-[''] hover:bg-hover hover:text-fg"
          >
            <Hash size={12} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setRenamingId(s.id);
              setRenameDraft(title);
            }}
            title="重命名"
            aria-label="重命名"
            data-testid="session-row-rename"
            className="relative flex size-5 cursor-pointer items-center justify-center rounded-sm text-dim t-fast after:absolute after:-inset-0.5 after:content-[''] hover:bg-hover hover:text-fg"
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
              className="relative flex size-5 cursor-pointer items-center justify-center rounded-sm text-dim t-fast after:absolute after:-inset-0.5 after:content-[''] hover:bg-danger/10 hover:text-accent"
            >
              <Trash2 size={12} />
            </button>
          )}
        </span>
      </div>
      {/* 内容命中的片段（P4c）：标题下方的上下文预览，关键词高亮 */}
      {hit && hit.hits.length > 0 && (
        <div className="mb-0.5 ml-6 mr-2 space-y-0.5 border-l-2 border-accent/40 pl-2">
          {hit.hits.slice(0, 3).map((h, i) => (
            <div
              key={i}
              className="truncate text-[11px] text-dim"
              title={`${hit.count} 处命中 · 点击打开会话`}
            >
              <HitText text={h.text} q={qTrim} />
            </div>
          ))}
        </div>
      )}
      </Fragment>
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

      {/* 过滤行：[全部][★ 收藏] + 在用标签。只在真的用过收藏 / 标签时渲染 ——
          没有它们时整行不存在，侧栏与「没有这功能」时逐像素一致。 */}
      {hasAnyMeta && (
        <div className="flex flex-wrap items-center gap-1 px-3 pb-2" data-testid="session-filter-row">
          <button
            onClick={() => chooseFilter({ kind: "all" })}
            data-testid="session-filter-all"
            className={chipClass(filter.kind === "all")}
          >
            全部
          </button>
          <button
            onClick={() => chooseFilter({ kind: "fav" })}
            data-testid="session-filter-fav"
            className={chipClass(filter.kind === "fav")}
          >
            <Star size={10} className={cn(filter.kind === "fav" && "fill-current")} />
            收藏
          </button>
          {tagOptions.map((tag) => (
            <button
              key={tag.label}
              onClick={() => chooseFilter({ kind: "tag", tag: tag.label })}
              title={`#${tag.label}（${tag.count} 个会话）`}
              data-testid="session-filter-tag"
              className={chipClass(filter.kind === "tag" && filter.tag === tag.label)}
            >
              #{tag.label}
            </button>
          ))}
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
        {/* 未搜完 ≠ 没找到（P4d）：索引未追上或超时截断时明说，并给重建索引入口（仅 Hermes 侧） */}
        {query.trim() && !contentSearching && contentTruncated && (
          <div className="mt-1 flex items-center gap-1.5 px-1 text-[10px] leading-relaxed text-warn">
            <span className="min-w-0">搜索超时，已显示部分结果，请缩小范围或加关键词</span>
            <button
              onClick={handleReindex}
              disabled={reindexing}
              data-testid="reindex-btn"
              className="shrink-0 cursor-pointer text-accent t-fast hover:underline disabled:text-dim"
            >
              {reindexing ? "重建中…" : "重建索引"}
            </button>
          </div>
        )}
      </div>

      {/* Session list */}
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        {/* 搜索结果 / 过滤结果：打平 */}
        {flatMode && (
          <>
            {groups.flat.length === 0 && contentHitSessions.length === 0 && (
              <div className="px-3 py-6 text-center text-[12px] text-dim">
                {contentSearching
                  ? "正在搜索…"
                  : contentTruncated
                    ? "没有找到（搜索未完成，可缩小范围重试）"
                    : filterActive
                      ? "没有匹配的会话"
                      : "没有找到"}
              </div>
            )}
            {groups.flat.map(renderSession)}
            {/* 内容命中但标题不匹配的会话（P4c）追加在尾部，按命中条数降序 */}
            {contentHitSessions.map(renderSession)}
          </>
        )}

        {/* 默认会话组（非项目目录的会话，平铺、无文件夹名） */}
        {!flatMode && groups.defaultGroup && (
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
                  className="relative shrink-0 cursor-pointer rounded-sm p-0.5 text-dim opacity-0 transition-opacity after:absolute after:-inset-1 after:content-[''] hover:text-accent group-hover/hd:opacity-100"
                >
                  <Plus size={12} />
                </button>
              )}
            </div>
            {defaultExpanded && renderGroupBody(defaultSessions, DEFAULT_GROUP_KEY)}
          </div>
        )}

        {/* 项目组 */}
        {!flatMode && groups.projectGroups.length > 0 && (
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
                          className="relative shrink-0 cursor-pointer rounded-sm p-0.5 text-dim opacity-0 transition-opacity after:absolute after:-inset-1 after:content-[''] hover:text-accent group-hover/proj:opacity-100"
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
        {!flatMode && !groups.defaultGroup && groups.projectGroups.length === 0 && (
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
