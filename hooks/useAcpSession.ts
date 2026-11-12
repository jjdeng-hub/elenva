"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addToolCall,
  addToolResult,
  appendAssistantText,
  appendThinkingText,
  appendUserText,
  hermesDbToMessages,
  sealTurn,
  type AcpChatState,
  type HermesDbRecord,
} from "@/lib/acp-chat";
import { INITIAL_STREAMING_STATE } from "@/lib/streaming-message";
import type { AgentMessage, SessionInfo } from "@/lib/types";
import type { AgentPhase } from "@/lib/agent-phase";
import type { SessionStatsInfo } from "@/lib/pi-types";
import type { HermesSessionStats } from "@/lib/agents/resources";
import type {
  TurnCheckpoint,
  TurnCheckpointsState,
  TurnCommand,
  TurnRound,
} from "@/hooks/useTurnCheckpoints";
import type { SessionRuntimeSurface } from "@/lib/session-runtime";

/**
 * Hermes（ACP）运行时适配器（P2 · 单一真源）。
 *
 * 对外暴露与 hooks/useAgentSession 完全一致的表面（SessionRuntimeSurface），
 * ChatView 不需要知道背后是 Pi 还是 Hermes；内部仍是现有的
 * SSE（/api/agents/chat）+ /prompt + /pending + state.db 观测。
 *
 * 原则（不许编数据）：
 * - contextUsage：ACP 的 usage_update 拿不到上下文占用 → 恒 null；
 * - sessionStats：来自 state.db（input/output tokens、tool_call_count、started_at）；
 * - turn：来自 turn_end 事件（步数 / 耗时 / token）；
 * - trends：不在这里算 —— ChatView 已有 computeTurnTrends(messages)。
 */

type PermissionOption = { optionId: string; name?: string; kind?: string };
type ToolDiff = { path?: string; oldText: string; newText: string };
type PermissionRequest = {
  requestId: number;
  title: string;
  detail?: string;
  diff?: ToolDiff;
  locations?: string[];
  options: PermissionOption[];
};
type ModelItem = { modelId: string; name?: string; description?: string };
type ModelState = { currentModelId?: string; availableModels?: ModelItem[] };

export interface UseAcpSessionOptions {
  /** 应用包 agent id（ACP 宿主用它路由） */
  agentId: string;
  /** Hermes profile 名（读 state.db 用） */
  profile: string;
  /** 要恢复的会话（统一索引行；runtime=hermes） */
  session: SessionInfo | null;
  onAgentEnd?: () => void;
  onSystemToolsChange?: (tools: ToolEntryLike[] | null) => void;
  chatInputFocus?: () => void;
}

/** 松散的工具条目形状（只清空，不产出） */
type ToolEntryLike = { name: string; [key: string]: unknown };

/* ---------------- ACP 工具内容解析（原 HermesChat 同款） ---------------- */

function parseToolContent(content: unknown): { text?: string; diff?: ToolDiff } {
  if (!Array.isArray(content)) return {};
  const texts: string[] = [];
  let diff: ToolDiff | undefined;
  for (const block of content) {
    const entry = block as {
      type?: string;
      text?: string;
      path?: string;
      oldText?: string;
      newText?: string;
      content?: { type?: string; text?: string };
    };
    if (entry?.type === "diff" || (entry?.oldText !== undefined && entry?.newText !== undefined)) {
      diff = { path: entry.path, oldText: String(entry.oldText ?? ""), newText: String(entry.newText ?? "") };
      continue;
    }
    if (entry?.type === "content" && entry.content?.type === "text" && typeof entry.content.text === "string") {
      texts.push(entry.content.text);
      continue;
    }
    if (typeof entry?.text === "string") texts.push(entry.text);
  }
  return { text: texts.join("\n").trim() || undefined, diff };
}

function readUsage(raw: unknown): { input?: number; output?: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const usage = raw as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = usage[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
    return undefined;
  };
  const input = pick("inputTokens", "input_tokens", "promptTokens", "prompt_tokens");
  const output = pick("outputTokens", "output_tokens", "completionTokens", "completion_tokens");
  if (input === undefined && output === undefined) return null;
  return { input, output };
}

