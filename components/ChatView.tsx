"use client";

import { PanelLeftClose, PanelLeftOpen, PanelRight, FileCode2, GitBranch, Menu, Search, X } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentStatusBar } from "@/components/AgentStatusBar";
import { ChatInput, type ContextHistory } from "@/components/ChatInput";
import { ChatWindow } from "@/components/ChatWindow";
import { ExtensionDialog } from "@/components/ExtensionDialog";
import { FilePreviewPanel } from "@/components/FilePreviewPanel";
import { LogoMark } from "@/components/Logo";
import { SessionObservatory } from "@/components/SessionObservatory";
import { TurnFooter } from "@/components/TurnFooter";
import { ExtensionStrip } from "@/components/ExtensionStrip";
import { ModelPicker } from "@/components/ModelPicker";
import { ProjectTrustDialog } from "@/components/ProjectTrustDialog";
import { SessionTitle } from "@/components/SessionTitle";
import { SessionSidebar } from "@/components/SessionSidebar";
import { TreePanel } from "@/components/TreePanel";
import { WorkspacePicker, type WorkspaceOption } from "@/components/WorkspacePicker";
import { useAgentSession, type AttachedImage, type ChatInputHandle } from "@/hooks/useAgentSession";
import { useSessionActions } from "@/hooks/useSessionActions";
import { extractTurnWrittenFiles } from "@/lib/turn-written-files";
import { useTurnCheckpoints } from "@/hooks/useTurnCheckpoints";
import { resolveLocalFilePath } from "@/lib/file-links";
import type { SessionInfo, ToolResultMessage } from "@/lib/types";
import { cn } from "@/components/lib/utils";
import { basename, formatCost, formatTokens } from "@/lib/format";
import { toast, dialogPrompt } from "@/components/ui/dialog";

