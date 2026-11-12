"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/components/lib/utils";
import type { AgentRecord } from "@/lib/agents/manifest";
import { formatTokens } from "@/lib/format";
import { HermesChat } from "@/components/HermesChat";

/**
 * 应用包 Agent（Hermes 运行时）的只读资源页：会话 / 记忆 / 技能。
 *
 * 之前这些菜单点了是静默无反应。现在能进、能看，但只读 —— 写路径（改记忆、
 * 装技能）还没接，界面上不放假按钮。
 */

type Kind = "sessions" | "memory" | "skills" | "soul" | "rhythm" | "usage";

type SessionRow = {
  id: string;
  title: string;
  source: string;
  startedAt: string;
  lastActivityAt: string;
  messageCount: number;
  model?: string;
};

type MessageRow = { role: string; text: string; toolName?: string; at: string };

type MemoryFile = { name: string; entries: { id: string; text: string }[]; bytes: number };

type SkillRow = { name: string; description: string; category: string; path: string };

const TITLES: Record<Kind, string> = {
  sessions: "会话",
  memory: "记忆",
  skills: "技能",
  soul: "身份",
  rhythm: "节律",
  usage: "成长",
};

function fmt(iso: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "—";
  }
}

/** 会话来源的短标签：同一个我有多个入口，列表里得能看出这句是在哪说的 */
const SOURCE_LABEL: Record<string, string> = {
  feishu: "飞书",
  cron: "定时",
  acp: "工作台",
  oneshot: "一次性",
  cli: "终端",
  local: "",
};

/**
 * cron 表达式 → 人话。
 *
 * 节律页原来直接摊 `0 8 * * *` 和 `every 360m` —— 前者要读的人自己是 cron 解析器，
 * 后者连单位都没换算。认不出来的表达式原样返回，不猜。
 */
