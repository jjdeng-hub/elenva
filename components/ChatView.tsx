"use client";

import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, GitBranch, Menu, Search, X } from "lucide-react";
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
import { SessionSidebar } from "@/components/SessionSidebar";
import { TreePanel, countTreeNodes } from "@/components/TreePanel";
import { WorkspacePicker, type WorkspaceOption } from "@/components/WorkspacePicker";
import { useAgentSession, type AttachedImage, type ChatInputHandle } from "@/hooks/useAgentSession";
import { useSessionActions } from "@/hooks/useSessionActions";
import { usePersistedWidth } from "@/components/ui/Resizer";
import { extractTurnWrittenFiles } from "@/lib/turn-written-files";
import { useTurnCheckpoints } from "@/hooks/useTurnCheckpoints";
import { latestTodoState } from "@/lib/todo-view";
import { resolveLocalFilePath } from "@/lib/file-links";
import type { SessionInfo, ToolResultMessage } from "@/lib/types";
import { basename, formatCost, formatTokens } from "@/lib/format";
import { centerElementInContainer } from "@/lib/scroll";
import { toast, dialogPrompt } from "@/components/ui/dialog";

const SIDEBAR_COLLAPSED_KEY = "elenva-chat-sidebar-collapsed";
const OBSERVATORY_KEY = "elenva-chat-observatory";
/** 观测栏需要的最小窗宽（与 Tailwind xl 断点对齐） */
const OBSERVATORY_MIN_WIDTH = 1280;

