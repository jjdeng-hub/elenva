"use client";

import { Columns2, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, GitBranch, Menu, Plus, Search, X } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentStatusBar } from "@/components/AgentStatusBar";
import { ChatInput, type ContextHistory } from "@/components/ChatInput";
import { ChatWindow } from "@/components/ChatWindow";
import { ExtensionDialog } from "@/components/ExtensionDialog";
import { FilePreviewPanel } from "@/components/FilePreviewPanel";
import { LogoMark } from "@/components/Logo";
import { SessionObservatory } from "@/components/SessionObservatory";
import { RailTabs } from "@/components/RailTabs";
import { TurnFooter } from "@/components/TurnFooter";
import { TodoPanel } from "@/components/TodoPanel";
import { ExtensionStrip } from "@/components/ExtensionStrip";
import { ModelPicker } from "@/components/ModelPicker";
import { ProjectTrustDialog } from "@/components/ProjectTrustDialog";
import { SessionTitle } from "@/components/SessionTitle";
import { SessionGoal } from "@/components/SessionGoal";
import { SideSessionPane } from "@/components/SideSessionPane";
import { SessionSidebar } from "@/components/SessionSidebar";
import { WorkspacePicker, type WorkspaceOption } from "@/components/WorkspacePicker";
import { useAgentSession, type AttachedImage, type ChatInputHandle } from "@/hooks/useAgentSession";
import { useSessionActions } from "@/hooks/useSessionActions";
import { usePersistedWidth } from "@/components/ui/Resizer";
import { extractTurnWrittenFiles } from "@/lib/turn-written-files";
import { computeTurnTrends } from "@/lib/turn-trends";
import { useTurnCheckpoints } from "@/hooks/useTurnCheckpoints";
import { latestTodoState } from "@/lib/todo-view";
import { resolveLocalFilePath } from "@/lib/file-links";
import type { SessionInfo, ToolResultMessage } from "@/lib/types";
import type { ToolEntry } from "@/lib/tool-presets";
import type { CompactionRecord } from "@/lib/compaction-records";
import { basename, formatCost, formatTokens } from "@/lib/format";
import { toast, dialogConfirm, dialogPrompt } from "@/components/ui/dialog";
import type { RememberCallbackTarget, RememberHandler, RememberTarget } from "@/components/MessageView";
import type { SessionTemplate } from "@/lib/templates";

const SIDEBAR_COLLAPSED_KEY = "elenva-chat-sidebar-collapsed";
const OBSERVATORY_KEY = "elenva-chat-observatory";
/** 观测栏需要的最小窗宽（与 Tailwind xl 断点对齐） */
const OBSERVATORY_MIN_WIDTH = 1280;
/** 并排副屏的最小窗宽：再窄就放不下「对话 + 副屏 >=380px」两列 */
const SIDE_PANE_MIN_WIDTH = 1440;
/**
 * 副屏与观测栏**共存**所需的最小窗宽。
 * 口径（2026-10-15 补修）：<1700 时二者互斥 —— 观测栏优先，冲突时收起副屏；
 * ≥1700 才允许并存（对话 | 副屏 | 观测）。1600 宽下三列会把主对话挤到 ~200px，实测不可用。
 */
const SIDE_PANE_COEXIST_MIN_WIDTH = 1700;

/** 右侧槽位同时只承载一个面板：文件预览 / 观测栏 */
type RightPanel = "files" | "observatory" | null;

/** Windows 路径比较用：去尾分隔符 + 小写 */
function normPath(p: string): string {
  return p.replace(/[\\/]+$/, "").toLowerCase();
}

/**
 * 单个会话的聊天视图。
 * useAgentSession 的会话加载是 mount-only effect，因此父级必须用 key
 * （会话 id / 新会话 cwd）强制本组件在切换会话时重挂载。
 */