function cronLabel(spec: string): string {
  const text = (spec ?? "").trim();
  const every = /^every\s+(\d+)\s*m$/i.exec(text);
  if (every) {
    const minutes = Number(every[1]);
    return minutes % 60 === 0 ? `每 ${minutes / 60} 小时` : `每 ${minutes} 分钟`;
  }
  const parts = text.split(/\s+/);
  if (parts.length === 5 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
    const [min, hour, dom, mon, dow] = parts;
    const at = `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
    if (dom === "*" && mon === "*" && dow === "*") return `每天 ${at}`;
    if (dom === "*" && mon === "*" && /^\d$/.test(dow)) return `每周${"日一二三四五六"[Number(dow)]} ${at}`;
    if (dom === "*" && mon === "*" && dow === "1-5") return `工作日 ${at}`;
    if (dow === "*" && mon === "*" && /^\d+$/.test(dom)) return `每月 ${dom} 日 ${at}`;
  }
  return text;
}

/** profile 目录的展示位置：默认 profile 在 ~/.hermes/，其余在 ~/.hermes/profiles/<id>/ */
function profileHome(agent: AgentRecord): string {
  const profile = agent.profile ?? agent.id;
  return profile === "default" ? "~/.hermes/" : `~/.hermes/profiles/${profile}/`;
}

export function AgentResourcesPage({ agent, kind }: { agent: AgentRecord; kind: Kind }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [files, setFiles] = useState<MemoryFile[]>([]);
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [openSession, setOpenSession] = useState<string | null>(null);
  const [soul, setSoul] = useState<{ content: string; bytes: number; modifiedAt: string } | null>(null);
  const [soulDraft, setSoulDraft] = useState("");
  const [soulState, setSoulState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [soulMsg, setSoulMsg] = useState<string | null>(null);
  const [jobs, setJobs] = useState<{ id: string; name: string; schedule: string; enabled: boolean; lastStatus?: string }[]>([]);
  const [usage, setUsage] = useState<{ sessions: number; messages: number; inputTokens: number; outputTokens: number } | null>(null);
  /** 当前加载的历史会话：变化后 AgentChat 会 session/load 并重放历史 */
  const [resumeId, setResumeId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [skillQuery, setSkillQuery] = useState("");
  const [messages, setMessages] = useState<MessageRow[] | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setMessages(null);
    setOpenSession(null);
    fetch(`/api/agents/resources?id=${encodeURIComponent(agent.id)}&kind=${kind}`, { cache: "no-store" })
      .then((res) => res.json().then((data) => ({ res, data })))
      .then(({ res, data }: { res: Response; data: Record<string, unknown> }) => {
        if (!alive) return;
        if (!res.ok) {
          setError(String(data.error ?? `HTTP ${res.status}`));
          return;
        }
        if (kind === "sessions") setSessions((data.sessions as SessionRow[]) ?? []);
        if (kind === "memory") setFiles((data.files as MemoryFile[]) ?? []);
        if (kind === "skills") setSkills((data.skills as SkillRow[]) ?? []);
        if (kind === "soul") {
          const doc = data.soul as { content: string; bytes: number; modifiedAt: string } | null;
          setSoul(doc);
          setSoulDraft(doc?.content ?? "");
        }
        if (kind === "rhythm") setJobs((data.jobs as typeof jobs) ?? []);
        if (kind === "usage") setUsage((data.usage as typeof usage) ?? null);
      })
      .catch((cause) => alive && setError(String(cause)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [agent.id, kind]);

  const openMessages = useCallback(
    async (sessionId: string) => {
      if (openSession === sessionId) {
        setOpenSession(null);
        return;
      }
      setOpenSession(sessionId);
      setMessages(null);
      try {
        const res = await fetch(
          `/api/agents/resources?id=${encodeURIComponent(agent.id)}&kind=messages&session=${encodeURIComponent(sessionId)}`,
          { cache: "no-store" },
        );
        const data = (await res.json().catch(() => ({}))) as { messages?: MessageRow[]; error?: string };
        if (!res.ok) setError(data.error ?? `HTTP ${res.status}`);
        else setMessages(data.messages ?? []);
      } catch (cause) {
        setError(String(cause));
      }
    },
    [agent.id, openSession],
  );

  if (kind === "sessions") {
    const filtered = query.trim()
      ? sessions.filter((session) => session.title.toLowerCase().includes(query.trim().toLowerCase()))
      : sessions;
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfYesterday = startOfToday - 24 * 3600 * 1000;
    const startOfWeek = startOfToday - 6 * 24 * 3600 * 1000;
    const buckets: { label: string; items: typeof sessions }[] = [
      { label: "今天", items: [] },
      { label: "昨天", items: [] },
      { label: "本周", items: [] },
      { label: "更早", items: [] },
    ];
    for (const session of filtered) {
      const at = new Date(session.lastActivityAt).getTime();
      if (Number.isNaN(at)) buckets[3].items.push(session);
      else if (at >= startOfToday) buckets[0].items.push(session);
      else if (at >= startOfYesterday) buckets[1].items.push(session);
      else if (at >= startOfWeek) buckets[2].items.push(session);
      else buckets[3].items.push(session);
    }
    const grouped = buckets.filter((bucket) => bucket.items.length > 0);

    return (
      <div className="flex min-h-0 flex-1" data-testid="agent-resources">
        {/* 左：历史会话 */}
        <aside className="flex w-full shrink-0 flex-col border-b border-line bg-panel min-[900px]:h-full min-[900px]:w-64 min-[900px]:border-b-0 min-[900px]:border-r">
          <div className="flex shrink-0 items-center gap-2 border-b border-line-soft px-3 py-2">
            <span className="text-[10px] tracking-wide text-dim">
              会话 · {agent.name}
              {sessions.length > 0 && <span className="ml-1 tabular-nums text-dim/60">{filtered.length}/{sessions.length}</span>}
            </span>
            <button type="button" className="btn btn-sm btn-subtle ml-auto" onClick={() => setResumeId(null)}>
              新会话
            </button>
          </div>
          <div className="shrink-0 px-2 py-1.5">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜标题…"
              className="h-7 w-full rounded-md border border-line bg-panel-2 px-2 text-[12px] text-fg outline-none placeholder:text-dim focus:border-accent"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto max-[899px]:max-h-40 max-[899px]:flex max-[899px]:flex-row max-[899px]:gap-1 max-[899px]:overflow-x-auto max-[899px]:overflow-y-hidden max-[899px]:px-2 max-[899px]:pb-2">
            {loading ? (
              <div className="px-1 py-2 text-[11px] text-dim">读取中…</div>
            ) : grouped.length === 0 ? (
              <div className="px-1 py-2 text-[11px] text-dim">{query ? "没有匹配的会话" : "还没有会话。"}</div>
            ) : (
              grouped.map((group) => (
                <div key={group.label} className="max-[899px]:flex max-[899px]:items-center max-[899px]:gap-1">
                  <div className="px-1 pb-1 pt-2 text-[10px] tracking-wide text-dim/70 max-[899px]:hidden">{group.label}</div>
                  {group.items.map((session) => (
                    <button
                      key={session.id}
                      type="button"
                      className={cn(
                        "flex w-full flex-col gap-0.5 border-b border-line-soft px-2 py-1.5 text-left t-fast max-[899px]:w-40 max-[899px]:shrink-0 max-[899px]:rounded-md max-[899px]:border",
                        resumeId === session.id ? "bg-accent-soft" : "hover:bg-hover",
                      )}
                      onClick={() => setResumeId(session.id)}
                    >
                      <span className={cn("truncate text-[12px]", resumeId === session.id ? "font-semibold text-accent" : "text-fg")}>
                        {session.title}
                      </span>
                      <span className="text-[10px] text-dim">
                        {SOURCE_LABEL[session.source] ? `${SOURCE_LABEL[session.source]} · ` : ""}
                        {fmt(session.lastActivityAt)} · {session.messageCount} 条
                      </span>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </aside>

        {/* 右：对话（全宽，不要观测栏） */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="agent-session-chat">
          <HermesChat
            key={resumeId ?? "new"}
            agentId={agent.id}
            profile={agent.profile ?? agent.id}
            variant="pane"
            resumeSessionId={resumeId}
            // 没选历史会话时，从 Hermes state.db（单一真源）读回最近一段对话（刷新不丢）；
            // 选了历史会话则由 ACP 的 session/load 重放，避免两份记录缠在一起
            history={!resumeId}
          />
        </div>
      </div>
    );
  }

  const saveSoul = async () => {
    setSoulState("saving");
    setSoulMsg(null);
    try {
      const res = await fetch("/api/agents/resources", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: agent.id, content: soulDraft }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; backup?: string; note?: string; bytes?: number };
      if (!res.ok) {
        setSoulState("error");
        setSoulMsg(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setSoulState("saved");
      setSoulMsg(`${data.note ?? "已保存"}（${data.bytes ?? 0} 字节，备份 ${data.backup ?? "—"}）`);
      setSoul((prev) => (prev ? { ...prev, content: soulDraft, bytes: data.bytes ?? prev.bytes } : prev));
    } catch (cause) {
      setSoulState("error");
      setSoulMsg(String(cause));
    }
  };

  return (
    <div className="flex-1 overflow-y-auto px-6 py-6" data-page-scroll data-testid="agent-resources">
      <div className="mx-auto flex max-w-4xl flex-col gap-4">
        <div className="flex flex-wrap items-baseline gap-2">
          <h1 className="text-[20px] font-bold tracking-tight">{agent.name} · {TITLES[kind]}</h1>
          <span className="chip">只读</span>
          <span className="text-[11px] text-dim">来自 {profileHome(agent)}</span>
        </div>

        {error && <Card><div className="px-4 py-3 text-[12px] text-danger">{error}</div></Card>}
        {loading && <div className="text-[12px] text-dim">读取中…</div>}

        {/* 会话在下面单独整屏渲染（双栏），这里不占位 */}

        {/* 记忆：MEMORY.md / USER.md 条目 */}
        {kind === "memory" && !loading && (
          files.length === 0 ? (
            <Card><div className="px-4 py-3 text-[12px] text-dim">没有读到记忆文件。</div></Card>
          ) : (
            files.map((file) => (
              <Card key={file.name}>
                <CardHeader>
                  <CardTitle>{file.name}</CardTitle>
                  <span className="ml-auto text-[10px] text-dim/70">
                    {file.entries.length} 条 · {Math.round(file.bytes / 1024)}KB
                  </span>
                </CardHeader>
                <div className="flex flex-col divide-y divide-line-soft">
                  {file.entries.map((entry) => (
                    <div key={entry.id} className="px-4 py-2 text-[12px] leading-relaxed text-fg">
                      {entry.text}
                    </div>
                  ))}
                </div>
              </Card>
            ))
          )
        )}

        {/* 身份：SOUL.md 可编辑（写回带备份，新会话生效） */}
        {kind === "soul" && !loading && (
          soul === null ? (
            <Card><div className="px-4 py-3 text-[12px] text-dim">这个 profile 还没有 SOUL.md。</div></Card>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>SOUL.md</CardTitle>
                <span className="ml-auto text-[10px] text-dim/70">
                  {Math.round((soulDraft.length * 1) / 1)} 字符 · 改完新会话生效
                </span>
              </CardHeader>
              <div className="px-4 py-3">
                <textarea
                  value={soulDraft}
                  onChange={(event) => {
                    setSoulDraft(event.target.value);
                    setSoulState("idle");
                  }}
                  spellCheck={false}
                  aria-label="SOUL 内容"
                  className="min-h-[520px] w-full resize-y rounded-lg border border-line bg-panel-2 px-3 py-2 font-mono text-[12px] leading-relaxed text-fg outline-none t-fast focus:border-accent"
                />
                <div className="mt-2 flex items-center gap-2">
                  <button type="button" className="btn btn-sm btn-primary" disabled={soulState === "saving"} onClick={() => void saveSoul()}>
                    {soulState === "saving" ? "保存中…" : "保存"}
                  </button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSoulDraft(soul.content)}>
                    还原
                  </button>
                  <span className={cn("text-[11px]", soulState === "error" ? "text-danger" : "text-dim")}>
                    {soulMsg ?? "这是它的身份与规则（系统提示词第 1 段）；技能与记忆不在这个文件里"}
                  </span>
                </div>
              </div>
            </Card>
          )
        )}

        {/* 节律：cron 任务 */}
        {kind === "rhythm" && !loading && (
          jobs.length === 0 ? (
            <Card><div className="px-4 py-3 text-[12px] text-dim">这个 Agent 还没有节律任务（cron）。</div></Card>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>节律任务</CardTitle>
                <span className="ml-auto text-[10px] text-dim/70">{jobs.length} 个 · 只读</span>
              </CardHeader>
              <div className="flex flex-col divide-y divide-line-soft">
                {jobs.map((job) => (
                  <div key={job.id} className="flex items-center gap-2 px-4 py-2 text-[12px]">
                    <span className="min-w-0 flex-1 truncate text-fg">{job.name}</span>
                    <span className="shrink-0 text-[11px] text-dim" title={job.schedule}>
                      {cronLabel(job.schedule)}
                    </span>
                    <span className={cn("chip", job.lastStatus === "error" ? "chip-danger" : "")}>
                      {job.lastStatus ?? (job.enabled ? "待跑" : "已停")}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )
        )}

        {/* 成长：用量汇总 */}
        {kind === "usage" && !loading && (
          usage === null ? (
            <Card><div className="px-4 py-3 text-[12px] text-dim">读不到用量（state.db 不可用）。</div></Card>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>用量</CardTitle>
                <span className="ml-auto text-[10px] text-dim/70">来自 state.db</span>
              </CardHeader>
              <div className="grid grid-cols-2 gap-3 px-4 py-3 sm:grid-cols-4">
                {[
                  ["会话", usage.sessions.toLocaleString()],
                  ["消息", usage.messages.toLocaleString()],
                  ["输入 tokens", formatTokens(usage.inputTokens)],
                  ["输出 tokens", formatTokens(usage.outputTokens)],
                ].map(([label, value]) => (
                  <div key={String(label)}>
                    <div className="text-[10px] text-dim">{label}</div>
                    <div className="text-[20px] font-semibold tabular-nums">{value}</div>
                  </div>
                ))}
              </div>
            </Card>
          )
        )}

        {/* 技能：搜索 + 按分类分组。93 个技能平铺一页读不完，「有搜索 + 有分组」才算能用 */}
        {kind === "skills" && !loading && (
          skills.length === 0 ? (
            <Card><div className="px-4 py-3 text-[12px] text-dim">这个 profile 里还没有技能。</div></Card>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <input
                  value={skillQuery}
                  onChange={(event) => setSkillQuery(event.target.value)}
                  placeholder={`搜技能（${skills.length} 个）…`}
                  className="h-8 w-full max-w-sm rounded-md border border-line bg-panel px-2.5 text-[12px] text-fg outline-none placeholder:text-dim focus:border-accent"
                />
                {skillQuery && (
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSkillQuery("")}>
                    清空
                  </button>
                )}
              </div>
              {(() => {
                const q = skillQuery.trim().toLowerCase();
                const filtered = q
                  ? skills.filter((skill) =>
                      `${skill.name} ${skill.description} ${skill.category}`.toLowerCase().includes(q),
                    )
                  : skills;
                if (filtered.length === 0) {
                  return <Card><div className="px-4 py-3 text-[12px] text-dim">没有匹配的技能。</div></Card>;
                }
                const groups = new Map<string, SkillRow[]>();
                for (const skill of filtered) {
                  const key = skill.category || "通用";
                  groups.set(key, [...(groups.get(key) ?? []), skill]);
                }
                return [...groups.entries()]
                  .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
                  .map(([category, rows]) => (
                    <Card key={category}>
                      <CardHeader>
                        <CardTitle>{category}</CardTitle>
                        <span className="ml-auto text-[10px] tabular-nums text-dim/70">{rows.length}</span>
                      </CardHeader>
                      <div className="flex flex-col divide-y divide-line-soft">
                        {rows.map((skill) => (
                          <div key={skill.path} className="px-4 py-2" title={skill.path}>
                            <div className="text-[12px] font-medium text-fg">{skill.name}</div>
                            {skill.description && (
                              <div className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-dim">
                                {skill.description}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </Card>
                  ));
              })()}
            </div>
          )
        )}
      </div>
    </div>
  );
}