/** 从统一索引行取 state.db 会话 id（lib/session-index 的口径） */
function stateDbSessionId(info: SessionInfo | null): string | null {
  if (!info || !info.id.startsWith("hermes:")) return null;
  const source = info.source ?? info.path ?? "";
  return source.startsWith("state.db:") ? source.slice("state.db:".length) : null;
}

/* ---------------- Pi 专属字段的安全空表面 ---------------- */

type Surface = SessionRuntimeSurface;

function makeEmptySurfaceParts() {
  const noopAsync = async () => {};
  const noop = () => {};
  return {
    data: null,
    activeLeafId: null,
    historyCursor: null,
    hasEarlierMessages: false,
    loadingEarlier: false,
    modelNames: {} as Record<string, string>,
    modelList: [],
    modelError: null,
    modelScopeWarnings: [] as string[],
    modelThinkingLevels: {} as Record<string, string[]>,
    modelThinkingLevelMaps: {},
    newSessionModel: null,
    systemPrompt: null,
    forkingEntryId: null,
    isCompacting: false,
    compactError: null,
    compactResult: null,
    currentModel: null,
    modelSwitching: false,
    isAutoModelSelection: false,
    isNew: false,
    promptAnchorActive: false,
    slashCommands: [] as never[],
    slashCommandsLoading: false,
    queuedMessages: { steering: [], followUp: [] },
    notices: [] as never[],
    extensionDialog: null,
    extensionCustomUi: null,
    extensionStatuses: [] as never[],
    extensionWidgets: [] as never[],
    toolPreset: "default" as const,
    steeringMode: "all" as const,
    followUpMode: "all" as const,
    bashRunning: false,
    pendingBash: null,
    retryInfo: null,
    contextUsage: null,
    // 动作：Hermes 走不到的 Pi 专属能力给无操作
    handleFork: noopAsync,
    handleCompact: noopAsync,
    handleSteer: noopAsync,
    handleFollowUp: noopAsync,
    handlePromptWithStreamingBehavior: noopAsync,
    handleAbortCompaction: noopAsync,
    handleRecallQueue: noopAsync,
    handleBuiltinSlashCommand: async () => ({ handled: false }) as const,
    setNoticePaused: noop,
    handleToolPresetChange: noop,
    handleToolSelectionChange: async () => true,
    handleThinkingLevelChange: noopAsync,
    applySteeringMode: noopAsync,
    applyFollowUpMode: noopAsync,
    loadTools: noopAsync,
    loadSystemInfo: noopAsync,
    loadSlashCommands: async () => [] as never[],
    loadContext: noopAsync,
    loadEarlier: noopAsync,
    setActiveLeafId: noop,
    setData: noop,
    setMessages: noop,
    dispatch: noop,
    setAgentRunning: noop,
    setForkingEntryId: noop,
    scrollToBottom: noop,
    scrollUserMsgToTop: noop,
    scrollToMessage: noop,
    respondToExtensionUi: noopAsync,
    sendExtensionCustomInput: noopAsync,
  };
}