const SIDEBAR_COLLAPSED_KEY = "elenva-chat-sidebar-collapsed";
const OBSERVATORY_KEY = "elenva-chat-observatory";
/** 观测栏需要的最小窗宽（与 Tailwind xl 断点对齐） */
const OBSERVATORY_MIN_WIDTH = 1280;

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
  const [railOpen, setRailOpen] = useState(false);
  const [railAllowed, setRailAllowed] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${OBSERVATORY_MIN_WIDTH}px)`);
    const apply = () => setRailAllowed(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  useEffect(() => {
    const saved = localStorage.getItem(OBSERVATORY_KEY);
    if (saved !== null) setRailOpen(saved === "1");
    else if (window.innerWidth >= 1440) setRailOpen(true);
  }, []);
  const toggleRail = useCallback(() => {
    setRailOpen((v) => {
      localStorage.setItem(OBSERVATORY_KEY, v ? "0" : "1");
      return !v;
    });
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
      const el = scrollContainerRef.current?.querySelector<HTMLElement>(`[data-idx="${index}"]`);
      if (!el) return;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
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

  const [treeOpen, setTreeOpen] = useState(false);
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
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const openFilePreview = useCallback(
    (path: string) => {
      // 工具卡的原始输入可能是相对路径/反斜杠路径，统一解析为绝对路径
      const resolved = resolveLocalFilePath(path, cwd || undefined) ?? path;
      setPreviewPath(resolved);
      setPreviewOpen(true);
    },
    [cwd],
  );
  /* 切换会话时收起面板 */
  useEffect(() => {
    setPreviewOpen(false);
    setPreviewPath(null);
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
  /* 右侧只有一个槽位，打开观测栏要先腾位（与工具栏里的逻辑一致） */
  const openRail = useCallback(() => {
    setTreeOpen(false);
    setPreviewOpen(false);
    setRailOpen(true);
  }, []);

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
            {/* 会话文件预览入口 */}
            {writtenFiles.length > 0 && (
              <button
                onClick={() => {
                  setTreeOpen(false);
                  setPreviewOpen((v) => !v);
                }}
                className={cn(
                  "flex h-8 shrink-0 cursor-pointer items-center gap-1 rounded-lg border px-2 text-[12px] t-fast",
                  previewOpen
                    ? "border-accent/40 bg-accent-soft text-accent"
                    : "border-line bg-panel-2 text-muted hover:text-fg",
                )}
                title="本会话 Agent 写入的文件（右侧预览）"
              >
                <FileCode2 size={12} />
                <span className="tabular-nums">{writtenFiles.length}</span>
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
            {hasTree && (
              <button
                data-testid="tree-button"
                onClick={() => {
                  // 与预览面板互斥：右侧只有一个槽位，同时开两个会把聊天挤没
                  setTreeOpen((v) => {
                    if (!v) setPreviewOpen(false);
                    return !v;
                  });
                }}
                className={cn(
                  "flex size-8 cursor-pointer items-center justify-center rounded-lg t-fast",
                  treeOpen ? "bg-active text-accent" : "text-dim hover:bg-hover hover:text-fg",
                )}
                title="会话树：浏览分支、跳转到任意历史点继续"
              >
                <GitBranch size={14} />
              </button>
            )}
            {/* 状态胶囊（运行中/空闲）已移除（2026-09-21）：运行态在输入框（停止按钮）、
                输入框上方状态条、页脚、会话列表圆点四处都有信号；常驻的空闲胶囊只是噪音。 */}
            {/* 观测栏开关：宽屏才有意义，窄屏隐藏以免挤掉聊天区 */}
            <button
              onClick={toggleRail}
              title={railOpen ? "收起观测栏" : "展开观测栏（本会话实时数据）"}
              aria-label={railOpen ? "收起观测栏" : "展开观测栏"}
              aria-pressed={railOpen}
              data-testid="observatory-toggle"
              className={cn(
                "hidden size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg t-fast xl:flex",
                railOpen ? "bg-active text-accent" : "text-dim hover:bg-hover hover:text-fg",
              )}
            >
              <PanelRight size={14} />
            </button>
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
        {!isEmpty && (
          <TurnFooter
            turn={turn}
            running={agentRunning || bashRunning}
            railOpen={railOpen}
            canOpenRail={railAllowed}
            onOpenRail={openRail}
          />
        )}
        {!isEmpty && statusBar}
        {!isEmpty && chatInputEl}
          </div>
          {/* 右侧只有一个槽位：会话树 / 文件预览 / 观测栏三选一（优先级即此顺序）。
              它们都是「右侧信息面」，同时开两个会把聊天区挤到不可用。 */}
          {treeOpen && sessionTree ? (
            <TreePanel
              docked
              tree={sessionTree}
              activeLeafId={activeLeafId}
              onNavigate={(id) => void handleNavigate(id)}
              onClose={() => setTreeOpen(false)}
            />
          ) : previewOpen && writtenFiles.length > 0 ? (
            <FilePreviewPanel
              files={writtenFiles}
              selected={previewPath}
              onSelect={setPreviewPath}
              onClose={() => setPreviewOpen(false)}
              /* 观测栏的「本会话文件」区撤掉后，这个跳转的家就在文件列表这儿 */
              onOpenCode={onOpenCode ? (f) => onOpenCode(f, cwd || "") : undefined}
            />
          ) : railAllowed ? (
            /* 收起由 SessionObservatory 自己的 aside 完成（宽度过渡 + 内容淡出），
               不再在外面包一层容器 —— 那层 overflow:hidden 会裁掉 resizer 的负边距，
               实测直接把拖拽打死（420 → 420）。 */
            <SessionObservatory
              open={railOpen}
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
              onClose={toggleRail}
              compacting={isCompacting}
              onCompact={() => void sessionActions.compact()}
              onAbortCompaction={() => void handleAbortCompaction()}
              onExportHtml={sessionActions.exportHtml}
              onClone={() => void sessionActions.clone()}
              onOpenSubagents={onOpenSubagents}
              onJumpToMessage={handleJumpToMessage}
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
