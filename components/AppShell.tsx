"use client";

import { Menu, MessageSquarePlus, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatView } from "@/components/ChatView";
import { DirPicker } from "@/components/DirPicker";
import { CodeView } from "@/components/CodeView";
import { CandidatesPage } from "@/components/CandidatesPage";
import { HomeDashboard } from "@/components/HomeDashboard";
import { MemoryPage, type MemoryProject } from "@/components/MemoryPage";
import { ModelsPage } from "@/components/ModelsPage";
import { PluginsPage } from "@/components/PluginsPage";
import { SettingsPage } from "@/components/SettingsPage";
import { ShortcutPanel } from "@/components/ShortcutPanel";
import { SkillsPage } from "@/components/SkillsPage";
import { SubagentsPage } from "@/components/SubagentsPage";
import { SystemPage } from "@/components/SystemPage";
import { SystemPromptPage } from "@/components/SystemPromptPage";
import { ThemeToggle } from "@/components/ThemeToggle";
import { WorkstationSidebar, type View } from "@/components/WorkstationSidebar";
import { cn } from "@/components/lib/utils";
import { dialogConfirm, toast } from "@/components/ui/dialog";
import { basename } from "@/lib/format";
import type { SessionInfo } from "@/lib/types";

type SessionsResponse = {
  sessions: SessionInfo[];
  sessionListVersion?: number;
  runningSessionIds?: string[];
};

const PAGE_TITLES: Record<string, string> = {
  code: "代码",
  skills: "技能",
  memory: "记忆",
  prompt: "提示词",
  models: "模型",
  plugins: "插件",
  subagents: "子代理",
  candidates: "并行试验",
  system: "系统",
  settings: "设置",
};

/* 主侧栏收起状态：<1280px 首次进入默认收起，之后跟随用户手动选择 */
const WS_COLLAPSED_KEY = "elenva-ws-sidebar-collapsed";
const WS_AUTO_COLLAPSE_WIDTH = 1280;
/* <1024px 时主侧栏改为浮层抽屉（覆盖内容区），不再占据横向空间 */
const WS_DRAWER_MAX_WIDTH = 1024;

