"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/components/lib/utils";

/**
 * Hermes 运行时的对话面（ACP）。
 *
 * 只做「说一句话 → 看流 → 拍板权限」这一条闭环；
 * 过程渲染先保持朴素（消息 / 思考 / 工具行 / 权限卡），
 * 等真实用起来再按需要长成完整的工具卡片。
 */

type ChatMessage = { id: number; role: "user" | "agent"; text: string };
type ToolRow = { id: string; title: string; kind?: string; locations?: string[]; status?: string; output?: string };
type PermissionOption = { optionId: string; name?: string; kind?: string };
type PermissionRequest = { requestId: number; title: string; options: PermissionOption[] };

let nextMessageId = 1;

export function AgentChat({ agentId, profile }: { agentId: string; profile: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [thought, setThought] = useState("");
  const [tools, setTools] = useState<ToolRow[]>([]);
  const [permission, setPermission] = useState<PermissionRequest | null>(null);
  const [status, setStatus] = useState<"idle" | "waiting" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  /** Hermes 自动生成的会话标题 */
  const [title, setTitle] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);

  const appendAgentText = useCallback((text: string) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === "agent") {
        const copy = prev.slice(0, -1);
        return [...copy, { ...last, text: last.text + text }];
      }
      return [...prev, { id: nextMessageId++, role: "agent", text }];
    });
  }, []);

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
      } else if (type === "title") {
        setTitle(String(data.title ?? ""));
      } else if (type === "update") {
        const update = (data.update ?? {}) as Record<string, unknown>;
        const kind = String(update.sessionUpdate ?? "");
        const content = (update.content ?? {}) as { text?: string };
        if (kind === "agent_message_chunk") appendAgentText(content.text ?? "");
        else if (kind === "agent_thought_chunk") setThought((prev) => prev + (content.text ?? ""));
        else if (kind === "tool_call") {
          setTools((prev) => [
            ...prev,
            {
              id: String(update.toolCallId ?? prev.length),
              title: String(update.title ?? "工具调用"),
              kind: typeof update.kind === "string" ? update.kind : undefined,
              locations: Array.isArray(update.locations)
                ? (update.locations as { path?: string }[]).map((l) => l.path).filter((p): p is string => !!p)
                : undefined,
              status: String(update.status ?? ""),
            },
          ]);
        } else if (kind === "tool_call_update") {
          const rawContent = Array.isArray(update.content) ? (update.content as unknown[]) : [];
          const outputText = rawContent
            .flatMap((block) => {
              const b = block as { type?: string; content?: { text?: string } };
              if (b?.type === "content" && typeof b.content?.text === "string") return [b.content.text];
              return [];
            })
            .join("\n")
            .trim();
          setTools((prev) =>
            prev.map((tool) =>
              tool.id === String(update.toolCallId)
                ? {
                    ...tool,
                    status: String(update.status ?? tool.status),
                    output: outputText || tool.output,
                  }
                : tool,
            ),
          );
        }
      } else if (type === "permission") {
        const options = Array.isArray(data.options) ? (data.options as PermissionOption[]) : [];
        const toolCall = (data.toolCall ?? {}) as { title?: string };
        setPermission({
          requestId: Number(data.requestId),
          title: toolCall.title ?? "需要授权",
          options,
        });
        setStatus("waiting");
      } else if (type === "turn_end") {
        setStatus("idle");
        setThought("");
        // 面板重新读盘：Agent 这一轮可能刚写完 data/*.json
        window.dispatchEvent(new Event("elenva:agent-turn-end"));
      } else if (type === "error") {
        setError(String(data.message ?? "未知错误"));
        setStatus("error");
      }
    };
    source.onerror = () => {
      // EventSource 会自己重连；这里只把状态标出来，不弹错
      setStatus((prev) => (prev === "waiting" ? prev : "idle"));
    };
    return () => source.close();
  }, [agentId, appendAgentText]);

  // 历史：刷新页面后把落盘的对话读回来（落盘在 ACP 宿主侧，文件在应用包 data/chat.jsonl）
  useEffect(() => {
    let alive = true;
    fetch(`/api/agents/chat/history?agentId=${encodeURIComponent(agentId)}`, { cache: "no-store" })
      .then((res) => res.json())
      .then((data: { messages?: { role: "user" | "agent"; text: string }[] }) => {
        if (!alive) return;
        const items = (data.messages ?? []).map((message) => ({
          id: nextMessageId++,
          role: message.role,
          text: message.text,
        }));
        // 只在本轮还没有任何消息时回填，避免把正在流的这一轮盖掉
        if (items.length > 0) setMessages((prev) => (prev.length > 0 ? prev : items));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [agentId]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages, thought, tools, permission]);

  const send = async () => {
    const text = input.trim();
    if (!text || status === "waiting") return;
    setInput("");
    setError(null);
    setThought("");
    setTools([]);
    setMessages((prev) => [...prev, { id: nextMessageId++, role: "user", text }]);
    setStatus("waiting");
    try {
      const res = await fetch("/api/agents/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId, action: "prompt", text }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `HTTP ${res.status}`);
        setStatus("error");
      }
    } catch (e) {
      setError(String(e));
      setStatus("error");
    }
  };

  const answer = async (optionId: string) => {
    if (!permission) return;
    const requestId = permission.requestId;
    setPermission(null);
    setStatus("waiting");
    await fetch("/api/agents/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, action: "permission", requestId, optionId }),
    }).catch(() => {});
  };

  const cancel = async () => {
    await fetch("/api/agents/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, action: "cancel" }),
    }).catch(() => {});
  };

  const reset = async () => {
    await fetch("/api/agents/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, action: "reset" }),
    }).catch(() => {});
    setMessages([]);
    setTools([]);
    setThought("");
    setPermission(null);
    setError(null);
    setStatus("idle");
  };

  return (
    <Card className="mt-6" data-testid="agent-chat">
      <CardHeader>
        <CardTitle>对话</CardTitle>
        <span className="truncate text-[10px] text-dim/70" title={title ?? "ACP"}>
          ACP · {profile}
          {title ? ` · ${title}` : ""}
        </span>
        <button
          type="button"
          onClick={reset}
          className="ml-auto cursor-pointer rounded-md border border-line px-2 py-0.5 text-[11px] text-dim t-fast hover:bg-hover hover:text-fg"
        >
          重置会话
        </button>
      </CardHeader>

      <div ref={scroller} className="max-h-[420px] overflow-y-auto px-4 py-3" data-testid="agent-chat-log">
        {messages.length === 0 && !error && (
          <div className="text-[12px] text-dim">
            这个 Agent 由 Hermes 承载（profile: {profile}）。说一句话就开始，工具调用与授权会出现在这里。
          </div>
        )}
        <div className="flex flex-col gap-2">
          {messages.map((message) => (
            <div key={message.id} className="text-[13px] leading-relaxed">
              <span className={cn("mr-2 text-[11px]", message.role === "user" ? "text-dim" : "text-accent")}>
                {message.role === "user" ? "你" : "Agent"}
              </span>
              <span className="whitespace-pre-wrap text-fg">{message.text}</span>
            </div>
          ))}
        </div>

        {thought && status === "waiting" && (
          <div className="mt-2 whitespace-pre-wrap text-[11px] leading-relaxed text-dim/70">{thought.slice(-400)}</div>
        )}

        {tools.length > 0 && (
          <div className="mt-2 flex flex-col gap-1">
            {tools.map((tool) => (
              <details
                key={tool.id}
                data-testid="agent-tool"
                className="rounded-lg border border-line bg-panel-2"
              >
                <summary className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[11px] text-dim">
                  <span className="shrink-0 rounded-sm border border-line px-1">{tool.kind ?? "工具"}</span>
                  <span className="min-w-0 flex-1 truncate text-fg">{tool.title}</span>
                  {tool.status && <span className="shrink-0 text-dim/70">{tool.status}</span>}
                </summary>
                <div className="px-3 pb-2">
                  {tool.locations && tool.locations.length > 0 && (
                    <div className="text-[10px] text-dim/70">{tool.locations.join(" · ")}</div>
                  )}
                  {tool.output ? (
                    <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-panel px-2 py-1.5 text-[11px] leading-relaxed text-dim">
                      {tool.output.slice(0, 4000)}
                      {tool.output.length > 4000 ? "\n…（已截断）" : ""}
                    </pre>
                  ) : (
                    <div className="mt-1 text-[11px] text-dim/70">没有输出</div>
                  )}
                </div>
              </details>
            ))}
          </div>
        )}

        {permission && (
          <div className="mt-3 rounded-lg border border-line bg-panel-2 p-3" data-testid="agent-permission">
            <div className="text-[12px] text-fg">{permission.title}</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {permission.options.map((option) => (
                <button
                  key={option.optionId}
                  type="button"
                  onClick={() => void answer(option.optionId)}
                  className="cursor-pointer rounded-md border border-line px-2 py-1 text-[11px] text-dim t-fast hover:bg-hover hover:text-fg"
                >
                  {option.name ?? option.optionId}
                </button>
              ))}
            </div>
          </div>
        )}

        {error && <div className="mt-2 text-[12px] text-dim">出错了：{error}</div>}
      </div>

      <div className="flex items-end gap-2 border-t border-line-soft px-4 py-3">
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          rows={2}
          placeholder={sessionId ? "说点什么…（Enter 发送，Shift+Enter 换行）" : "说点什么…（首次发送会启动这个 Agent 的 ACP 进程）"}
          className="min-h-9 w-full resize-none rounded-lg border border-line bg-panel-2 px-3 py-2 text-[13px] text-fg outline-none placeholder:text-dim"
        />
        {status === "waiting" ? (
          <button
            type="button"
            onClick={() => void cancel()}
            className="h-9 shrink-0 cursor-pointer rounded-lg border border-line px-3.5 text-[12px] text-dim t-fast hover:bg-hover hover:text-fg"
          >
            停止
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void send()}
            disabled={!input.trim()}
            className="h-9 shrink-0 cursor-pointer rounded-lg bg-accent px-3.5 text-[12px] font-semibold text-accent-fg t-fast hover:bg-accent-hover disabled:cursor-default disabled:opacity-50"
          >
            发送
          </button>
        )}
      </div>
    </Card>
  );
}