export function useAcpSession(options: UseAcpSessionOptions): Surface {
  const { agentId, profile, session, onAgentEnd, onSystemToolsChange } = options;

  const [chat, setChat] = useState<AcpChatState>({ messages: [], streaming: null });
  const [status, setStatus] = useState<"idle" | "waiting" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [permission, setPermission] = useState<PermissionRequest | null>(null);
  const [sessionDbId, setSessionDbId] = useState<string | null>(stateDbSessionId(session));
  const [title, setTitle] = useState<string | null>(session?.name ?? null);
  const [models, setModels] = useState<ModelState | null>(null);
  const [modelBusy, setModelBusy] = useState(false);
  const [connection, setConnection] = useState<"live" | "lost">("live");
  const [hermesStats, setHermesStats] = useState<HermesSessionStats | null>(null);
  const [turnStat, setTurnStat] = useState<{ steps: number; ms: number; tokens?: string } | null>(null);

  const turnStartedAt = useRef<number | null>(null);
  const toolsCount = useRef(0);
  const handledRequests = useRef(new Set<number>());
  const ignoreErrorsUntil = useRef(0);
  const diffByPath = useRef(new Map<string, ToolDiff>());
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const lastUserMsgRef = useRef<HTMLDivElement | null>(null);
  const sessionIdRef = useRef<string | null>(stateDbSessionId(session));

  const currentModelId = models?.currentModelId ?? "";
  const ctx = useMemo(() => {
    if (currentModelId.includes(":")) {
      const [provider, ...rest] = currentModelId.split(":");
      return { provider, modelId: rest.join(":") || "unknown" };
    }
    return { provider: "opencode-go", modelId: currentModelId || "unknown" };
  }, [currentModelId]);

  /* ---------------- 会话切换：恢复 state.db 历史 ---------------- */

  useEffect(() => {
    const sid = stateDbSessionId(session);
    setSessionDbId(sid);
    sessionIdRef.current = sid;
    setTitle(session?.name ?? null);
    setChat({ messages: [], streaming: null });
    setPermission(null);
    setError(null);
    setTurnStat(null);
    toolsCount.current = 0;
    turnStartedAt.current = null;
    if (!sid) {
      setHermesStats(null);
      return;
    }
    setLoading(true);
    let alive = true;
    fetch(`/api/agents/chat/history?agentId=${encodeURIComponent(agentId)}&sessionId=${encodeURIComponent(sid)}`, {
      cache: "no-store",
    })
      .then((res) => res.json())
      .then((data: { messages?: HermesDbRecord[]; sessionId?: string | null }) => {
        if (!alive) return;
        const records = data.messages ?? [];
        // 没有消息的会话显示空态 —— 不编造
        setChat({ messages: hermesDbToMessages(records, ctx), streaming: null });
      })
      .catch(() => {
        if (alive) setError("历史读取失败（state.db 不可达）");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // ctx 变化不触发重拉：历史只按会话取一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, session]);

  /* ---------------- 观测真源：state.db 的会话统计 ---------------- */

  const reloadStats = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) {
      setHermesStats(null);
      return;
    }
    try {
      const res = await fetch(
        `/api/agents/chat/stats?agentId=${encodeURIComponent(agentId)}&sessionId=${encodeURIComponent(sid)}`,
        { cache: "no-store" },
      );
      if (!res.ok) {
        setHermesStats(null);
        return;
      }
      const data = (await res.json()) as { stats?: HermesSessionStats | null };
      setHermesStats(data.stats ?? null);
    } catch {
      setHermesStats(null);
    }
  }, [agentId]);

  useEffect(() => {
    void reloadStats();
  }, [reloadStats, sessionDbId]);

  /* ---------------- 审批：SSE + 常驻对账（原 HermesChat 同款） ---------------- */

  const syncPending = useCallback(async () => {
    try {
      const res = await fetch(`/api/agents/pending?id=${encodeURIComponent(agentId)}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as {
        pending?: (PermissionRequest & {
          toolCall?: { title?: string; content?: unknown; locations?: { path?: string }[] };
        })[];
      };
      const next = (data.pending ?? []).find((item) => !handledRequests.current.has(Number(item.requestId)));
      if (!next) return;
      const parsed = parseToolContent(next.toolCall?.content);
      if (parsed.diff?.path) diffByPath.current.set(parsed.diff.path, parsed.diff);
      setPermission({
        requestId: Number(next.requestId),
        title: next.toolCall?.title ?? next.title ?? "需要授权",
        detail: parsed.text,
        diff: parsed.diff,
        locations:
          next.toolCall?.locations?.map((item) => item.path).filter((path): path is string => !!path) ?? next.locations,
        options: next.options ?? [],
      });
    } catch {
      /* 宿主没起来时不打扰 */
    }
  }, [agentId]);

  useEffect(() => {
    void syncPending();
    const timer = window.setInterval(() => void syncPending(), 3000);
    return () => window.clearInterval(timer);
  }, [syncPending]);

  /* ---------------- 传输：SSE ---------------- */

  useEffect(() => {
    const source = new EventSource(`/api/agents/chat?agentId=${encodeURIComponent(agentId)}`);
    source.onmessage = (event) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        return;
      }
      const type = String(data.type ?? "");

      if (type === "ready") {
        setStatus("idle");
        void syncPending();
        return;
      }
      if (type === "title") {
        setTitle(String(data.title ?? ""));
        return;
      }
      if (type === "models") {
        setModels((data.models ?? null) as ModelState | null);
        return;
      }
      if (type === "user_message") {
        setChat((prev) => appendUserText(prev, String(data.text ?? "")));
        return;
      }
      if (type === "permission") {
        const raw = data as unknown as PermissionRequest & {
          toolCall?: { title?: string; content?: unknown; locations?: { path?: string }[] };
        };
        const parsed = parseToolContent(raw.toolCall?.content);
        if (parsed.diff?.path) diffByPath.current.set(parsed.diff.path, parsed.diff);
        setPermission({
          requestId: Number(raw.requestId),
          title: raw.toolCall?.title ?? raw.title ?? "需要授权",
          detail: parsed.text,
          diff: parsed.diff,
          locations: raw.toolCall?.locations?.map((item) => item.path).filter((path): path is string => !!path),
          options: Array.isArray(raw.options) ? raw.options : [],
        });
        setStatus("waiting");
        return;
      }
      if (type === "turn_end") {
        setChat((prev) => sealTurn(prev));
        setStatus("idle");
        const usage = readUsage(data.usage);
        setTurnStat({
          steps: toolsCount.current,
          ms: turnStartedAt.current ? Date.now() - turnStartedAt.current : 0,
          tokens:
            usage?.input === undefined && usage?.output === undefined
              ? undefined
              : `↑${usage?.input ?? 0} ↓${usage?.output ?? 0}`,
        });
        void reloadStats();
        onAgentEnd?.();
        window.dispatchEvent(new Event("elenva:agent-turn-end"));
        return;
      }
      if (type === "error") {
        if (Date.now() < ignoreErrorsUntil.current) return;
        setError(String(data.message ?? "未知错误"));
        setStatus("error");
        return;
      }
      if (type === "host_down") {
        setConnection("lost");
        return;
      }
      if (type !== "update") return;

      const update = (data.update ?? {}) as Record<string, unknown>;
      const kind = String(update.sessionUpdate ?? "");
      const content = (update.content ?? {}) as { text?: string };

      if (kind === "user_message_chunk") {
        setChat((prev) => appendUserText(prev, content.text ?? ""));
      } else if (kind === "agent_message_chunk") {
        setChat((prev) => appendAssistantText(prev, content.text ?? "", ctx));
      } else if (kind === "agent_thought_chunk") {
        setChat((prev) => appendThinkingText(prev, content.text ?? "", ctx));
      } else if (kind === "tool_call") {
        const locations = Array.isArray(update.locations)
          ? (update.locations as { path?: string }[]).map((item) => item.path).filter((path): path is string => !!path)
          : undefined;
        const diff = locations?.map((path) => diffByPath.current.get(path)).find(Boolean);
        toolsCount.current += 1;
        setChat((prev) =>
          addToolCall(
            prev,
            {
              id: String(update.toolCallId ?? ""),
              title: String(update.title ?? "工具调用"),
              kind: typeof update.kind === "string" ? update.kind : undefined,
              locations,
              diff,
            },
            ctx,
          ),
        );
      } else if (kind === "tool_call_update") {
        const parsed = parseToolContent(update.content);
        const id = String(update.toolCallId ?? "");
        const failed = ["failed", "error", "cancelled"].includes(String(update.status ?? ""));
        const pathFromTitle = String(update.title ?? "").split(": ").slice(1).join(": ").trim();
        const diff = parsed.diff ?? (pathFromTitle ? diffByPath.current.get(pathFromTitle) : undefined);
        setChat((prev) =>
          addToolResult(prev, {
            id,
            title: String(update.title ?? ""),
            output: parsed.text,
            failed,
            diff,
          }),
        );
      }
    };
    source.onopen = () => {
      setConnection("live");
      void syncPending();
    };
    source.onerror = () => {
      setConnection("lost");
      setStatus((prev) => (prev === "waiting" ? prev : "idle"));
    };
    return () => source.close();
  }, [agentId, ctx, syncPending, reloadStats, onAgentEnd]);

  /* ---------------- 模型清单 ---------------- */

  const loadModels = useCallback(async () => {
    try {
      const res = await fetch(`/api/agents/chat/models?agentId=${encodeURIComponent(agentId)}&start=1`, {
        cache: "no-store",
      });
      const data = (await res.json()) as { models?: ModelState | null };
      if (data.models) setModels(data.models);
    } catch {
      /* 宿主没起来：保持当前值，不编 */
    }
  }, [agentId]);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  /* ---------------- 动作：send / abort / permission / model ---------------- */

  const handleSend = useCallback(
    async (text: string) => {
      const body = text.trim();
      if (!body) return;
      setError(null);
      setTurnStat(null);
      turnStartedAt.current = Date.now();
      toolsCount.current = 0;
      diffByPath.current.clear();
      setChat((prev) => appendUserText(prev, body));
      setStatus("waiting");
      try {
        const res = await fetch("/api/agents/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentId, action: "prompt", text: body }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          setError(data.error ?? `HTTP ${res.status}`);
          setStatus("error");
        }
      } catch (cause) {
        setError(String(cause));
        setStatus("error");
      }
    },
    [agentId],
  );

  const handleAbort = useCallback(async () => {
    await fetch("/api/agents/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, action: "cancel" }),
    }).catch(() => {});
    setStatus("idle");
  }, [agentId]);

  const respondToPermission = useCallback(
    async (optionId: string) => {
      if (!permission) return;
      handledRequests.current.add(permission.requestId);
      const requestId = permission.requestId;
      setPermission(null);
      setStatus("waiting");
      await fetch("/api/agents/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId, action: "permission", requestId, optionId }),
      }).catch(() => {});
    },
    [agentId, permission],
  );

  const handleModelChange = useCallback(
    async (provider: string, modelId: string) => {
      setModelBusy(true);
      setModels((prev) => (prev ? { ...prev, currentModelId: `${provider}:${modelId}` } : prev));
      try {
        await fetch("/api/agents/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentId, action: "model", provider, modelId }),
        });
      } finally {
        setModelBusy(false);
        void loadModels();
      }
    },
    [agentId, loadModels],
  );

  /* ---------------- 派生：消息 / 流状态 / 统计 / turn ---------------- */

  const messages: AgentMessage[] = useMemo(
    () => (chat.streaming ? [...chat.messages, chat.streaming] : chat.messages),
    [chat],
  );
  const entryIds = useMemo(() => messages.map((_, index) => `acp:${index}`), [messages]);

  const streamState = useMemo(
    () => ({
      isStreaming: chat.streaming !== null,
      streamingMessage: chat.streaming,
    }),
    [chat.streaming],
  );

  const agentPhase: AgentPhase = useMemo(() => {
    if (permission) return null;
    if (status === "waiting") {
      const last = messages[messages.length - 1];
      const runningTools = [];
      if (last && last.role === "assistant") {
        for (const block of last.content) {
          if (block.type === "toolCall") {
            runningTools.push({ id: block.toolCallId, name: block.toolName ?? "tool" });
          }
        }
      }
      if (runningTools.length > 0) return { kind: "running_tools", tools: runningTools };
      return { kind: "waiting_model" };
    }
    return null;
  }, [permission, status, messages]);

  /** 观测栏 sessionStats：state.db 真源 → SessionStatsInfo 形状（缺的字段不编） */
  const sessionStats: SessionStatsInfo | null = useMemo(() => {
    if (!hermesStats) return null;
    let userMessages = 0;
    let assistantMessages = 0;
    let toolResults = 0;
    for (const message of messages) {
      if (message.role === "user") userMessages += 1;
      else if (message.role === "assistant") assistantMessages += 1;
      else if (message.role === "toolResult") toolResults += 1;
    }
    return {
      sessionId: hermesStats.sessionId,
      sessionName: hermesStats.title ?? title ?? undefined,
      userMessages,
      assistantMessages,
      toolCalls: hermesStats.toolCallCount,
      toolResults,
      totalMessages: hermesStats.messageCount,
      tokens: {
        input: hermesStats.inputTokens,
        output: hermesStats.outputTokens,
        cacheRead: hermesStats.cacheReadTokens,
        cacheWrite: hermesStats.cacheWriteTokens,
        total: hermesStats.inputTokens + hermesStats.outputTokens,
      },
      cost: hermesStats.costUsd,
      totalActiveMs: undefined,
    };
  }, [hermesStats, messages, title]);

  /** 观测栏 turn：来自 turn_end 事件（步数 / 耗时 / token）；回滚是 Pi 专属 → 无操作 */
  const acpTurn: TurnCheckpointsState | null = useMemo(() => {
    if (!turnStat) return null;
    const checkpoint: TurnCheckpoint = {
      id: "acp-turn-latest",
      turnIndex: 0,
      createdAt: turnStartedAt.current ? new Date(turnStartedAt.current).toISOString() : new Date().toISOString(),
      closedAt: new Date().toISOString(),
      status: "done",
      cwd: session?.cwd ?? "",
      fileCount: 0,
      restorableCount: 0,
      commands: [] as TurnCommand[],
      files: [],
    };
    const latestRound: TurnRound = {
      checkpoints: [checkpoint],
      files: [],
      commands: [],
      fileCount: 0,
      createdCount: 0,
      restorableCount: 0,
    };
    return {
      checkpoints: [checkpoint],
      latestRound,
      restoring: false,
      restore: async () => {},
      restoreFile: async () => {},
      reload: () => {},
    };
  }, [turnStat, session?.cwd]);

  /* ---------------- 表面组装 ---------------- */

  const displayModel = useMemo(() => {
    if (!models?.currentModelId) return null;
    return { provider: ctx.provider, modelId: ctx.modelId };
  }, [models?.currentModelId, ctx]);

  return {
    ...makeEmptySurfaceParts(),
    // 真实状态
    loading,
    error: error ?? (connection === "lost" ? "与 Hermes 宿主的连接已断开" : null),
    messages,
    entryIds,
    streamState,
    agentRunning: status === "waiting",
    agentPhase,
    data: null,
    contextUsage: null, // ACP 的 usage_update 给不了上下文占用 → null，不编
    displayModel,
    modelList: (models?.availableModels ?? []).map((item) => ({
      id: item.modelId,
      provider: item.modelId.includes(":") ? item.modelId.split(":")[0] : ctx.provider,
      name: item.name ?? item.modelId,
    })),
    modelSwitching: modelBusy,
    sessionStats,
    thinkingLevel: "auto" as Surface["thinkingLevel"],
    hasEarlierMessages: false,
    loadingEarlier: false,
    queuedMessages: { steering: [], followUp: [] },
    extensionWidgets: [] as Surface["extensionWidgets"],
    extensionStatuses: [] as Surface["extensionStatuses"],
    // 审批：与 Pi 的 extensionDialog 不同源，但 ChatView 只要求「有请求 → 渲染 → 回答」。
    // 这里把 permission 映射成 ChatView 期望的扩展对话框形状不可行（结构不同），
    // Hermes 的审批由宿主的 /pending 通道承载，界面上以 agentPhase + 宿主页面的审批卡出现。
    extensionDialog: null,
    respondToExtensionUi: (async () => {}) as Surface["respondToExtensionUi"],
    sessionIdRef,
    scrollContainerRef,
    lastUserMsgRef,
    handleSend: handleSend as Surface["handleSend"],
    handleAbort: handleAbort as Surface["handleAbort"],
    handleModelChange: handleModelChange as Surface["handleModelChange"],
    loadModels: loadModels as Surface["loadModels"],
    scrollToBottom: ((behavior: ScrollBehavior = "smooth") => {
      const el = scrollContainerRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior });
    }) as Surface["scrollToBottom"],
    loadEarlier: (async () => {}) as Surface["loadEarlier"],
    // 观测栏 turn（P2 扩展字段；Pi 侧没有）
    acpTurn,
    // 内部状态引用：供宿主工作台复用（原 HermesChat 的能力等价搬入）
    hermesPermission: permission,
    hermesRespondToPermission: respondToPermission,
    hermesTitle: title,
    hermesConnection: connection,
    hermesTurnStat: turnStat,
    hermesSessionDbId: sessionDbId,
    hermesProfile: profile,
  } as unknown as Surface;
}