/** 右侧槽位同时只承载一个面板：会话树 / 文件预览 / 观测栏 */
type RightPanel = "tree" | "files" | "observatory" | null;

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
}) {
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const {
    loading, error, messages, streamState, agentRunning, agentPhase,
    contextUsage, displayModel, modelNames, modelList, modelSwitching,
    thinkingLevel, modelThinkingLevels,
    entryIds, forkingEntryId, isCompacting, slashCommands,
    queuedMessages, data, activeLeafId,
    extensionWidgets, extensionStatuses,
    extensionDialog, respondToExtensionUi,
    toolPreset, steeringMode, followUpMode,
    handleSend, handleAbort, scrollToBottom, scrollContainerRef,
    handleModelChange, handleThinkingLevelChange, handleToolPresetChange,
    loadModels,
    handleFork, handleCompact, handleBuiltinSlashCommand,
    handleSteer, handleFollowUp, handleRecallQueue, handleNavigate,
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
    onAgentEnd,
    onSessionCreated,
    onSessionForked,
  });



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
     三个布尔 + 渲染优先级会拼出一个看不见的旧状态 —— 树/文件开着时点观测栏没反应，
     关掉树之后观测栏又按那个旧状态冒出来。改成单一状态后，谁显示就是谁。 */
  const [rightPanel, setRightPanel] = useState<RightPanel>(null);
  useEffect(() => {
    const saved = localStorage.getItem(OBSERVATORY_KEY);
    if (saved !== null) setRightPanel(saved === "1" ? "observatory" : null);
    else if (window.innerWidth >= 1440) setRightPanel("observatory");
  }, []);
  /** 最近一次打开的面板：顶栏开关收起后再展开时回到这一页 */
  const lastRailPanelRef = useRef<Exclude<RightPanel, null>>("observatory");

  /* 三个右侧面板共用同一宽度：由 ChatView 持有单一持久化状态，再把 width/grow/reset
     传给具体面板。此前三个面板各自 usePersistedWidth（观测 420 / 树 400 / 文件 340），
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
    // 只有观测栏有持久化偏好；切到树/文件不覆写它
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
   * 跳转到聊天区某条消息（观测栏的失败清单用）。
   * 实现放在 ChatView 而不是 ChatWindow：滚动容器归 hook 所有（scrollContainerRef），
   * ChatView 同时持有它与观测栏，是最短的那条连线。
   */
  const handleJumpToMessage = useCallback(
    (index: number) => {
      const sc = scrollContainerRef.current;
      const el = sc?.querySelector<HTMLElement>(`[data-idx="${index}"]`);
      if (!sc || !el) return;
      centerElementInContainer(sc, el);
      el.classList.add("ring-1", "ring-accent", "rounded-lg");
      setTimeout(() => el.classList.remove("ring-1", "ring-accent", "rounded-lg"), 1600);
    },
    [scrollContainerRef],
  );

  const isNew = session === null && newSessionCwd !== null;
  const sessionTitle = isNew ? "新会话" : session?.name || session?.firstMessage || "会话";
  const cwd = isNew ? newSessionCwd : session?.cwd || "";
  const cwdName = useMemo(() => (cwd && cwd !== "unknown" ? basename(cwd) : ""), [cwd]);
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

  const sessionTree = data?.tree ?? null;
  const hasTree = !isNew && !!sessionTree && sessionTree.length > 0;

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

  /* 右栏 tab 组的可用项数：窄屏无观测、无写入、无分支时整组隐藏 */
  const railTabCount = (railAllowed ? 1 : 0) + (writtenFiles.length > 0 ? 1 : 0) + (hasTree ? 1 : 0);

  /**
   * 实际展示的面板：rightPanel 是用户意图，这里再按可用条件兜底 ——
   * 激活的面板失去条件（文件被清空 / 会话树没了）时回退观测，观测也不可用才整栏收起。
   * 这样顶栏开关、面板头标签栏的激活态与实际内容始终一致。
   */
  const filesAvailable = writtenFiles.length > 0;
  const shownPanel: RightPanel =
    rightPanel === null
      ? null
      : rightPanel === "tree" && hasTree
        ? "tree"
        : rightPanel === "files" && filesAvailable
          ? "files"
          : railAllowed
            ? "observatory"
            : null;
  /** 观测栏是否展开（宽度过渡用；只有观测栏常驻挂载） */
  const railOpen = shownPanel === "observatory";
  /** 右栏整体是否可见（顶栏开关的图标与 tooltip 用） */
  const railVisible = shownPanel !== null;

  /** 顶栏开关：收起整个右栏，或展开到最近一次的面板（不可用则挑一个可用的） */
  const toggleRail = useCallback(() => {
    if (railVisible) {
      setRightPanel(null);
      if (shownPanel === "observatory") localStorage.setItem(OBSERVATORY_KEY, "0");
      return;
    }
    const available = (p: Exclude<RightPanel, null>) =>
      p === "observatory" ? railAllowed : p === "files" ? filesAvailable : hasTree;
    const preferred = lastRailPanelRef.current;
    const next = available(preferred)
      ? preferred
      : available("observatory")
        ? "observatory"
        : available("files")
          ? "files"
          : "tree";
    setRightPanel(next);
    if (next === "observatory") localStorage.setItem(OBSERVATORY_KEY, "1");
  }, [railVisible, shownPanel, railAllowed, filesAvailable, hasTree]);
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

  /* ---------- 「记住这条」：把纠正沉淀成约定 ---------- */
  const rememberInstruction = useCallback(async (text: string, scope: "project" | "global") => {
    if (scope === "project" && !cwd) {
      toast("当前会话没有工作目录，无法写入项目约定");
      return;
    }
    const edited = await dialogPrompt({
      title: scope === "project" ? "记进项目约定" : "记进全局约定",
      message: scope === "project"
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
          file: scope === "project" ? "project-agents" : "global-agents",
          text: edited,
          ...(scope === "project" ? { cwd } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; duplicated?: boolean; path?: string };
      if (!res.ok) throw new Error(data.error || `保存失败（HTTP ${res.status}）`);
      toast(data.duplicated ? "这条已经在约定里了" : "已记入约定，新会话生效");
    } catch (error) {
      toast(error instanceof Error ? error.message : "记住失败");
    }
  }, [cwd]);

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

  /* 右栏三个面板共用的头部标签栏（观测 / 文件 / 树 + 收起）：一处定义，各面板通过 header 插槽渲染 */
  const railHeader = (
    <RailTabs
      active={shownPanel}
      railAllowed={railAllowed}
      fileCount={writtenFiles.length}
      treeNodes={sessionTree ? countTreeNodes(sessionTree) : undefined}
      onSelect={selectPanel}
      onClose={closeRail}
    />
  );

  return (
    <div className="flex min-h-0 flex-1">
      <SessionSidebar
        sessions={sessions}
        runningIds={runningIds}
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
          <div className="group/title flex min-w-0 flex-1 items-center">
            <SessionTitle
              cwdName={cwdName}
              title={sessionTitle}
              actions={sessionActions}
              editable={!isNew && !!session}
            />
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
            {/* 右栏总开关（镜像左侧会话列表的收起/展开）：点击收起或展开整个右栏。
                面板切换（观测/文件/树）已移到右栏面板头部的标签栏（RailTabs）。
                出现条件：可用项为 0（窄屏无观测、无写入、无分支）时不显示。 */}
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
            onRemember={(text, scope) => void rememberInstruction(text, scope)}
          />
        )}
        {!isEmpty && <TodoPanel todos={todos} />}
        {!isEmpty && (
          <TurnFooter
            turn={turn}
            running={agentRunning || bashRunning}
            railOpen={railOpen}
            canOpenRail={railAllowed}
            onOpenRail={showObservatory}
          />
        )}
        {!isEmpty && statusBar}
        {!isEmpty && chatInputEl}
          </div>
          {/* 右侧只有一个槽位：会话树 / 文件预览 / 观测栏三选一。rightPanel 是用户意图，
              shownPanel 已按可用条件兜底（不可用则回退观测 / 收起）。 */}
          {shownPanel === "tree" && sessionTree ? (
            <TreePanel
              docked
              tree={sessionTree}
              activeLeafId={activeLeafId}
              onNavigate={(id) => void handleNavigate(id)}
              onClose={closeRail}
              header={railHeader}
              width={railPanelWidth}
              grow={growRailPanel}
              reset={resetRailPanel}
            />
          ) : shownPanel === "files" && writtenFiles.length > 0 ? (
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
              results={toolResults}
              cwd={cwd || ""}
              gitInfo={gitInfo}
              sessionStats={sessionStats}
              contextUsage={contextUsage}
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