export function ChatView({
  session,
  newSessionCwd,
  sessions,
  runningIds,
  onNewChat,
  onCreateInProject,
  onCreateProject,
  pickedWorkspace,
  onPickWorkspace,
  defaultCwd,
  onDeleteSession,
  onRenamed,
  onDeleted,
  onAutoRename,
  onSessionCreated,
  onSessionForked,
  onAgentEnd,
  onRefreshSessions,
  onOpenSession,
  onOpenGit,
  onOpenCode,
  onOpenSubagents,
  onOpenSettings,
  onExit,
  onOpenNav,
  unreadIds,
  sideSessionId,
  onSelectSide,
}: {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  sessions: SessionInfo[];
  runningIds: Set<string>;
  /** 已完成但用户未查看的会话（列表里显示绿点） */
  unreadIds?: Set<string>;
  onNewChat: () => void;
  /** 在指定项目根下新建会话（会话侧栏项目行的 +） */
  onCreateInProject?: (cwd: string) => void;
  /** 新建项目（打开目录选择器） */
  onCreateProject?: () => void;
  /** 新会话用户显式选择的工作区（null = 未选择，跟随默认工作区） */
  pickedWorkspace?: string | null;
  /** 空态新会话切换工作区（null = 回到默认工作区） */
  onPickWorkspace?: (cwd: string | null) => void;
  /** 默认会话目录（新建会话的落点） */
  defaultCwd?: string | null;
  onDeleteSession: (s: SessionInfo) => void;
  onRenamed: (name: string) => void;
  onDeleted: () => void;
  onAutoRename: () => Promise<string | null>;
  onSessionCreated: (created: SessionInfo) => void;
  onSessionForked: (newSessionId: string) => void;
  onAgentEnd: () => void;
  onRefreshSessions: () => void;
  onOpenSession: (s: SessionInfo) => void;
  /** 跳转到 Git 视图并定位到指定项目 */
  onOpenGit?: (cwd: string) => void;
  /** 跳转到「代码」页并定位到指定文件 */
  onOpenCode?: (file: string, cwd: string) => void;
  /** 跳转到「子代理」页 */
  onOpenSubagents?: () => void;
  /** 跳转到设置页 */
  onOpenSettings?: () => void;
  onExit: () => void;
  /** 窄屏下由外壳注入：唤起主侧栏抽屉（宽屏为 undefined，不渲染入口） */
  onOpenNav?: () => void;
  /** 副屏正在观察的会话 id（由外壳持有，便于写进 URL） */
  sideSessionId?: string | null;
  /** 切换副屏会话；传 null 收起副屏 */
  onSelectSide?: (sessionId: string | null) => void;
}) {
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  /** 当前会话可用工具全集（get_tools 回读，供自定义工具选择 UI 分组展示） */
  const [systemTools, setSystemTools] = useState<ToolEntry[] | null>(null);
  const {
    loading, error, messages, streamState, agentRunning, agentPhase,
    data,
    contextUsage, displayModel, modelNames, modelList, modelSwitching,
    thinkingLevel, modelThinkingLevels,
    entryIds, forkingEntryId, isCompacting, slashCommands,
    queuedMessages,
    extensionWidgets, extensionStatuses,
    extensionDialog, respondToExtensionUi,
    toolPreset, steeringMode, followUpMode,
    handleSend, handleAbort, scrollToBottom, scrollContainerRef,
    handleModelChange, handleThinkingLevelChange, handleToolPresetChange,
    handleToolSelectionChange,
    loadModels, loadSystemInfo,
    handleFork, handleCompact, handleBuiltinSlashCommand,
    handleSteer, handleFollowUp, handleRecallQueue,
    sessionStats,
    retryInfo, compactResult, compactError, handleAbortCompaction,
    modelError, modelScopeWarnings, notices,
    bashRunning, pendingBash,
    hasEarlierMessages, loadingEarlier, loadEarlier,
    lastUserMsgRef,
  } = useAgentSession({
    session,
    newSessionCwd,
    // 新会话草稿统一挂在「待发会话」上：切换工作区不丢草稿。
    // 必须与下方 draftKey 的新会话值一致（rekeyDraft 按它迁移到正式会话 id）。
    newSessionDraftKey: "new",
    chatInputRef,
    onSystemToolsChange: setSystemTools,
    onAgentEnd,
    onSessionCreated,
    onSessionForked,
  });

  // 自定义工具选择的可用清单：切会话时先清空，避免上一条会话的工具串台。
  const sessionToolsKey = session?.id ?? (newSessionCwd ? "__new__" : null);
  useEffect(() => {
    setSystemTools(null);
  }, [sessionToolsKey]);



  /* ---------- hook 通知通道 → 全局 Toast ----------
     内核的失败反馈（模型切换失败 / 扩展命令出错 / 队列召回失败 …）由
     useAgentSession 的 notice 队列承载，但此前没有任何组件消费，导致
     11 处 addNotice 全部静默：切模型失败时界面毫无反应。这里接到 Toast。 */
  const seenNoticeIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const n of notices) {
      if (seenNoticeIds.current.has(n.id)) continue;
      seenNoticeIds.current.add(n.id);
      toast(n.message);
    }
  }, [notices]);

  /* ---------- 会话内搜索（Ctrl+F / 顶栏按钮）---------- */
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && !e.altKey && !e.shiftKey) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        e.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => searchInputRef.current?.focus());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQ("");
  }, []);

  /* 右侧观测栏（会话实时数据）。
     横向余量不足时必须整栏隐藏：220(主侧栏) + 256(会话列表) + 320(观测栏) = 796px，
     1280px 窗宽下聊天区只剩 ~480px，比不显示更糟。 */
  const [railAllowed, setRailAllowed] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${OBSERVATORY_MIN_WIDTH}px)`);
    const apply = () => setRailAllowed(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  /* 右侧只有一个槽位，所以用**单一状态**而不是三个独立布尔：
     多个布尔 + 渲染优先级会拼出一个看不见的旧状态 —— 文件开着时点观测栏没反应，
     关掉文件之后观测栏又按那个旧状态冒出来。改成单一状态后，谁显示就是谁。 */
  const [rightPanel, setRightPanel] = useState<RightPanel>(null);
  useEffect(() => {
    const saved = localStorage.getItem(OBSERVATORY_KEY);
    if (saved !== null) setRightPanel(saved === "1" ? "observatory" : null);
    else if (window.innerWidth >= 1440) setRightPanel("observatory");
  }, []);
  /** 最近一次打开的面板：顶栏开关收起后再展开时回到这一页 */
  const lastRailPanelRef = useRef<Exclude<RightPanel, null>>("observatory");

  /* 三个右侧面板共用同一宽度：由 ChatView 持有单一持久化状态，再把 width/grow/reset
     传给具体面板。此前面板各自 usePersistedWidth（观测 420 / 文件 340），
     切换面板宽度会跳变；统一后拖拽任一面板即同时改变三者。 */
  const {
    width: railPanelWidth,
    grow: growRailPanel,
    reset: resetRailPanel,
  } = usePersistedWidth("elenva-chat-rail-width", 420, 300, 640);
  useEffect(() => {
    if (rightPanel) lastRailPanelRef.current = rightPanel;
  }, [rightPanel]);
  /** 面板头标签栏点击：直接切换（右栏保持打开，只换内容页） */
  const selectPanel = useCallback((panel: Exclude<RightPanel, null>) => {
    setRightPanel(panel);
    // 只有观测栏有持久化偏好；切到文件不覆写它
    if (panel === "observatory") localStorage.setItem(OBSERVATORY_KEY, "1");
  }, []);
  /** 收起整个右栏（面板头的 × 与顶栏开关共用） */
  const closeRail = useCallback(() => {
    setRightPanel((v) => {
      if (v === "observatory") localStorage.setItem(OBSERVATORY_KEY, "0");
      return null;
    });
  }, []);
  /** 程序化打开观测栏（本轮明细入口）：算一次显式打开，持久化 */
  const showObservatory = useCallback(() => {
    localStorage.setItem(OBSERVATORY_KEY, "1");
    setRightPanel("observatory");
  }, []);

  /* ---------- 并排副屏（只读）----------
     副屏的开合状态放在 ChatView（外壳只持有 sideSessionId 以便写 URL）。
     视口 <1440 不提供开关；带 ?side= 深链接进窄窗时只降级为不渲染，URL 保留。 */
  const [sideAllowed, setSideAllowed] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${SIDE_PANE_MIN_WIDTH}px)`);
    const apply = () => setSideAllowed(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  const [sidePaneOpen, setSidePaneOpen] = useState(sideSessionId != null);

  /* 宽窗才允许副屏与观测栏并存；<1700 互斥（冲突处理见下方 shownPanel 之后的 effect） */
  const [sideCoexistAllowed, setSideCoexistAllowed] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${SIDE_PANE_COEXIST_MIN_WIDTH}px)`);
    const apply = () => setSideCoexistAllowed(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  /** 最近一次观察的会话：收起后再展开时优先回到它 */
  const lastSideRef = useRef<string | null>(sideSessionId ?? null);
  useEffect(() => {
    if (sideSessionId) lastSideRef.current = sideSessionId;
  }, [sideSessionId]);

  /* 外壳改 sideSessionId（深链接恢复 / 前进后退）：有值即展开，被清空则收起 */
  const prevSideIdRef = useRef<string | null>(sideSessionId ?? null);
  useEffect(() => {
    if (sideSessionId) setSidePaneOpen(true);
    else if (prevSideIdRef.current) setSidePaneOpen(false);
    prevSideIdRef.current = sideSessionId ?? null;
  }, [sideSessionId]);

  /** 默认副屏会话：优先运行中的（观感最有用），否则列表里第一个别的会话 */
  const pickDefaultSide = useCallback(() => {
    const others = sessions.filter((s) => s.id !== session?.id);
    return others.find((s) => runningIds.has(s.id))?.id ?? others[0]?.id ?? null;
  }, [sessions, runningIds, session?.id]);

  /** 开关副屏：收起时清掉 side（同步 URL）；展开时先回到上次观察的会话 */
  const toggleSidePane = useCallback(() => {
    if (sidePaneOpen) {
      setSidePaneOpen(false);
      if (sideSessionId) onSelectSide?.(null);
      return;
    }
    setSidePaneOpen(true);
    const remembered =
      lastSideRef.current && sessions.some((s) => s.id === lastSideRef.current)
        ? lastSideRef.current
        : null;
    onSelectSide?.(remembered ?? pickDefaultSide());
  }, [sidePaneOpen, sideSessionId, onSelectSide, sessions, pickDefaultSide]);

  const closeSidePane = useCallback(() => {
    setSidePaneOpen(false);
    onSelectSide?.(null);
  }, [onSelectSide]);

  /* 打开副屏时收起右栏（一次性，不写偏好 —— 用户随后可自行重开观测栏） */
  const sideWasOpenRef = useRef(false);
  useEffect(() => {
    if (sidePaneOpen && !sideWasOpenRef.current) setRightPanel(null);
    sideWasOpenRef.current = sidePaneOpen;
  }, [sidePaneOpen]);

  /* 侧栏折叠（响应式默认：窄屏折叠），状态持久化 */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  useEffect(() => {
    const saved = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
    if (saved !== null) setSidebarCollapsed(saved === "1");
    else if (window.innerWidth < 1280) setSidebarCollapsed(true);
  }, []);
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((v) => {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, v ? "0" : "1");
      return !v;
    });
  }, []);

  /* 传给 ChatWindow 的翻页回调必须稳定，否则滚动监听的 IntersectionObserver 每次渲染都重建 */
  const handleLoadEarlier = useCallback(() => {
    void loadEarlier();
  }, [loadEarlier]);

  /**
   * 跳转：观测栏的失败清单不再使用（本轮清理，无调用者）。
   * 消息跳转现已归 ChatWindow 内部（搜索跳转 / 导航细条共用同一套 flashTarget）。
   */
  const isNew = session === null && newSessionCwd !== null;
  const sessionTitle = isNew ? "新会话" : session?.name || session?.firstMessage || "会话";
  const cwd = isNew ? newSessionCwd : session?.cwd || "";
  const cwdName = useMemo(() => (cwd && cwd !== "unknown" ? basename(cwd) : ""), [cwd]);
  /* 压缩历史（「这次丢了什么」）：随 /api/sessions/[id] 的会话数据一起来。
     加载在 useAgentSession 里完成（loadSession 会把整份 JSON 存进 data），
     压缩结束（compaction_end）时该 hook 也会重新 loadSession，这里自然更新。
     data 的类型归 hook 所有，此处只取本功能需要的只读字段，不改其契约。 */
  const compactionRecords = useMemo<CompactionRecord[]>(() => {
    const records = (data as { compactions?: CompactionRecord[] } | null)?.compactions;
    return Array.isArray(records) ? records : [];
  }, [data]);

  // 新会话草稿键固定：工作区切换（cwd 变化）不重挂载、不重键，草稿跟随会话本身
  const draftKey = session?.id ?? "new";

  /** /session 要把最新统计读出来做 Toast，用 ref 避免闭包拿到过期值 */
  const sessionStatsRef = useRef(sessionStats);
  sessionStatsRef.current = sessionStats;
  /* 会话级写操作（重命名 / 删除 / 压缩 / 克隆 / 导出 / AI 命名）—— 标题内联重命名、
     观测栏的压缩 / 导出 / 克隆，都走这一份。 */
  const sessionActions = useSessionActions({
    sessionId: session?.id ?? "",
    sessionName: isNew ? "新会话" : session?.name || session?.firstMessage || "会话",
    onRenamed,
    onDeleted,
    onAutoRename,
    onCompact: () => handleCompact(),
    compacting: isCompacting,
    onClone: async () => {
      const r = await handleBuiltinSlashCommand("/clone");
      if (!r.handled) return;
      if (r.error) toast(`克隆失败：${r.error}`);
      else if (r.message) toast(r.message);
    },
  });

  /* ---------- 空态新会话：最近工作区选项（供「工作区」选择器） ---------- */
  const workspaceOptions = useMemo<WorkspaceOption[]>(() => {
    const map = new Map<string, { name: string; path: string; latest: string }>();
    for (const s of sessions) {
      const root = (s.isProject && s.repoRoot) || s.cwd;
      if (!root || root === "unknown") continue;
      if (defaultCwd && normPath(root) === normPath(defaultCwd)) continue; // 默认工作区单独展示
      if (/pi-(cwd-\d{8}|workspace)$/.test(normPath(root))) continue; // 默认工作区（固定/旧日期形态）不占「最近」名额
      const prev = map.get(normPath(root));
      if (!prev || (s.modified || "") > prev.latest) {
        map.set(normPath(root), { name: basename(root), path: root, latest: s.modified || "" });
      }
    }
    return [...map.values()]
      .sort((a, b) => b.latest.localeCompare(a.latest))
      .slice(0, 6);
  }, [sessions, defaultCwd]);
  /** 等于默认工作区的 pick 视同未选择（深链接/历史 hash 恢复时保持「默认」语义） */
  const effectivePicked =
    pickedWorkspace && defaultCwd && normPath(pickedWorkspace) === normPath(defaultCwd)
      ? null
      : (pickedWorkspace ?? null);

  /* ---------- git 状态（顶栏分支 chip）---------- */
  const [gitInfo, setGitInfo] = useState<{ isRepo: boolean; branch: string | null; dirty: number } | null>(null);
  useEffect(() => {
    if (!cwd || cwd === "unknown") {
      setGitInfo(null);
      return;
    }
    let alive = true;
    fetch(`/api/git/status?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { isGitRepository?: boolean; files?: unknown[] } | null) => {
        if (!alive) return;
        if (d?.isGitRepository) {
          setGitInfo({ isRepo: true, branch: session?.branch ?? null, dirty: d.files?.length ?? 0 });
        } else {
          setGitInfo(null);
        }
      })
      .catch(() => {
        if (alive) setGitInfo(null);
      });
    return () => {
      alive = false;
    };
  }, [cwd, session?.branch]);

  const currentThinkingLevels = useMemo(() => {
    if (!displayModel) return [];
    // thinkingLevels 表的键是 `provider:modelId`（冒号，见 /api/models 的 loadModels）；
    // 这里此前误用斜杠导致永远查空，思考档位选择器从未显示过。
    return modelThinkingLevels[`${displayModel.provider}:${displayModel.modelId}`] ?? [];
  }, [displayModel, modelThinkingLevels]);

  const handleSendWrapped = useCallback(
    async (raw: string, images?: AttachedImage[]) => {
      if (raw.startsWith("/") && !images?.length) {
        const r = await handleBuiltinSlashCommand(raw);
        if (r.handled) {
          if (r.error || r.message) {
            toast(r.error ? `命令出错：${r.error}` : r.message!);
          }
          return;
        }
      }
      handleSend(raw, images);
    },
    [handleBuiltinSlashCommand, handleSend],
  );

  /* ---------- 会话文件预览：write/edit 工具成功写入的文件 ---------- */
  const toolResults = useMemo(() => {
    const map = new Map<string, ToolResultMessage>();
    for (const m of messages) {
      if (m.role === "toolResult") map.set(m.toolCallId, m);
    }
    return map;
  }, [messages]);
  const writtenFiles = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      for (const f of extractTurnWrittenFiles(m.content, toolResults, cwd || undefined)) {
        if (!seen.has(f.filePath)) {
          seen.add(f.filePath);
          out.push(f.filePath);
        }
      }
    }
    return out.reverse(); // 最新写入在前
  }, [messages, toolResults, cwd]);

  /* 近 N 轮趋势：逐轮花费 / 工具 / 失败。只读推导，不参与写入。 */
  const turnTrends = useMemo(() => computeTurnTrends(messages), [messages]);

  /* 右栏 tab 组的可用项数：窄屏无观测、无写入时整组隐藏 */
  const railTabCount = (railAllowed ? 1 : 0) + (writtenFiles.length > 0 ? 1 : 0);

  /**
   * 实际展示的面板：rightPanel 是用户意图，这里再按可用条件兜底 ——
   * 激活的面板失去条件（文件被清空）时回退观测，观测也不可用才整栏收起。
   * 这样顶栏开关、面板头标签栏的激活态与实际内容始终一致。
   */
  const filesAvailable = writtenFiles.length > 0;
  const shownPanel: RightPanel =
    rightPanel === null
      ? null
      : rightPanel === "files" && filesAvailable
        ? "files"
        : railAllowed
          ? "observatory"
          : null;
  /** 观测栏是否展开（宽度过渡用；只有观测栏常驻挂载） */
  const railOpen = shownPanel === "observatory";
  /** 右栏整体是否可见（顶栏开关的图标与 tooltip 用） */
  const railVisible = shownPanel !== null;

  /* 窄窗互斥：<1700 时副屏与观测栏不能同时打开 —— 保留观测栏、收起副屏（不写副屏偏好）。
     只在「观测栏刚被打开」或「视口刚从宽缩到窄」时触发，而非仅当条件成立：
     否则「窄窗下打开副屏」会先被本 effect 收起，跟方向 1（打开副屏自动收起观测栏）
     打架，形成「刚开就关」。两条方向合起来 = 窄窗下后开的留、观测栏在冲突时优先：
       ① 观测栏已开时打开副屏 → 方向 1 收观测栏，副屏留；
       ② 副屏已开时打开观测栏 → 本 effect 收副屏，观测栏留；
       ③ 宽窗两者并存，窗口缩到 <1700 → 本 effect 收副屏。
     ref 初值取当前值，避免深链接/首次挂载时误判为「刚打开」。 */
  const prevShownPanelRef = useRef<RightPanel>(shownPanel);
  const prevCoexistRef = useRef(sideCoexistAllowed);
  useEffect(() => {
    const observatoryJustShown =
      prevShownPanelRef.current !== "observatory" && shownPanel === "observatory";
    const coexistJustLost = prevCoexistRef.current && !sideCoexistAllowed;
    if (
      sidePaneOpen &&
      shownPanel === "observatory" &&
      !sideCoexistAllowed &&
      (observatoryJustShown || coexistJustLost)
    ) {
      setSidePaneOpen(false);
      onSelectSide?.(null);
    }
    prevShownPanelRef.current = shownPanel;
    prevCoexistRef.current = sideCoexistAllowed;
  }, [sidePaneOpen, shownPanel, sideCoexistAllowed, onSelectSide]);

  /** 顶栏开关：收起整个右栏，或展开到最近一次的面板（不可用则挑一个可用的） */
  const toggleRail = useCallback(() => {
    if (railVisible) {
      setRightPanel(null);
      if (shownPanel === "observatory") localStorage.setItem(OBSERVATORY_KEY, "0");
      return;
    }
    const preferred = lastRailPanelRef.current;
    const next: Exclude<RightPanel, null> =
      preferred === "files" && filesAvailable ? "files" : railAllowed ? "observatory" : "files";
    setRightPanel(next);
    if (next === "observatory") localStorage.setItem(OBSERVATORY_KEY, "1");
  }, [railVisible, shownPanel, railAllowed, filesAvailable]);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const openFilePreview = useCallback(
    (path: string) => {
      // 工具卡的原始输入可能是相对路径/反斜杠路径，统一解析为绝对路径
      const resolved = resolveLocalFilePath(path, cwd || undefined) ?? path;
      setPreviewPath(resolved);
      setRightPanel("files");
    },
    [cwd],
  );
  /* 切换会话时只收起文件预览（它是会话内的临时选中）；观测栏偏好跨会话保留 */
  useEffect(() => {
    setPreviewPath(null);
    setRightPanel((v) => (v === "files" ? null : v));
  }, [session?.id, newSessionCwd]);

  /* ---------- 上下文健康：最近一次压缩 ---------- */
  const contextHistory = useMemo<ContextHistory | null>(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role !== "custom" || message.customType !== "compaction") continue;
      const details = (message.details ?? {}) as { tokensBefore?: unknown };
      return {
        tokensBefore: typeof details.tokensBefore === "number" ? details.tokensBefore : null,
        keptMessages: messages.length - i - 1,
      };
    }
    return null;
  }, [messages]);

  /* ---------- 「记住这条」：约定 ×2（原样）+ 记忆 ×2 + 先入待审 ---------- */
  const rememberInstruction = useCallback(async (text: string, target: RememberCallbackTarget) => {
    // 旧字面量（project / global）归一为新去向：调用点只发五档，这里只是兑底
    const resolved: RememberTarget =
      target === "project" ? "project-agents" : target === "global" ? "global-agents" : target;

    /* 约定两项：原流程逐字不变（AGENTS.md，走 /api/context-files） */
    if (resolved === "project-agents" || resolved === "global-agents") {
      if (resolved === "project-agents" && !cwd) {
        toast("当前会话没有工作目录，无法写入项目约定");
        return;
      }
      const isProject = resolved === "project-agents";
      const edited = await dialogPrompt({
        title: isProject ? "记进项目约定" : "记进全局约定",
        message: isProject
          ? "追加到当前项目的 AGENTS.md，新会话生效。可以先把这句话改成你真正想让 agent 记住的措辞。"
          : "追加到全局 AGENTS.md（~/.pi/agent/AGENTS.md），对所有项目生效。",
        defaultValue: text.trim(),
        placeholder: "例如：改完代码后先跑 npm test 再汇报",
        confirmText: "记住",
      });
      if (!edited) return;
      try {
        const res = await fetch("/api/context-files", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            file: isProject ? "project-agents" : "global-agents",
            text: edited,
            ...(isProject ? { cwd } : {}),
          }),
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string; duplicated?: boolean; path?: string };
        if (!res.ok) throw new Error(data.error || `保存失败（HTTP ${res.status}）`);
        toast(data.duplicated ? "这条已经在约定里了" : "已记入约定，新会话生效");
      } catch (error) {
        toast(error instanceof Error ? error.message : "记住失败");
      }
      return;
    }

    /* 记忆两项：追加到 pi-hermes-memory 落盘的文件（走 /api/memory 的 POST） */
    if (resolved === "project-memory" || resolved === "global-memory") {
      const isProject = resolved === "project-memory";
      if (isProject && !cwd) {
        toast("当前会话没有工作目录，无法写入项目记忆");
        return;
      }
      const projectName = isProject && cwd ? basename(cwd) : "";
      const edited = await dialogPrompt({
        title: isProject ? "存为项目记忆" : "存为全局记忆",
        message: isProject
          ? `追加到当前项目的 MEMORY.md（project/${projectName}），下一轮起生效。可以先把这句话改成你真正想让 agent 记住的措辞。`
          : "追加到全局 MEMORY.md（跨项目的事实与教训），下一轮起生效。",
        defaultValue: text.trim(),
        placeholder: "例如：这台机器上包管理器用 npm 不要用 pnpm",
        confirmText: "记住",
      });
      if (!edited) return;
      try {
        const res = await fetch("/api/memory", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            file: isProject ? `project/${projectName}` : "memory",
            text: edited,
            // 来路：记住菜单（纯加字段，写入端记进来源账本）
            source: { via: "remember", sessionId: session?.id ?? null, cwd: cwd ?? null },
          }),
        });
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (!res.ok || !data.ok) throw new Error(data.error || `保存失败（HTTP ${res.status}）`);
        toast("已存为记忆，下一轮起生效");
      } catch (error) {
        toast(error instanceof Error ? error.message : "记住失败");
      }
      return;
    }

    /* 先入待审：不直接落盘，之后到「记忆」页确认去向 */
    const edited = await dialogPrompt({
      title: "先入待审",
      message: "放进待审队列，稍后到「记忆」页逐条确认写到哪一层（项目/全局 × 约定/记忆）。",
      defaultValue: text.trim(),
      placeholder: "例如：以后提交信息都用中文",
      confirmText: "放入待审",
    });
    if (!edited) return;
    try {
      const res = await fetch("/api/memory/pending", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add",
          text: edited,
          source: { sessionId: session?.id ?? null, cwd },
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || `保存失败（HTTP ${res.status}）`);
      toast("已放入待审（到「记忆」页里确认）");
    } catch (error) {
      toast(error instanceof Error ? error.message : "记住失败");
    }
  }, [cwd, session?.id]);

  /**
   * 「记住这条」回调。`canProject` 挂在函数上：MessageView 用它禁用两项项目去向，
   * 而 ChatWindow 只透传 onRemember 一个 prop（不为一个布尔值去扩它的入参）。
   */
  const rememberHandler = useMemo<RememberHandler>(() => {
    const handler = ((text: string, target: RememberCallbackTarget) => {
      void rememberInstruction(text, target);
    }) as RememberHandler;
    handler.canProject = Boolean(cwd);
    return handler;
  }, [cwd, rememberInstruction]);

  /**
   * 「沉淀为技能」：把助手一条回复里涉及的做法交给模型，用 `skill_draft` 整理成草稿。
   * 工具只起草不落盘 —— 真正的入库由用户在草稿卡上点「保存到技能库」完成。
   */
  const draftSkillInstruction = useCallback((text: string) => {
    // 长回复只截前一段：技能沉淀要的是「可复用的做法」，不是逐字逐句把这条回复抄回去
    const excerpt = text.trim().slice(0, 8000);
    const instruction = [
      "把下面这条回复里涉及的做法沉淀成一个可复用的技能草稿。用 skill_draft 工具起草（只起草，不要写任何文件）。要求：",
      "- 提炼可复用的做法：触发条件 / 步骤 / 坑 / 验证方式；不要复述这一次的具体内容。",
      "- name 用小写字母 / 数字 / 连字符、≤64；description 一句话说清「何时用这个技能」；body 写完整 SKILL.md 正文（markdown，含标题与分节）。",
      "- 草稿生成后等用户在界面上确认；不要自行写 SKILL.md。",
      "",
      "待沉淀的回复内容：",
      '"""',
      excerpt,
      '"""',
    ].join("\n");
    handleSend(instruction);
  }, [handleSend]);

  /* ---------- 计划模式 + 每轮快照 ----------
     计划模式状态存在服务端（内核空闲回收会话后仍然有效）。新会话还没有 id，
     此时开关写入的是「新建会话的默认值」，由 readPlanMode 对未设过的会话回落。 */
  const [planMode, setPlanMode] = useState(false);
  const [checkpointRefreshKey, setCheckpointRefreshKey] = useState(0);
  const planSessionId = session?.id ?? null;
  useEffect(() => {
    let alive = true;
    const query = planSessionId ? `?session=${encodeURIComponent(planSessionId)}` : "";
    fetch(`/api/guardrails${query}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { planMode?: boolean; planModeDefault?: boolean }) => {
        if (!alive) return;
        setPlanMode(planSessionId ? d.planMode === true : d.planModeDefault === true);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [planSessionId]);
  const togglePlanMode = useCallback(async (enabled: boolean) => {
    setPlanMode(enabled);
    try {
      await fetch("/api/guardrails", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          planSessionId
            ? { action: "setPlanMode", sessionId: planSessionId, enabled }
            : { action: "setPlanModeDefault", enabled },
        ),
      });
    } catch {
      toast("计划模式切换失败");
    }
  }, [planSessionId]);
  /* 一轮结束后刷新两件事：本轮快照（回滚条 / 观测栏）与计划模式（present_plan 被批准后会关闭） */
  const wasRunningRef = useRef(false);
  useEffect(() => {
    if (wasRunningRef.current && !agentRunning) {
      setCheckpointRefreshKey((value) => value + 1);
      if (planSessionId) {
        fetch(`/api/guardrails?session=${encodeURIComponent(planSessionId)}`, { cache: "no-store" })
          .then((r) => r.json())
          .then((d: { planMode?: boolean }) => setPlanMode(d.planMode === true))
          .catch(() => undefined);
      }
    }
    wasRunningRef.current = agentRunning;
  }, [agentRunning, planSessionId]);
  /** 本轮证据的唯一数据源：输入框上方一行与观测栏明细共用它 */
  const turn = useTurnCheckpoints(planSessionId, checkpointRefreshKey);
  /** 当前任务清单（最后一条成功的 todo_write 参数；消息流一变即重算，回滚 / 切分支自动正确） */
  const todos = useMemo(() => latestTodoState(messages, toolResults), [messages, toolResults]);

  /* ---------- 项目信任检查（P1）---------- */
  const [trust, setTrust] = useState<{ requiresTrust: boolean; trusted: boolean } | null>(null);
  useEffect(() => {
    if (!cwd) {
      setTrust(null);
      return;
    }
    let alive = true;
    setTrust(null);
    fetch(`/api/project-trust?cwd=${encodeURIComponent(cwd)}`)
      .then((r) => r.json())
      .then((d: { requiresTrust?: boolean; trusted?: boolean }) => {
        if (alive) setTrust({ requiresTrust: !!d.requiresTrust, trusted: d.trusted !== false });
      })
      .catch(() => {
        if (alive) setTrust({ requiresTrust: false, trusted: true });
      });
    return () => {
      alive = false;
    };
  }, [cwd]);
  const trustBlocked = trust?.requiresTrust === true && !trust.trusted;
  const confirmTrust = useCallback(async () => {
    const res = await fetch("/api/project-trust", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd }),
    });
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(d.error || `信任失败（HTTP ${res.status}）`);
    }
    const d = (await res.json().catch(() => ({}))) as { deferred?: number };
    setTrust({ requiresTrust: true, trusted: true });
    /* 运行中的会话不能被打断，会在本轮跑完后自动关闭；说清楚比装作没发生好 */
    if ((d.deferred ?? 0) > 0) {
      toast(`已信任该项目。${d.deferred} 个正在运行的会话会在当前任务结束后自动重启，以加载项目资源`);
    }
  }, [cwd]);

  /* ---------- 品牌空态：无消息时居中展示 logo + 标语 + 输入框，开始对话后贴底 ---------- */
  const isEmpty = !loading && !error && messages.length === 0 && !streamState.isStreaming && !searchOpen;

  /* ---------- 会话模板（常用任务一键起）----------
     模板是服务端数据（~/.pi/agent/elenva-templates.json）：空态时拉一次并渲染
     一条芯片栏；应用只做两件事 —— 选工作区 + 覆盖输入文本，不发消息。 */
  const [templates, setTemplates] = useState<SessionTemplate[]>([]);
  const templatesLoadedRef = useRef(false);

  const loadTemplates = useCallback(async () => {
    try {
      const r = await fetch("/api/templates", { cache: "no-store" });
      if (!r.ok) return;
      const data = (await r.json()) as { templates?: SessionTemplate[] };
      setTemplates(Array.isArray(data.templates) ? data.templates : []);
    } catch {
      /* 失败静默：当作没有模板，不打扰 */
    }
  }, []);

  useEffect(() => {
    if (!isNew || !isEmpty || templatesLoadedRef.current) return;
    templatesLoadedRef.current = true;
    void loadTemplates();
  }, [isNew, isEmpty, loadTemplates]);

  const applyTemplate = useCallback(async (tpl: SessionTemplate) => {
    if ((chatInputRef.current?.getText() ?? "").trim()) {
      const ok = await dialogConfirm({
        title: "应用模板",
        message: `将替换当前输入内容？`,
      });
      if (!ok) return;
    }
    onPickWorkspace?.(tpl.cwd);
    chatInputRef.current?.setText(tpl.prompt);
    toast(`已应用模板「${tpl.name}」`);
  }, [onPickWorkspace]);

  const saveTemplate = useCallback(async () => {
    const prompt = chatInputRef.current?.getText() ?? "";
    if (!prompt.trim()) {
      toast("先在输入框写点内容，再存为模板");
      return;
    }
    const firstLine = prompt.trim().split("\n")[0].trim();
    const name = await dialogPrompt({
      title: "存为模板",
      message: "模板会记住当前工作区与输入内容，下次在新会话里一键带出。",
      defaultValue: firstLine.slice(0, 20),
      placeholder: "模板名称",
    });
    if (name === null) return;
    try {
      const r = await fetch("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", name, cwd: effectivePicked ?? null, prompt }),
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) {
        toast(data.error || "保存模板失败");
        return;
      }
      await loadTemplates();
      toast(`已保存模板「${name}」`);
    } catch (error) {
      toast(error instanceof Error ? error.message : "保存模板失败");
    }
  }, [effectivePicked, loadTemplates]);

  const removeTemplate = useCallback(async (tpl: SessionTemplate) => {
    const ok = await dialogConfirm({
      title: "删除模板",
      message: `删除模板「${tpl.name}」？此操作不可撤销。`,
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await fetch("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", id: tpl.id }),
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) {
        toast(data.error || "删除模板失败");
        return;
      }
      await loadTemplates();
    } catch (error) {
      toast(error instanceof Error ? error.message : "删除模板失败");
    }
  }, [loadTemplates]);

  /* 空态模板条：没有任何模板时也显示，保证「存为模板」可发现 */
  const templateBar = (
    <div data-testid="template-bar" className="mb-2 flex flex-wrap items-center gap-1.5 px-1">
      <span className="text-[11px] text-dim">模板</span>
      {templates.map((tpl) => {
        const preview = tpl.prompt.length > 80 ? `${tpl.prompt.slice(0, 80)}…` : tpl.prompt;
        return (
          <span key={tpl.id} className="group/tpl inline-flex items-center">
            <button
              type="button"
              data-testid="template-chip"
              onClick={() => void applyTemplate(tpl)}
              title={`${preview}\n工作区：${tpl.cwd ?? "默认工作区"}`}
              className="chip max-w-48 cursor-pointer t-fast hover:border-accent/40 hover:text-fg"
            >
              <span className="truncate">{tpl.name}</span>
            </button>
            <button
              type="button"
              data-testid="template-chip-delete"
              aria-label={`删除模板 ${tpl.name}`}
              onClick={() => void removeTemplate(tpl)}
              className="ml-1 flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-md text-dim opacity-0 t-fast hover:text-danger group-hover/tpl:opacity-100 focus-visible:opacity-100"
            >
              <X size={10} />
            </button>
          </span>
        );
      })}
      <button
        type="button"
        data-testid="template-save"
        aria-label="存为模板"
        onClick={() => void saveTemplate()}
        title="把当前工作区与输入内容存为模板"
        className="chip cursor-pointer t-fast hover:border-accent/40 hover:text-fg"
      >
        <Plus size={12} />
        <span>存为模板</span>
      </button>
    </div>
  );

  /* 过程态状态条：重试 / 压缩 / shell 执行 / 模型错误 —— 之前全靠内核静默推进 */
  const statusBar = (
    <AgentStatusBar
      retry={retryInfo}
      bashCommand={pendingBash?.command ?? null}
      compacting={isCompacting}
      compactResult={compactResult}
      compactError={compactError}
      modelError={modelError}
      modelScopeWarnings={modelScopeWarnings}
      onAbort={() => {
        if (isCompacting) void handleAbortCompaction();
        else if (bashRunning) void handleAbort();
      }}
    />
  );

  const chatInputEl = (
    <ChatInput
      ref={chatInputRef}
      onSend={handleSendWrapped}
      onSteer={handleSteer}
      onFollowUp={handleFollowUp}
      onRecallQueue={handleRecallQueue}
      queuedMessages={queuedMessages}
      onNotice={(m) => toast(m)}
      onStop={handleAbort}
      running={agentRunning || bashRunning}
      disabled={loading || trustBlocked}
      placeholder={undefined}
      slashCommands={slashCommands}
      cwd={cwd || null}
      draftKey={draftKey}
      polishSessionId={planSessionId}
      toolPreset={toolPreset}
      onToolPresetChange={(p) => void handleToolPresetChange(p)}
      availableTools={systemTools}
      onToolSelectionChange={handleToolSelectionChange}
      onRequestTools={() => void loadSystemInfo()}
      planMode={planMode}
      onTogglePlanMode={(enabled) => void togglePlanMode(enabled)}
      contextUsage={contextUsage}
      contextHistory={contextHistory}
      onCompactContext={() => void sessionActions.compact()}
      onAbortCompaction={() => void handleAbortCompaction()}
      compactingContext={isCompacting}
      thinkingLevel={thinkingLevel}
      thinkingLevels={currentThinkingLevels}
      onThinkingLevelChange={(lv) => void handleThinkingLevelChange(lv)}
      extensionAbove={
        <ExtensionStrip widgets={extensionWidgets} statuses={extensionStatuses} placement="aboveEditor" />
      }
      extensionBelow={<ExtensionStrip widgets={extensionWidgets} statuses={[]} placement="belowEditor" />}
      footerLeft={
        isNew && onPickWorkspace ? (
          <div className="mt-1 flex items-center px-1">
            <WorkspacePicker
              picked={effectivePicked}
              defaultCwd={defaultCwd ?? null}
              recent={workspaceOptions}
              onPick={onPickWorkspace}
              onOpenFolder={() => onCreateProject?.()}
            />
          </div>
        ) : undefined
      }
      modelPicker={
        <ModelPicker
          modelList={modelList}
          displayModel={displayModel}
          modelNames={modelNames}
          switching={modelSwitching}
          thinkingLevel={thinkingLevel}
          thinkingLevels={currentThinkingLevels}
          onModelChange={handleModelChange}
          onThinkingLevelChange={handleThinkingLevelChange}
          onReloadModels={() => loadModels()}
        />
      }
    />
  );

  /* 右栏两个面板共用的头部标签栏（观测 / 文件 + 收起）：一处定义，各面板通过 header 插槽渲染 */
  const railHeader = (
    <RailTabs
      active={shownPanel}
      railAllowed={railAllowed}
      fileCount={writtenFiles.length}
      onSelect={selectPanel}
      onClose={closeRail}
    />
  );

  return (
    <div className="flex min-h-0 flex-1">
      <SessionSidebar
        sessions={sessions}
        runningIds={runningIds}
        unreadIds={unreadIds}
        selectedId={session?.id ?? null}
        onSelect={onOpenSession}
            onNewChat={onNewChat}
            onCreateInProject={onCreateInProject}
            onCreateProject={onCreateProject}
            defaultCwd={defaultCwd}
            onDelete={onDeleteSession}
        onSessionsChanged={onRefreshSessions}
        collapsed={sidebarCollapsed}
      />
      {/* 网格底纹铺满聊天列（与新建会话空态同一纹理）；顶栏与输入卡片是实底，
          所以纹理只出现在消息区的留白处 —— 那正是此前看起来「空」的地方。 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 会话顶栏 */}
        <div className="relative flex h-13 shrink-0 items-center gap-2.5 border-b border-line bg-panel/90 px-5">
          {onOpenNav && (
            <button
              onClick={onOpenNav}
              aria-label="打开导航"
              className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-dim t-fast hover:bg-hover hover:text-fg"
            >
              <Menu size={14} />
            </button>
          )}
          <button
            onClick={toggleSidebar}
            className="flex size-8 cursor-pointer items-center justify-center rounded-lg text-dim t-fast hover:bg-hover hover:text-fg"
            title={sidebarCollapsed ? "展开会话列表" : "收起会话列表"}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
          </button>
          <div className="group/title flex min-w-0 flex-1 flex-col justify-center gap-0.5">
            <div className="flex min-w-0 items-center">
              <SessionTitle
                cwdName={cwdName}
                title={sessionTitle}
                actions={sessionActions}
                editable={!isNew && !!session}
              />
            </div>
            {/* 目标（goal）：标题下方一行「这个会话在干什么」，点一下就地改。
                新会话还没落盘，不显示入口（也没有 id 可挂）。 */}
            {!isNew && session && (
              <SessionGoal key={session.id} sessionId={session.id} />
            )}
          </div>
          <div className="ml-auto flex items-center gap-2.5">
            {/* 会话内搜索 */}
            {searchOpen ? (
              <div className="flex h-8 items-center gap-1.5 rounded-lg border border-accent/50 bg-panel-2 px-2">
                <Search size={12} className="shrink-0 text-dim" />
                <input
                  ref={searchInputRef}
                  value={searchQ}
                  onChange={(e) => setSearchQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      closeSearch();
                    }
                  }}
                  placeholder="搜索本会话消息…"
                  className="w-44 bg-transparent text-[12px] text-fg outline-none placeholder:text-dim"
                />
                <button
                  onClick={closeSearch}
                  title="关闭搜索（Esc）"
                  className="cursor-pointer text-dim t-fast hover:text-fg"
                >
                  <X size={12} />
                </button>
              </div>
            ) : (
              <button
                onClick={() => {
                  setSearchOpen(true);
                  requestAnimationFrame(() => searchInputRef.current?.focus());
                }}
                className="flex size-8 cursor-pointer items-center justify-center rounded-lg text-dim t-fast hover:bg-hover hover:text-fg"
                title="会话内搜索（Ctrl+F）"
              >
                <Search size={14} />
              </button>
            )}
            {/* git 分支 chip */}
            {gitInfo?.isRepo && cwd && (
              <button
                onClick={() => onOpenGit?.(cwd)}
                title="查看 Git 变更（当前项目）"
                className="chip hidden cursor-pointer items-center gap-1.5 px-2 t-fast hover:border-accent/40 hover:text-fg lg:flex"
              >
                <GitBranch size={12} className="shrink-0 text-dim" />
                <span className="max-w-28 truncate">{gitInfo.branch || "git"}</span>
                {gitInfo.dirty > 0 && (
                  <span className="rounded-sm bg-danger/15 px-1 text-[10px] font-medium tabular-nums text-danger">
                    {gitInfo.dirty}
                  </span>
                )}
              </button>
            )}
            {/* 状态胶囊（运行中/空闲）已移除（2026-09-21）：运行态在输入框（停止按钮）、
                输入框上方状态条、页脚、会话列表圆点四处都有信号；常驻的空闲胶囊只是噪音。 */}
            {/* 并排副屏开关（<1440 不提供；打开后自动收起右栏） */}
            {sideAllowed && (
              <button
                data-testid="side-pane-toggle"
                onClick={toggleSidePane}
                aria-pressed={sidePaneOpen}
                title="并排盯另一个会话"
                aria-label="并排盯另一个会话"
                className={`flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg t-fast hover:bg-hover hover:text-fg ${sidePaneOpen ? "text-accent" : "text-dim"}`}
              >
                <Columns2 size={14} />
              </button>
            )}
            {/* 右栏总开关（镜像左侧会话列表的收起/展开）：点击收起或展开整个右栏。
                面板切换（观测/文件）已移到右栏面板头部的标签栏（RailTabs）。
                出现条件：可用项为 0（窄屏无观测、无写入）时不显示。 */}
            {railTabCount > 0 && (
              <button
                data-testid="rail-toggle"
                onClick={toggleRail}
                aria-pressed={railVisible}
                title={railVisible ? "收起右栏" : "展开右栏（本会话实时数据）"}
                aria-label={railVisible ? "收起右栏" : "展开右栏"}
                className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-dim t-fast hover:bg-hover hover:text-fg"
              >
                {railVisible ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
              </button>
            )}
            <ThemeToggle />
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
        {isEmpty ? (
          <div className="chat-hero flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-10">
            <LogoMark size={64} />
            <div className="mt-6 text-[14px] font-semibold tracking-[0.06em] text-fg">在确定性中寻找出口</div>
            <div className="mt-3 h-[3px] w-10 rounded-full bg-accent" />
            <div className="relative mt-9 w-full max-w-[var(--chat-col)]">
              {isNew && templateBar}
              {statusBar}
              {chatInputEl}
            </div>
          </div>
        ) : (
          <ChatWindow
            messages={messages}
            streamState={streamState}
            agentPhase={agentPhase}
            agentRunning={agentRunning}
            loading={loading}
            error={error}
            sessionTitle={sessionTitle}
            scrollContainerRef={scrollContainerRef}
            onScrollToBottom={() => scrollToBottom("auto")}
            entryIds={entryIds}
            forkingEntryId={forkingEntryId}
            onFork={handleFork}
            searchQuery={searchOpen ? searchQ : ""}
            onExitSearch={closeSearch}
            onOpenFile={openFilePreview}
            sessionId={session?.id ?? null}
            lastUserMsgRef={lastUserMsgRef}
            hasEarlierMessages={hasEarlierMessages}
            loadingEarlier={loadingEarlier}
            onLoadEarlier={handleLoadEarlier}
            onRemember={rememberHandler}
            onDraftSkill={draftSkillInstruction}
          />
        )}
        {/* 输入区两条（任务条 / 本轮条）是观测栏的**替身**：观测栏可见时其内容已在栏里，
            再摆一份就是同源双显；关栏 / 窄屏 / 切到文件面板时才出场 —— 那是它们作为
            唯一入口（窄屏、关栏）与刚跑完一轮的即时结论 / 纠错入口的意义所在。
            状态条（statusBar）不在此门控内，始终显示。 */}
        {!isEmpty && !railOpen && <TodoPanel todos={todos} />}
        {!isEmpty && !railOpen && (
          <TurnFooter
            turn={turn}
            running={agentRunning || bashRunning}
            cwd={cwd}
            canOpenRail={railAllowed}
            onOpenRail={showObservatory}
          />
        )}
        {!isEmpty && statusBar}
        {!isEmpty && chatInputEl}
          </div>
          {/* 并排副屏：只读，占在对话列与右栏之间的独立一列。窄窗（<1440）不渲染，
              但 URL 里的 side 保留（降级不报错）。 */}
          {sidePaneOpen && sideAllowed && (
            <SideSessionPane
              sessionId={sideSessionId ?? null}
              sessions={sessions}
              runningIds={runningIds}
              onSwitch={(id) => onSelectSide?.(id)}
              onClose={closeSidePane}
            />
          )}
          {/* 右侧只有一个槽位：文件预览 / 观测栏二选一。rightPanel 是用户意图，
              shownPanel 已按可用条件兜底（不可用则回退观测 / 收起）。 */}
          {shownPanel === "files" && writtenFiles.length > 0 ? (
            <FilePreviewPanel
              files={writtenFiles}
              selected={previewPath}
              onSelect={setPreviewPath}
              onClose={closeRail}
              header={railHeader}
              width={railPanelWidth}
              grow={growRailPanel}
              reset={resetRailPanel}
              /* 观测栏的「本会话文件」区撤掉后，这个跳转的家就在文件列表这儿 */
              onOpenCode={onOpenCode ? (f) => onOpenCode(f, cwd || "") : undefined}
            />
          ) : railAllowed ? (
            /* 收起由 SessionObservatory 自己的 aside 完成（宽度过渡 + 内容淡出），
               不再在外面包一层容器 —— 那层 overflow:hidden 会裁掉 resizer 的负边距，
               实测直接把拖拽打死（420 → 420）。 */
            <SessionObservatory
              open={railOpen}
              header={railHeader}
              width={railPanelWidth}
              grow={growRailPanel}
              reset={resetRailPanel}
              messages={messages}
              trends={turnTrends}
              results={toolResults}
              cwd={cwd || ""}
              gitInfo={gitInfo}
              sessionStats={sessionStats}
              contextUsage={contextUsage}
              compactions={compactionRecords}
              displayModel={displayModel}
              thinkingLevel={thinkingLevel}
              onOpenFile={openFilePreview}
              onOpenGit={onOpenGit}
              onClose={closeRail}
              compacting={isCompacting}
              onCompact={() => void sessionActions.compact()}
              onAbortCompaction={() => void handleAbortCompaction()}
              onExportHtml={sessionActions.exportHtml}
              onClone={() => void sessionActions.clone()}
              onOpenSubagents={onOpenSubagents}
              onOpenSettings={onOpenSettings}
              turn={turn}
            />
          ) : null}
        </div>
        {trustBlocked && (
          <ProjectTrustDialog cwd={cwd} onConfirm={confirmTrust} onCancel={onExit} />
        )}
        {extensionDialog && (
          <ExtensionDialog request={extensionDialog} onRespond={respondToExtensionUi} />
        )}
      </div>
    </div>
  );
}
