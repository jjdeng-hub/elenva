"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatInput } from "@/components/ChatInput";
import { ChatWindow } from "@/components/ChatWindow";
import { ModelPicker } from "@/components/ModelPicker";
import { cn } from "@/components/lib/utils";
import { lineDiff } from "@/lib/line-diff";
import type { AgentPhase } from "@/lib/agent-phase";
import {
  addToolCall,
  addToolResult,
  appendAssistantText,
  appendThinkingText,
  appendUserText,
  recordsToMessages,
  sealTurn,
  type AcpChatState,
} from "@/lib/acp-chat";

/**
 * Hermes 会话面 —— 复用 ELENVA 的会话 UI（ChatWindow / ChatInput / ModelPicker），
 * 自己只做一件事：把 ACP 的事件流翻译成同一套 AgentMessage。
 *
 * 原则：换 Agent 不换界面。工具卡、diff、思考块、输入框、模型选择都由平台组件渲染，
 * 这里只负责「Hermes 说了什么、做了什么、要谁拍板」。
 */

type ModelItem = { modelId: string; name?: string; description?: string };
type ModelState = { currentModelId?: string; availableModels?: ModelItem[] };

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

/** ACP 的工具内容块：文本摘要或 diff */
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

export function HermesChat({
  agentId,
  profile,
  variant = "pane",
  resumeSessionId,
  history = true,
}: {
  agentId: string;
  profile: string;
  variant?: "card" | "pane";
  resumeSessionId?: string | null;
  history?: boolean;
}) {
  const [chat, setChat] = useState<AcpChatState>({ messages: [], streaming: null });
  const [status, setStatus] = useState<"idle" | "waiting" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [permission, setPermission] = useState<PermissionRequest | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [models, setModels] = useState<ModelState | null>(null);
  const [modelBusy, setModelBusy] = useState(false);
  const [connection, setConnection] = useState<"live" | "lost">("live");
  const [turnStat, setTurnStat] = useState<{ steps: number; ms: number; tokens?: string } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const scroller = useRef<HTMLDivElement | null>(null);
  const lastUserMsgRef = useRef<HTMLDivElement | null>(null);
  const turnStartedAt = useRef<number | null>(null);
  const toolsCount = useRef(0);
  const handledRequests = useRef(new Set<number>());
  const ignoreErrorsUntil = useRef(0);
  /** 审批带回来的 diff：等对应的工具卡出现时贴到它的参数上 */
  const diffByPath = useRef(new Map<string, ToolDiff>());

  const currentModelId = models?.currentModelId ?? "";
  const [provider, modelId] = currentModelId.includes(":")
    ? [currentModelId.split(":")[0], currentModelId.split(":").slice(1).join(":")]
    : ["opencode-go", currentModelId || "unknown"];
  const ctx = useMemo(() => ({ provider, modelId }), [provider, modelId]);

  /* ---------------- 传输：SSE ---------------- */

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

  // 审批卡不能只依赖 SSE 事件：事件丢了整轮就静默卡死。常驻对一次宿主（本地调用，很便宜），
  // 这样刷新页面回来也能看到还挂着的审批。
  useEffect(() => {
    void syncPending();
    const timer = window.setInterval(() => void syncPending(), 3000);
    return () => window.clearInterval(timer);
  }, [syncPending]);

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
        setSessionId(String(data.sessionId ?? ""));
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
  }, [agentId, ctx, syncPending]);

  /* ---------------- 历史 & 模型清单 ---------------- */

  useEffect(() => {
    if (!history) return;
    let alive = true;
    fetch(`/api/agents/chat/history?agentId=${encodeURIComponent(agentId)}`, { cache: "no-store" })
      .then((res) => res.json())
      .then((data: { messages?: { role: string; text?: string; items?: unknown[]; ts?: number | null }[]; sessionId?: string | null }) => {
        if (!alive) return;
        if (data.sessionId) setSessionId(data.sessionId);
        const records = data.messages ?? [];
        if (records.length === 0) return;
        setChat((prev) => (prev.messages.length > 0 ? prev : { messages: recordsToMessages(records, ctx), streaming: null }));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [agentId, ctx, history]);

  useEffect(() => {
    let alive = true;
    fetch(`/api/agents/chat/models?agentId=${encodeURIComponent(agentId)}&start=1`, { cache: "no-store" })
      .then((res) => res.json())
      .then((data: { models?: ModelState | null }) => {
        if (alive && data.models) setModels(data.models);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [agentId]);

  /* ---------------- 动作 ---------------- */

  const sendText = useCallback(
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

  const cancel = useCallback(async () => {
    await fetch("/api/agents/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, action: "cancel" }),
    }).catch(() => {});
    setStatus("idle");
  }, [agentId]);

  const answer = useCallback(
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

  const reset = useCallback(async () => {
    if (!confirmReset) {
      setConfirmReset(true);
      window.setTimeout(() => setConfirmReset(false), 4000);
      return;
    }
    setConfirmReset(false);
    ignoreErrorsUntil.current = Date.now() + 6000;
    await fetch("/api/agents/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, action: "reset" }),
    }).catch(() => {});
    setChat({ messages: [], streaming: null });
    setPermission(null);
    setError(null);
    setTurnStat(null);
    setTitle(null);
    setStatus("idle");
  }, [agentId, confirmReset]);

  const pickModel = useCallback(
    async (nextProvider: string, nextModel: string) => {
      const modelKey = nextModel.includes(":") ? nextModel : `${nextProvider}:${nextModel}`;
      if (modelKey === models?.currentModelId) return;
      setModelBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/agents/chat/model", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentId, modelId: modelKey }),
        });
        const data = (await res.json().catch(() => ({}))) as { models?: ModelState; error?: string };
        if (!res.ok) {
          setError(data.error ?? `HTTP ${res.status}`);
          setStatus("error");
        } else if (data.models) {
          setModels(data.models);
        }
      } catch (cause) {
        setError(String(cause));
        setStatus("error");
      } finally {
        setModelBusy(false);
      }
    },
    [agentId, models?.currentModelId],
  );

  // 切换历史会话：清空并让 ACP 用 session/load 重放
  useEffect(() => {
    if (!resumeSessionId) return;
    setChat({ messages: [], streaming: null });
    setPermission(null);
    setError(null);
    setStatus("waiting");
    fetch("/api/agents/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, action: "resume", sessionId: resumeSessionId }),
    })
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok) {
          setError(String((data as { error?: string }).error ?? "加载会话失败"));
          setStatus("error");
        }
      })
      .catch((cause) => {
        setError(String(cause));
        setStatus("error");
      });
  }, [agentId, resumeSessionId]);

  // 正文里「选中即操作」发过来的请求（agent-doc-editor 里 dispatch 的事件）
  useEffect(() => {
    const handler = (event: Event) => {
      const text = (event as CustomEvent<{ text?: string }>).detail?.text;
      if (text) void sendText(text);
    };
    window.addEventListener("elenva:agent-prompt", handler);
    return () => window.removeEventListener("elenva:agent-prompt", handler);
  }, [sendText]);

  /* ---------------- 呈现 ---------------- */

  const running = status === "waiting";
  const agentPhase: AgentPhase = running ? { kind: "waiting_model" } : null;
  const modelList = (models?.availableModels ?? []).map((item) => ({
    id: item.modelId,
    name: item.modelId.split(":").slice(1).join(":") || item.name || item.modelId,
    provider: item.modelId.split(":")[0],
  }));

  const statusLine = turnStat
    ? `本轮 ${turnStat.steps} 步 · ${(turnStat.ms / 1000).toFixed(turnStat.ms < 10000 ? 1 : 0)}s${turnStat.tokens ? ` · ${turnStat.tokens}` : ""}`
    : null;

  const banner = (
    <div className="flex flex-col gap-1.5">
      {connection === "lost" && (
        <div className="flex items-center gap-2 rounded-md border border-warning/30 bg-warning/5 px-2.5 py-1.5 text-[11px] text-warning">
          <span className="size-1.5 rounded-full bg-warning" />
          连接断开，正在自动重连——重连后会补回这一轮已经发生的事。
        </div>
      )}
      {permission && (
        <div className="rounded-lg border border-accent/30 bg-accent-soft/40 p-2.5" data-testid="agent-permission">
          <div className="text-[10px] tracking-wide text-accent">需要你拍板</div>
          <div className="mt-1 text-[12px] font-medium text-fg">{permission.title}</div>
          {permission.locations && permission.locations.length > 0 && (
            <div className="mt-0.5 font-mono text-[10px] text-dim">{permission.locations.join(" · ")}</div>
          )}
          {permission.detail && !permission.diff && (
            <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-panel px-2 py-1 text-[11px] leading-relaxed text-dim">
              {permission.detail.slice(0, 1500)}
            </pre>
          )}
          {permission.diff && (
            <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-panel px-2 py-1 text-[11px] leading-4">
              {lineDiff(permission.diff.oldText, permission.diff.newText)
                .slice(0, 60)
                .map((line, index) => (
                  <div
                    key={index}
                    className={cn(
                      "whitespace-pre-wrap break-words",
                      line.kind === "add" ? "text-success" : line.kind === "del" ? "text-danger" : "text-dim",
                    )}
                  >
                    {line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}
                    {line.text}
                  </div>
                ))}
            </pre>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {permission.options.map((option) => {
              const key = `${option.kind ?? ""} ${option.optionId} ${option.name ?? ""}`.toLowerCase();
              const tone =
                key.includes("reject") || key.includes("deny")
                  ? "ghost"
                  : key.includes("always") || key.includes("session")
                    ? "subtle"
                    : "primary";
              return (
                <button
                  key={option.optionId}
                  type="button"
                  onClick={() => void answer(option.optionId)}
                  className={cn("btn btn-sm", tone === "primary" ? "btn-primary" : tone === "subtle" ? "btn-subtle" : "btn-ghost")}
                >
                  {option.name ?? option.optionId}
                </button>
              );
            })}
            <span className="text-[10px] text-dim/70">不选的话，这一轮就停在这里。</span>
          </div>
        </div>
      )}
    </div>
  );

  const body = (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-line-soft px-3 py-1.5">
        <span className="min-w-0 truncate text-[12px] font-medium text-fg">{title ?? "新会话"}</span>
        <span
          className={cn(
            "flex shrink-0 items-center gap-1 text-[10px]",
            running ? "text-accent" : status === "error" ? "text-danger" : "text-dim/70",
          )}
          data-testid="agent-chat-state"
        >
          <span className={cn("size-1.5 rounded-full", running ? "bg-accent anim-pulse-dot" : status === "error" ? "bg-danger" : "bg-line")} />
          {running ? "运行中" : status === "error" ? "出错" : "空闲"}
        </span>
        {statusLine && <span className="shrink-0 text-[10px] tabular-nums text-dim/60">{statusLine}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <span className="text-[10px] text-dim/60">ACP · {profile}</span>
          <button
            type="button"
            onClick={() => void reset()}
            disabled={chat.messages.length === 0 && !sessionId}
            className={cn(
              "rounded-md border px-2 py-0.5 text-[11px] t-fast",
              confirmReset ? "border-danger/40 text-danger" : "border-line text-dim hover:bg-hover hover:text-fg",
              chat.messages.length === 0 && !sessionId && "cursor-default opacity-40",
            )}
          >
            {confirmReset ? "确认重置？" : "重置会话"}
          </button>
        </span>
      </div>

      <ChatWindow
        messages={chat.messages}
        streamState={{ isStreaming: running, streamingMessage: chat.streaming }}
        agentPhase={agentPhase}
        agentRunning={running}
        loading={false}
        error={error}
        sessionTitle={title ?? ""}
        scrollContainerRef={scroller}
        onScrollToBottom={() => {
          const el = scroller.current;
          if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
        }}
        entryIds={[]}
        forkingEntryId={null}
        onFork={() => {}}
        searchQuery=""
        onExitSearch={() => {}}
        sessionId={sessionId}
        lastUserMsgRef={lastUserMsgRef}
        hasEarlierMessages={false}
        loadingEarlier={false}
      />

      <div className="shrink-0 border-t border-line-soft px-3 pb-2 pt-2">
        <div className="mx-auto w-full max-w-3xl">
          <div className="mb-1.5">{banner}</div>
          <ChatInput
            onSend={(text, images) => {
              const suffix = images && images.length > 0 ? `\n（附带 ${images.length} 张图片，暂未上传）` : "";
              void sendText(text + suffix);
            }}
            onStop={() => void cancel()}
            running={running}
            placeholder={sessionId ? "说点什么…" : "说点什么…（首次发送会启动这个 Agent 的 ACP 进程）"}
            slashCommands={[]}
            cwd={null}
            draftKey={`hermes-chat:${agentId}`}
            modelPicker={
              <ModelPicker
                modelList={modelList}
                displayModel={models?.currentModelId ? { provider, modelId } : null}
                modelNames={{}}
                switching={modelBusy}
                thinkingLevel=""
                thinkingLevels={[]}
                onModelChange={(nextProvider, nextModel) => void pickModel(nextProvider, nextModel)}
                onThinkingLevelChange={() => {}}
                hideDefaultAction
              />
            }
          />
        </div>
      </div>
    </>
  );

  if (variant === "card") {
    return (
      <section className="mt-6 rounded-card border border-line bg-panel" data-testid="agent-chat">
        {body}
      </section>
    );
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col" data-testid="agent-chat">
      {body}
    </section>
  );
}