/* ---------------- hash 路由 ---------------- */
function parseHash(): { view: View; sessionId: string | null; newCwd: string | null } {
  const h = window.location.hash.replace(/^#/, "");
  if (h.startsWith("chat/")) {
    const rest = h.slice(5);
    if (rest === "new" || rest.startsWith("new?")) {
      const cwd = rest.startsWith("new?") ? new URLSearchParams(rest.slice(4)).get("cwd") : null;
      return { view: "chat", sessionId: null, newCwd: cwd };
    }
    if (rest) return { view: "chat", sessionId: decodeURIComponent(rest), newCwd: null };
  }
  // 旧深链接兼容：「Git 变更」「文件浏览器」已合并为「代码」
  if (h === "git" || h === "files") return { view: "code", sessionId: null, newCwd: null };
  if (h in PAGE_TITLES) return { view: h as View, sessionId: null, newCwd: null };
  return { view: "home", sessionId: null, newCwd: null };
}

/* ---------------- 主 AppShell ---------------- */
export function AppShell() {
  const [view, setView] = useState<View>("home");
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());
  /** 会话默认工作区（~/pi-workspace，非项目语义；仅由 /api/default-cwd 初始化，勿他写） */
  const [defaultCwd, setDefaultCwd] = useState<string | null>(null);
  /** Git 视图当前定位的项目（会话顶栏分支 chip 跳转时设置；与 defaultCwd 分离，防污染新会话落点） */
  const [gitCwd, setGitCwd] = useState<string | null>(null);
  /** 「代码」页要定位到的文件（从观测栏跳转时设置） */
  const [codeFile, setCodeFile] = useState<string | null>(null);
  /**
   * 「代码」页是否直接进改动清单。
   * 从观测栏 Git 区（「去提交这 N 个文件」）与聊天顶栏分支 chip 进来时为 true ——
   * 这两处都是「我要看/提交改动」的语义；从「本会话文件」进来则定位到具体文件。
   */
  const [codeOnlyChanged, setCodeOnlyChanged] = useState(false);
  const [homeQuery, setHomeQuery] = useState("");
  const [wsCollapsed, setWsCollapsed] = useState(false);
  const [shortcutOpen, setShortcutOpen] = useState(false);
  /** 实际端口：--port / PORT 可改，写死 30200 会在自定义端口时说谎。
      在 effect 里读以避免 SSR/水合不一致。 */
  const [port, setPort] = useState("");
  const [isNarrow, setIsNarrow] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const hashReady = useRef(false);

/** 会话列表版本号：轻量轮询据此判断是否需要全量刷新列表 */
  const listVersionRef = useRef<number | null>(null);

  const refreshSessions = useCallback(async (): Promise<SessionInfo[]> => {
    try {
      const res = await fetch("/api/sessions", { cache: "no-store" });
      const data = (await res.json()) as SessionsResponse;
      setSessions(data.sessions || []);
      const running = new Set(data.runningSessionIds || []);
      setRunningIds(running);
      // 记录会话列表版本，供轻量轮询判断“是否需要全量刷新”
      if (typeof data.sessionListVersion === "number") listVersionRef.current = data.sessionListVersion;
      return data.sessions || [];
    } catch {
      return [];
    }
  }, []);

  /* ---------------- 会话选择 ---------------- */
  const [selected, setSelected] = useState<SessionInfo | null>(null);
  /* 后台完成通知的“上一拍”基准，由轮询 effect 独占维护 */
  const prevRunningRef = useRef<Set<string>>(new Set());
  const selectedRef = useRef<SessionInfo | null>(null);
  selectedRef.current = selected;
  /**
   * 已完成但用户还没看的会话（按 id）。
   * 之前只有一个总数（用于标题栏），列表里没法逐个标「未读」——
   * 而「哪个跑完了」正是这个界面最该一眼看到的东西。
   */
  const [unreadIds, setUnreadIds] = useState<Set<string>>(new Set());
  const [newSessionCwd, setNewSessionCwd] = useState<string | null>(null);
  /** 新会话用户显式选择的工作区（null = 跟随默认工作区；首条消息发送时才落定） */
  const [newChatWorkspace, setNewChatWorkspace] = useState<string | null>(null);

  /* ---------------- 后台会话完成通知 ----------------
     轮询分工（上一拍基准 prevRunningRef 由本处理独占维护）：
       · /api/agent/running 每 3s —— 极轻量快照（版本号 + 运行中 id）
       · /api/sessions 仅在「有会话刚结束」或「会话列表版本变了」时全量拉
     这样后台会话完成的感知从 20s 降到 ~3s，总请求量反而更少。 */
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/agent/running", { cache: "no-store" });
        if (!res.ok) return;
        const snap = (await res.json()) as {
          sessionListVersion?: number;
          runningSessionIds?: string[];
        };
        if (stopped) return;
        const next = new Set(snap.runningSessionIds ?? []);
        const finished = [...prevRunningRef.current].filter((id) => !next.has(id));
        prevRunningRef.current = next;
        setRunningIds(next);

        const versionChanged =
          snap.sessionListVersion !== undefined && listVersionRef.current !== null
            && snap.sessionListVersion !== listVersionRef.current;
        if (snap.sessionListVersion !== undefined) listVersionRef.current = snap.sessionListVersion;

        if (finished.length === 0 && !versionChanged) return;
        const list = await refreshSessions();
        if (stopped) return;
        for (const id of finished) {
          // 当前打开的会话由 ChatView 实时感知，不重复通知
          if (id === selectedRef.current?.id) continue;
          const s = list.find((x) => x.id === id);
          const name = (s?.name || s?.firstMessage || "会话").slice(0, 32);
          toast(`「${name}」已完成`);
          setUnreadIds((prev) => new Set(prev).add(id));
        }
      } catch {
        /* 网络抖动：下一拍重试 */
      }
    };

    /* 常驻轮询（原来是 `if (runningIds.size === 0) return;`）：
       那个门控让「在一个已打开的会话里发消息」变成不可感知的事件 ——
       refreshSessions 只在挂载 / 回合结束 / 新建会话 / 删除重命名时触发，
       所以回合【开始】时没人告诉 AppShell，侧栏与工作台的「运行中」指示只能在
       回合结束后才刷新一次（那时已经不在运行了），看起来就是永远不亮。
       代价：这个快照只有版本号 + 运行中 id，且后台标签页不打网络。 */
    const timer = setInterval(() => {
      if (document.hidden) return;
      void tick();
    }, 3000);
    void tick();

    /* 切回前台立刻对齐一次，不用等下一拍 */
    const onVisible = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshSessions]);

  /* 标题栏未读提示 */
  useEffect(() => {
    document.title = unreadIds.size > 0 ? `(${unreadIds.size}) ELENVA · 工作台` : "ELENVA · 工作台";
  }, [unreadIds]);
  /* 打开某个会话即视为已读（只清那一个，不是全清 —— 其它会话的完成状态仍然要看得到） */
  useEffect(() => {
    if (!selected?.id) return;
    setUnreadIds((prev) => {
      if (!prev.has(selected.id)) return prev;
      const next = new Set(prev);
      next.delete(selected.id);
      return next;
    });
  }, [selected?.id]);

  /* 首次挂载：从 hash 恢复视图/会话（深链接）。在 effect 里做以保证 SSR 一致 */
  useEffect(() => {
    const p = parseHash();
    if (p.view === "chat" && p.sessionId) {
      const tryRestore = async () => {
        // 空列表可能是瞬时失败/冷启动，重试几次再判「未找到」
        let list = await refreshSessions();
        for (let i = 0; i < 3 && list.length === 0; i++) {
          await new Promise((r) => setTimeout(r, 800));
          list = await refreshSessions();
        }
        const found = list.find((s) => s.id === p.sessionId);
        if (found) {
          setSelected(found);
          setView("chat");
        } else {
          setView("home");
        }
        hashReady.current = true;
      };
      tryRestore();
    } else {
      if (p.view !== "home") setView(p.view);
      if (p.newCwd) {
        setNewSessionCwd(p.newCwd);
        setNewChatWorkspace(p.newCwd);
      }
      hashReady.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * hash 同步：view/session 变化时写回地址栏。
   *
   * 这里用 pushState 而不是 replaceState —— 原来全量 replaceState 从不产生历史条目，
   * 于是浏览器后退会直接离开应用（回不到工作台上一页）。
   * 只有「首次同步」（深链接恢复）用 replaceState，避免多一条无意义历史。
   */
  const syncedHashRef = useRef<string | null>(null);
  useEffect(() => {
    if (!hashReady.current) return; // 等深链接恢复完成
    let hash = "#home";
    if (view === "chat") {
      hash = selected
        ? `#chat/${encodeURIComponent(selected.id)}`
        : newSessionCwd
          ? `#chat/new?cwd=${encodeURIComponent(newSessionCwd)}`
          : "#chat/new";
    } else if (view !== "home") {
      hash = `#${view}`;
    }
    if (typeof window === "undefined") return;
    // 地址栏已经是目标值（通常是前进/后退触发的状态同步）→ 不写历史
    if (window.location.hash === hash) {
      syncedHashRef.current = hash;
      return;
    }
    if (syncedHashRef.current === null) {
      window.history.replaceState(null, "", hash);
    } else {
      window.history.pushState(null, "", hash);
    }
    syncedHashRef.current = hash;
  }, [view, selected, newSessionCwd]);

  /* 浏览器前进/后退（hashchange 只在真实 hash 跳转时触发，replaceState 不会） */
  useEffect(() => {
    const onHash = () => {
      const p = parseHash();
      // 前进/后退驱动的同步：记录已同步的 hash，避免随后的写回 effect 再压一条历史
      syncedHashRef.current = window.location.hash;
      if (p.view === "chat" && p.sessionId) {
        const found = sessions.find((s) => s.id === p.sessionId);
        if (found) {
          setSelected(found);
          setNewSessionCwd(null);
          setView("chat");
          return;
        }
        refreshSessions().then((list) => {
          const f = list.find((s) => s.id === p.sessionId);
          if (f) {
            setSelected(f);
            setNewSessionCwd(null);
            setView("chat");
          } else setView("home");
        });
        return;
      }
      setSelected(null);
      setNewSessionCwd(p.newCwd ?? null);
      setNewChatWorkspace(p.newCwd ?? null);
      if (p.view === "chat" && !p.newCwd && defaultCwd) setNewSessionCwd(defaultCwd);
      setView(p.view);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [sessions, defaultCwd, refreshSessions]);

  useEffect(() => {
    refreshSessions();
    fetch("/api/default-cwd", { method: "POST" })
      .then((r) => r.json())
      .then((d: { cwd?: string }) => d.cwd && setDefaultCwd(d.cwd))
      .catch(() => {});
  }, [refreshSessions]);

  useEffect(() => {
    setPort(window.location.port);
  }, []);

  /* ---------------- 主侧栏收起状态 ---------------- */
  useEffect(() => {
    const saved = localStorage.getItem(WS_COLLAPSED_KEY);
    if (saved !== null) setWsCollapsed(saved === "1");
    else if (window.innerWidth < WS_AUTO_COLLAPSE_WIDTH) setWsCollapsed(true);
  }, []);
  const toggleWsSidebar = useCallback(() => {
    setWsCollapsed((v) => {
      localStorage.setItem(WS_COLLAPSED_KEY, v ? "0" : "1");
      return !v;
    });
  }, []);

  /* ---------------- 窄屏（<1024px）：主侧栏转为浮层抽屉 ---------------- */
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${WS_DRAWER_MAX_WIDTH - 1}px)`);
    const apply = () => {
      setIsNarrow(mq.matches);
      if (!mq.matches) setDrawerOpen(false);
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  /* ---------------- 键盘快捷键 ---------------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const inField = tag === "INPUT" || tag === "TEXTAREA";

      // ?：唤起 / 收起快捷键总览（不带修饰键；输入框内不拦截，避免打不出问号）
      if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey && !inField) {
        e.preventDefault();
        setShortcutOpen((v) => !v);
        return;
      }

      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (e.key.toLowerCase() === "k" && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        if (view === "home") {
          document.getElementById("home-search")?.focus();
        } else {
          document.getElementById("session-search")?.focus();
        }
        return;
      }
      // Ctrl/Cmd+Alt+N：新建会话
      if (e.key.toLowerCase() === "n" && e.altKey) {
        e.preventDefault();
        handleNewChatRef.current();
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view]);
  const handleNewChatRef = useRef<() => void>(() => {});

  /* ---------------- ChatView 回调 ---------------- */
  const handleSessionCreated = useCallback(
    (created: SessionInfo) => {
      setSelected(created);
      setNewSessionCwd(null);
      setNewChatWorkspace(null);
      refreshSessions();
    },
    [refreshSessions],
  );

  const handleSessionForked = useCallback(
    async (newSessionId: string) => {
      const list = await refreshSessions();
      const found = list.find((s) => s.id === newSessionId);
      if (found) openChatWith(found);
    },
    [refreshSessions],
  );

  /* ---------------- 新建会话：工作区在首条消息发送前可自由切换 ---------------- */
  const [dirPickerOpen, setDirPickerOpen] = useState(false);
  // 全局「新建会话」：不预设项目/默认之分，直接开一个空会话，
  // 落点由输入框下方的「工作区」选择器决定（不选 = 默认工作区）。
  // 无默认目录时兜底弹目录选择器（极端情况：default-cwd 接口失败）。
  const handleNewChat = useCallback(() => {
    setNewChatWorkspace(null);
    if (defaultCwd) {
      setSelected(null);
      setNewSessionCwd(defaultCwd);
      setDirPickerOpen(false);
      setView("chat");
    } else {
      setDirPickerOpen(true);
    }
  }, [defaultCwd]);
  handleNewChatRef.current = handleNewChat;
  /** 「新建项目」/ 选择器里的「打开本地文件夹」：显式选择目录 */
  const openDirPicker = useCallback(() => setDirPickerOpen(true), []);

  const startChatWithCwd = (cwd: string) => {
    setSelected(null);
    setNewSessionCwd(cwd);
    setNewChatWorkspace(cwd);
    setDirPickerOpen(false);
    setView("chat");
  };

  /** 空态新会话里切换工作区：null 表示回到默认工作区 */
  const pickNewChatWorkspace = useCallback(
    (cwd: string | null) => {
      setNewChatWorkspace(cwd);
      const resolved = cwd ?? defaultCwd;
      if (resolved) setNewSessionCwd(resolved);
    },
    [defaultCwd],
  );

  const openChatWith = (s: SessionInfo | null) => {
    setNewSessionCwd(null);
    setSelected(s);
    setView("chat");
  };

  /*
   * 按 id 打开会话（并行试验页的「查看会话」用）。会话列表是异步刷新的，
   * 刚跑起来的候选可能还没进列表 —— 先记下 id，列表就绪后再开，
   * 否则会出现「点了没反应」。
   */
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const openSessionById = useCallback((sessionId: string) => {
    const found = sessions.find((s) => s.id === sessionId);
    if (found) {
      openChatWith(found);
      return;
    }
    setPendingSessionId(sessionId);
    void refreshSessions();
  }, [sessions, refreshSessions]);
  useEffect(() => {
    if (!pendingSessionId) return;
    const found = sessions.find((s) => s.id === pendingSessionId);
    if (!found) return;
    setPendingSessionId(null);
    openChatWith(found);
  }, [pendingSessionId, sessions]);

  // 侧栏「会话」导航：无选中会话时自动打开最近会话；没有任何会话则弹目录选择器
  const openChatView = useCallback(() => {
    if (selected) {
      setView("chat");
      return;
    }
    const latest = sessions[0];
    if (latest) {
      setSelected(latest);
      setNewSessionCwd(null);
      setView("chat");
    } else {
      setDirPickerOpen(true);
    }
  }, [selected, sessions]);

  /* ---------------- 会话内容搜索（后端全文） ---------------- */
  const [contentResults, setContentResults] = useState<
    { session: SessionInfo; before: string; match: string; after: string }[]
  >([]);
  const [contentSearching, setContentSearching] = useState(false);
  const [contentTruncated, setContentTruncated] = useState(false);
  useEffect(() => {
    const q = homeQuery.trim();
    if (q.length < 2) {
      setContentResults([]);
      setContentTruncated(false);
      return;
    }
    const t = setTimeout(() => {
      setContentSearching(true);
      fetch(`/api/sessions/search?q=${encodeURIComponent(q)}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((d: { results?: typeof contentResults; truncated?: boolean }) => {
          setContentResults(d.results ?? []);
          setContentTruncated(Boolean(d.truncated));
        })
        .catch(() => {})
        .finally(() => setContentSearching(false));
    }, 350);
    return () => clearTimeout(t);
  }, [homeQuery]);

  /* ---------------- AI 自动命名 ---------------- */
  const handleAutoRename = useCallback(
    async (): Promise<string | null> => {
      if (!selected) return null;
      try {
        const res = await fetch(`/api/sessions/${selected.id}/auto-name`, { method: "POST" });
        const d = await res.json();
        if (res.ok && d.title) {
          setSelected((prev) => (prev ? { ...prev, name: d.title } : prev));
          refreshSessions();
          return d.title;
        }
      } catch {
        /* ignore */
      }
      return null;
    },
    [selected, refreshSessions],
  );

  const handleRenamed = (name: string) => {
    setSelected((prev) => (prev ? { ...prev, name } : prev));
    refreshSessions();
  };

  /**
   * 删除会话之后的落点（两条删除路径共用：侧栏/工作台的 `handleDeleteSession`、
   * 顶栏菜单里 useSessionActions 自己发完 DELETE 后回调的 `handleDeleted`）。
   *
   * 原来是「删掉正在看的会话 → 回工作台」。但工作台跟刚删的会话毫无上下文关系，
   * 等于把用户从当前位置绑走 —— 他本来在看对话，回来却是一张总览。现规则跟主流一致：
   *   · 删的不是当前会话 → 原地不动（只刷新列表）
   *   · 删的是当前会话、且还有别的会话 → 留在聊天视图开一个新的（沿用同一工作区）
   *   · 一个会话都不剩 → 回工作台（聊天空态此时无处可切，没有意义）
   */
  const landAfterSessionRemoval = useCallback(async (removed: SessionInfo | null) => {
    const list = await refreshSessions();
    const current = selectedRef.current;
    if (removed !== null && current !== null && current.id !== removed.id) return;
    if (list.length === 0) {
      setSelected(null);
      setView("home");
      return;
    }
    setSelected(null);
    /* 沿用被删会话的工作区 —— 在同一个项目里继续干活是常见意图 */
    const cwd = removed?.cwd ?? current?.cwd ?? defaultCwd ?? null;
    setNewSessionCwd(cwd);
    setNewChatWorkspace(cwd);
    setView("chat");
  }, [refreshSessions, defaultCwd]);

  const handleDeleted = () => {
    void landAfterSessionRemoval(selectedRef.current);
  };

  const handleDeleteSession = async (s: SessionInfo) => {
    const name = s.name || s.firstMessage || "(无标题)";
    const ok = await dialogConfirm({
      title: "删除会话",
      message: `确定删除会话「${name}」？此操作不可撤销。`,
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/sessions/${s.id}`, { method: "DELETE" });
      if (!res.ok) return;
      toast(`已删除「${name.slice(0, 24)}」`);
      await landAfterSessionRemoval(s);
    } catch {
      /* network error, keep state */
    }
  };

  // 「项目」口径 = 会话涉及的去重目录数（历史日期工作区 ~/pi-cwd-<date> 不计，
  // 与 browseRoots 的过滤保持一致 —— 2026-09-28 反馈）。
  const projectCount = useMemo(
    () => new Set(sessions.map((s) => s.cwd).filter((cwd) => !/pi-cwd-\d{8}\/?$/.test(cwd))).size,
    [sessions],
  );
  const projects = useMemo(() => [...new Set(sessions.map((s) => s.cwd))], [sessions]);
  /**
   * 文件浏览器 / 目录选择器用的目录列表：按**最近活跃**排序，项目根优先。
   *
   * 之前文件浏览器固定打开 defaultCwd（~/pi-workspace 默认工作区），
   * 实测进去只能看到「目录为空」—— 这是它「看起来没用」的真正原因。
   */
  const browseRoots = useMemo(() => {
    const latest = new Map<string, string>();
    for (const s of sessions) {
      const root = (s.isProject && s.repoRoot) || s.cwd;
      if (!root || root === "unknown") continue;
      // 旧默认工作区（~/pi-cwd-<date>）不进目录列表：它们只是历史日期容器，
      // 排在列表前部很扎眼（2026-09-28 反馈「三个工作区都是默认会话创建的」）。
      if (/pi-cwd-\d{8}\/?$/.test(root)) continue;
      const prev = latest.get(root);
      if (prev === undefined || (s.modified || "") > prev) latest.set(root, s.modified || "");
    }
    return [...latest.entries()].sort((a, b) => b[1].localeCompare(a[1])).map(([root]) => root);
  }, [sessions]);

  /**
   * Git 视图的项目列表：首选真实项目（isProject 的 repoRoot）。
   * 直接拿全部 cwd 会把默认工作区（~/pi-workspace 这类非项目目录）也当成项目，
   * 一进「Git 变更」就选中它 → 恒显「该目录不是 Git 仓库」。
   */
  const gitProjects = useMemo(() => {
    const roots = new Set<string>();
    for (const s of sessions) {
      if (!s.isProject) continue;
      const root = s.repoRoot || s.cwd;
      if (root && root !== "unknown") roots.add(root);
    }
    return roots.size > 0 ? [...roots] : projects;
  }, [sessions, projects]);
  /** 记忆页的项目列表：按 repoRoot 聚合（worktree 归主仓库），最近活跃在前 */
  const memoryProjects = useMemo<MemoryProject[]>(() => {
    const norm = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
    const map = new Map<string, { name: string; path: string; latest: string }>();
    for (const s of sessions) {
      const root = (s.isProject && s.repoRoot) || s.cwd;
      if (!root || root === "unknown") continue;
      const prev = map.get(norm(root));
      if (!prev || (s.modified || "") > prev.latest) {
        map.set(norm(root), { name: basename(root), path: root, latest: s.modified || "" });
      }
    }
    const list = [...map.values()].sort((a, b) => b.latest.localeCompare(a.latest));
    // 重名项目：追加父目录消歧
    const nameCount = new Map<string, number>();
    for (const p of list) nameCount.set(p.name, (nameCount.get(p.name) ?? 0) + 1);
    for (const p of list) {
      if ((nameCount.get(p.name) ?? 0) > 1) {
        const parts = p.path.replace(/[\\/]+$/, "").split(/[\\/]/);
        const parent = parts[parts.length - 2];
        if (parent) p.name = `${p.name} · ${parent}`;
      }
    }
    return list.map(({ name, path }) => ({ name, path }));
  }, [sessions]);
  const runningCount = runningIds.size;

  const filteredHomeSessions = useMemo(() => {
    const q = homeQuery.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) =>
        (s.name || s.firstMessage || "").toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q),
    );
  }, [sessions, homeQuery]);

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-bg text-fg">
      {/* 窄屏抽屉遮罩：点击任意处收起 */}
      {isNarrow && drawerOpen && (
        <div className="fixed inset-0 z-[90] bg-overlay" onClick={() => setDrawerOpen(false)} aria-hidden="true" />
      )}
      <WorkstationSidebar
        view={view}
        onViewChange={(v) => {
          if (v === "chat") openChatView();
          else {
            if (v !== "code") {
              setCodeFile(null);
              setCodeOnlyChanged(false);
            }
            setView(v);
          }
          setDrawerOpen(false);
        }}
        sessionCount={sessions.length}
        runningCount={runningCount}
        projectCount={projectCount}
        defaultCwd={defaultCwd}
        collapsed={wsCollapsed}
        onToggle={() => (isNarrow ? setDrawerOpen(false) : toggleWsSidebar())}
        drawer={isNarrow}
        drawerOpen={drawerOpen}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        {/* 顶栏（chat 视图由 ChatView 自带顶栏） */}
        {view !== "chat" && (
          <header className="flex h-13 shrink-0 items-center gap-3.5 border-b border-line bg-panel/90 px-6">
            {isNarrow && (
              <button
                onClick={() => setDrawerOpen(true)}
                aria-label="打开导航"
                className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-dim t-fast hover:bg-hover hover:text-fg"
              >
                <Menu size={16} />
              </button>
            )}
            {view === "home" ? (
              <div className="flex h-8 max-w-md flex-1 items-center gap-2 rounded-lg border border-line bg-panel-2 px-3 text-dim">
                <Search size={14} />
                <input
                  id="home-search"
                  value={homeQuery}
                  onChange={(e) => setHomeQuery(e.target.value)}
                  placeholder="搜索会话、项目…（Ctrl+K）"
                  className="w-full bg-transparent text-[13px] text-fg outline-none placeholder:text-dim"
                />
              </div>
            ) : (
              <>
                <button
                  onClick={() => setView("home")}
                  className="cursor-pointer text-[13px] text-dim t-fast hover:text-fg"
                >
                  工作台
                </button>
                <span className="text-dim/50">/</span>
                <span className="text-[14px] font-semibold">{PAGE_TITLES[view]}</span>
              </>
            )}
            {/* 全局簇：所有视图一致的常驻控件（chat 的独立顶栏里也有同样顺序的一份）。
                原「运行中/全部空闲」胶囊已移除 —— 同一状态在 hero 状态条 / 侧栏统计卡 / 页脚已有三处。 */}
            <div className="ml-auto flex items-center gap-3.5">
              <ThemeToggle />
              <button
                onClick={handleNewChat}
                className="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-accent px-3.5 text-[12px] font-semibold text-accent-fg t-fast hover:bg-accent-hover"
              >
                <MessageSquarePlus size={14} />
                新建会话
              </button>
            </div>
          </header>
        )}

        {/* 视图内容 */}
        {view === "home" && (
          <HomeDashboard
            sessions={filteredHomeSessions}
            runningIds={runningIds}
            unreadIds={unreadIds}
            onOpenSession={openChatWith}
            onViewAll={openChatView}
            onOpenSystem={() => setView("system")}
            contentResults={contentResults}
            contentSearching={contentSearching}
            contentTruncated={contentTruncated}
            defaultCwd={defaultCwd}
          />
        )}
        {view === "code" && (
          <CodeView
            roots={browseRoots}
            defaultCwd={defaultCwd}
            initialCwd={gitCwd}
            initialFile={codeFile}
            initialOnlyChanged={codeOnlyChanged}
          />
        )}
        {view === "skills" && <SkillsPage defaultCwd={defaultCwd} />}
        {view === "memory" && <MemoryPage projects={memoryProjects} />}
        {view === "prompt" && <SystemPromptPage defaultCwd={defaultCwd} projects={memoryProjects} />}
        {view === "models" && <ModelsPage />}
        {view === "plugins" && <PluginsPage defaultCwd={defaultCwd} />}
        {view === "subagents" && <SubagentsPage defaultCwd={defaultCwd} />}
        {view === "candidates" && (
          <CandidatesPage
            projects={memoryProjects}
            defaultCwd={defaultCwd}
            onOpenSession={openSessionById}
          />
        )}
        {view === "system" && <SystemPage />}
        {view === "settings" && <SettingsPage projects={memoryProjects} defaultCwd={defaultCwd} />}
        {view === "chat" && (
          <ChatView
            key={selected?.id ?? "new"}
            session={selected}
            newSessionCwd={newChatWorkspace ?? defaultCwd}
            sessions={sessions}
            runningIds={runningIds}
            unreadIds={unreadIds}
            onOpenNav={isNarrow ? () => setDrawerOpen(true) : undefined}
            onNewChat={handleNewChat}
            onCreateInProject={startChatWithCwd}
            onCreateProject={openDirPicker}
            pickedWorkspace={newChatWorkspace}
            onPickWorkspace={pickNewChatWorkspace}
            defaultCwd={defaultCwd}
            onDeleteSession={handleDeleteSession}
            onRenamed={handleRenamed}
            onDeleted={handleDeleted}
            onAutoRename={handleAutoRename}
            onSessionCreated={handleSessionCreated}
            onSessionForked={handleSessionForked}
            onAgentEnd={refreshSessions}
            onRefreshSessions={refreshSessions}
            onOpenSession={openChatWith}
            onOpenGit={(cwd) => {
              setGitCwd(cwd);
              setCodeFile(null);
              setCodeOnlyChanged(true);
              setView("code");
            }}
            onOpenCode={(file, cwd) => {
              if (cwd) setGitCwd(cwd);
              setCodeFile(file);
              setCodeOnlyChanged(false);
              setView("code");
            }}
            onOpenSubagents={() => setView("subagents")}
            onOpenSettings={() => setView("settings")}
            onExit={() => {
              setSelected(null);
              setNewSessionCwd(null);
              setView("home");
            }}
          />
        )}

        {/* 底部状态栏 */}
        <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-line bg-panel px-6 text-[11px] text-dim">
          <span className="flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-success" />
            ELENVA Web {process.env.NEXT_PUBLIC_APP_VERSION || "v0.1.0"} · 运行中
          </span>
          {/* 内核状态与「ELENVA · 运行中」同构，放在 Pi 版本旁：
              这样任何视图下都能看到内核是否在干活，侧栏就不必再重复一份。 */}
          <span className="flex items-center gap-1.5">
            <span
              className={cn(
                "size-1.5 rounded-full",
                runningCount > 0 ? "bg-accent anim-pulse-dot" : "bg-success",
              )}
            />
            Pi {process.env.NEXT_PUBLIC_PI_VERSION || "—"} · 内核
            {runningCount > 0 ? `工作中（${runningCount} 个会话）` : "就绪"}
          </span>
          <span className="ml-auto">{port ? `端口 ${port}` : null}</span>
          <button
            onClick={() => {
              setView("settings");
              // 页脚入口的语义是「去检查更新」：跳设置后滚到「关于」区块。
              // 两个坑（2026-09-21 实测）：
              //  1. 不要用 el.scrollIntoView —— 页面外还套着一层 overflow-hidden 容器，它同样可被
              //     程序化滚动（幽灵滚动），scrollIntoView 会连它一起拖走、把整个应用顶出可视区；
              //  2. 不要用 behavior:"smooth" —— 标签页隐藏时（后台/自动化）Chrome 会挂起平滑滚动，
              //     调用直接静默失效。用瞬时滚动保证任何状态下都到位。
              // 另外设置页 chunk 冷加载时元素可能还没渲染，轮询等它出现，只滚设置页自己的容器。
              let tries = 0;
              const seek = () => {
                const el = document.getElementById("settings-about");
                const sc =
                  el?.closest<HTMLElement>("[data-page-scroll]") ?? el?.closest<HTMLElement>(".overflow-y-auto");
                if (el && sc) {
                  const delta = el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 12;
                  if (Math.abs(delta) > 4) sc.scrollTo({ top: sc.scrollTop + delta, behavior: "auto" });
                  return;
                }
                if (tries++ < 25) setTimeout(seek, 100);
              };
              setTimeout(seek, 80);
            }}
            className="cursor-pointer text-accent t-fast hover:text-accent-hover"
          >
            检查更新
          </button>
        </footer>
      </main>

      {/* 目录选择器（新建会话） */}
      <DirPicker
        open={dirPickerOpen}
        onClose={() => setDirPickerOpen(false)}
        onPick={startChatWithCwd}
        defaultCwd={defaultCwd}
      />

      {/* 快捷键总览（? 唤起） */}
      <ShortcutPanel open={shortcutOpen} onClose={() => setShortcutOpen(false)} />
    </div>
  );
}
