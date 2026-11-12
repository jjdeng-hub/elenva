"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/components/lib/utils";
import { docMeta, type DocMeta } from "@/lib/agents/doc-meta";
import type { BlockPayload } from "@/lib/agents/workspace";

/**
 * 正文编辑器 —— 工作台的主区域。
 *
 * 写作场景里，手最容易去的地方是**正文本身**，不是输入框。所以这里把操作就地做掉：
 * 选中一段 → 浮条给出「改这段 / 扩写 / 精简」，指令带上选中原文直接发给右栏对话；
 * 缺口条可点，跳到正文对应的那一行。这与 Claude Code「输入模式 + 就地操作」是同一路子，
 * 而不是让人在正文和对话之间来回搬运文本。
 *
 * 列宽 34em（16px 基准 ≈ 544px，约 32 汉字/行）；编辑即保存（1.5s 防抖），保存带 revision。
 */

type SaveState = { kind: "idle" } | { kind: "dirty" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

type Version = { name: string; size: number; savedAt: string; revision: string };

/** 把一段请求发到右栏对话（AgentChat 监听这个事件）。组件之间不直接互相调用。 */
export function promptAgent(text: string): void {
  window.dispatchEvent(new CustomEvent("elenva:agent-prompt", { detail: { text } }));
}

const QUICK_ACTIONS = [
  { id: "tighten", label: "改这段", build: (t: string) => `把下面这段改一版：意思不动，语言更紧，去掉形容词堆叠。改完直接落到文件里。\n\n"""\n${t}\n"""` },
  { id: "expand", label: "扩写", build: (t: string) => `把下面这段扩写一倍：只加一个具体细节（数字、场景或原话），不许加形容词和总结句。\n\n"""\n${t}\n"""` },
  { id: "cut", label: "精简", build: (t: string) => `把下面这段压到一半以内，保留事实，删掉解释性的句子。\n\n"""\n${t}\n"""` },
] as const;

export function AgentDocEditor({
  agentId,
  block,
  onMeta,
}: {
  agentId: string;
  block: BlockPayload;
  onMeta?: (meta: DocMeta | null) => void;
}) {
  const files = block.files ?? [];
  const [active, setActive] = useState<string | null>(files[0]?.path ?? null);
  const [content, setContent] = useState<string | null>(null);
  const [revision, setRevision] = useState("");
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [showVersions, setShowVersions] = useState(false);
  const [selection, setSelection] = useState<{ start: number; end: number; text: string } | null>(null);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const dirtyRef = useRef(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(
    async (path: string) => {
      setState({ kind: "idle" });
      setContent(null);
      setVersions(null);
      setShowVersions(false);
      try {
        const res = await fetch(`/api/agents/data?id=${encodeURIComponent(agentId)}&path=${encodeURIComponent(path)}`, {
          cache: "no-store",
        });
        const data = (await res.json().catch(() => ({}))) as { content?: string; revision?: string; error?: string };
        if (!res.ok || typeof data.content !== "string") {
          setState({ kind: "error", message: data.error ?? `HTTP ${res.status}` });
          return;
        }
        setContent(data.content);
        setRevision(data.revision ?? "");
        setActive(path);
        setSelection(null);
        dirtyRef.current = false;
      } catch (error) {
        setState({ kind: "error", message: String(error) });
      }
    },
    [agentId],
  );

  useEffect(() => {
    if (active) void load(active);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, agentId]);

  useEffect(() => {
    if (!onMeta) return;
    onMeta(content === null ? null : docMeta(content));
  }, [content, onMeta]);

  const save = useCallback(
    async (text: string) => {
      if (!active) return;
      setState({ kind: "saving" });
      try {
        const res = await fetch("/api/agents/data", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: agentId, path: active, revision, content: text }),
        });
        const data = (await res.json().catch(() => ({}))) as { revision?: string; error?: string; details?: string[] };
        if (res.status === 409) {
          // Agent 刚写过这篇：别拿旧内容覆盖，直接载入最新版并说清楚
          await load(active);
          setState({ kind: "error", message: "这篇刚被 Agent 改过，已载入最新版（你的改动没保存）" });
          return;
        }
        if (!res.ok) {
          setState({ kind: "error", message: data.details?.join("；") ?? data.error ?? `HTTP ${res.status}` });
          return;
        }
        setRevision(data.revision ?? revision);
        dirtyRef.current = false;
        setState({ kind: "saved" });
        if (savedTimer.current) clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => setState({ kind: "idle" }), 2500);
      } catch (error) {
        setState({ kind: "error", message: String(error) });
      }
    },
    [active, agentId, load, revision],
  );

  useEffect(() => {
    if (content === null || !dirtyRef.current) return;
    const timer = setTimeout(() => {
      if (dirtyRef.current) void save(content);
    }, 1500);
    return () => clearTimeout(timer);
  }, [content, save]);

  const meta = useMemo(() => (content === null ? null : docMeta(content)), [content]);

  const openVersions = useCallback(async () => {
    if (!active) return;
    setShowVersions((prev) => !prev);
    if (versions !== null) return;
    try {
      const res = await fetch(
        `/api/agents/versions?id=${encodeURIComponent(agentId)}&path=${encodeURIComponent(active)}`,
        { cache: "no-store" },
      );
      const data = (await res.json().catch(() => ({}))) as { versions?: Version[] };
      setVersions(Array.isArray(data.versions) ? data.versions : []);
    } catch {
      setVersions([]);
    }
  }, [active, agentId, versions]);

  const restore = useCallback(
    async (name: string) => {
      if (!active) return;
      setState({ kind: "saving" });
      try {
        const res = await fetch("/api/agents/versions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: agentId, path: active, name, revision }),
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          setState({ kind: "error", message: data.error ?? `HTTP ${res.status}` });
          return;
        }
        setShowVersions(false);
        setVersions(null);
        await load(active);
        setState({ kind: "saved" });
      } catch (error) {
        setState({ kind: "error", message: String(error) });
      }
    },
    [active, agentId, load, revision],
  );

  /** 点缺口 → 定位到正文里那句话（textarea 的 setSelectionRange 会把它滚进视野）。 */
  const jumpTo = useCallback(
    (gap: string) => {
      const el = textarea.current;
      if (!el || content === null) return;
      const index = content.indexOf(gap);
      if (index < 0) return;
      el.focus();
      el.setSelectionRange(index, index + gap.length);
      setSelection({ start: index, end: index + gap.length, text: gap });
    },
    [content],
  );

  if (files.length === 0) {
    return <div className="px-6 py-8 text-[12px] text-dim">这个目录里还没有 .md 文件。</div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 文件 + 历史 */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line-soft px-6 py-2">
        {files.map((file) => (
          <button
            key={file.path}
            type="button"
            className={cn("btn btn-sm", active === file.path ? "btn-primary" : "btn-subtle")}
            onClick={() => {
              if (dirtyRef.current && content !== null) void save(content);
              void load(file.path);
            }}
          >
            {file.name.replace(/\.md$/i, "")}
          </button>
        ))}
        <button type="button" className="btn btn-sm btn-ghost ml-auto" onClick={openVersions}>
          历史{versions && versions.length > 0 ? ` ${versions.length}` : ""}
        </button>
      </div>

      {showVersions && (
        <div className="shrink-0 border-b border-line-soft bg-panel-2 px-6 py-2">
          {versions === null ? (
            <div className="text-[11px] text-dim">读取历史版本…</div>
          ) : versions.length === 0 ? (
            <div className="text-[11px] text-dim">还没有历史版本 —— 你（或 Agent）保存过一次之后，这里会出现可回到的时间点。</div>
          ) : (
            <ul className="flex flex-col gap-1">
              {versions.slice(0, 8).map((version) => (
                <li key={version.name} className="flex items-center gap-2 text-[11px]">
                  <span className="text-fg">{new Date(version.savedAt).toLocaleString("zh-CN", { hour12: false })}</span>
                  <span className="text-dim">{Math.round(version.size / 1024) || 1}KB</span>
                  <button
                    type="button"
                    className="btn btn-sm btn-subtle ml-auto"
                    disabled={state.kind === "saving"}
                    onClick={() => void restore(version.name)}
                  >
                    回到这版
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* 缺口：可点，跳到正文那一句 */}
      {content !== null && meta && meta.gaps.length > 0 && (
        <div className="shrink-0 border-b border-line-soft bg-panel-2 px-6 py-2">
          <div className="text-[10px] tracking-wide text-dim">待你补（{meta.gaps.length}，点一下跳到正文）</div>
          <ul className="mt-1 flex flex-col gap-0.5">
            {meta.gaps.slice(0, 4).map((gap) => (
              <li key={gap}>
                <button
                  type="button"
                  className="w-full truncate rounded-sm px-1 py-0.5 text-left text-[11px] text-warn t-fast hover:bg-hover"
                  title={gap}
                  onClick={() => jumpTo(gap)}
                >
                  · {gap}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 选中即操作：不用把文字搬去输入框 */}
      {selection && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-line-soft bg-accent-soft px-6 py-1.5">
          <span className="text-[11px] text-accent">选中 {selection.text.length} 字</span>
          {QUICK_ACTIONS.map((action) => (
            <button
              key={action.id}
              type="button"
              className="btn btn-sm btn-subtle"
              onClick={() => {
                promptAgent(action.build(selection.text));
                setSelection(null);
              }}
            >
              {action.label}
            </button>
          ))}
          <button type="button" className="btn btn-sm btn-subtle ml-auto" onClick={() => setSelection(null)}>
            取消
          </button>
        </div>
      )}

      {/* 正文 */}
      <div className="min-h-0 flex-1 overflow-auto px-6 py-6">
        {content === null ? (
          <div className="text-[12px] text-dim">{state.kind === "error" ? state.message : "打开一篇开始写。"}</div>
        ) : (
          <textarea
            ref={textarea}
            value={content}
            aria-label="正文"
            spellCheck={false}
            onChange={(event) => {
              setContent(event.target.value);
              dirtyRef.current = true;
              setState({ kind: "dirty" });
            }}
            onSelect={(event) => {
              const el = event.currentTarget;
              const [start, end] = [el.selectionStart, el.selectionEnd];
              setSelection(end > start ? { start, end, text: el.value.slice(start, end) } : null);
            }}
            onBlur={() => {
              if (dirtyRef.current && content !== null) void save(content);
            }}
            className="mx-auto block min-h-full w-full max-w-[34em] resize-none border-0 bg-transparent text-[16px] leading-[1.85] text-fg outline-none"
          />
        )}
      </div>

      {/* 状态条 */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-t border-line px-6 text-[11px] text-dim">
        <span>{meta ? `${meta.words.toLocaleString()} 字` : "—"}</span>
        <span className="h-3 w-px bg-line" />
        <span>{meta && meta.sections.length > 0 ? `${meta.sections.length} 个小节` : "无小节"}</span>
        <span className="ml-auto truncate">
          {state.kind === "saving"
            ? "保存中…"
            : state.kind === "saved"
              ? "已保存"
              : state.kind === "dirty"
                ? "未保存改动（自动保存中）"
                : state.kind === "error"
                  ? state.message
                  : active
                    ? active.split("/").pop()
                    : ""}
        </span>
      </div>
    </div>
  );
}
