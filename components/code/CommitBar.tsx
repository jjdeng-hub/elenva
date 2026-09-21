"use client";

import { Check, Loader2, Sparkles, Undo2, Upload } from "lucide-react";
import { useState } from "react";
import { dialogConfirm, toast } from "@/components/ui/dialog";
import type { GitStatusResponse } from "@/lib/git-types";

/**
 * 提交条（横向，常驻底部）。
 *
 * 与之前的 GitCommitPanel 的关键差别：**文件勾选来自左侧文件树**，这里不再重复
 * 列一份文件清单。勾哪几个文件是「看树」时决定的事，不该在两个地方各选一次。
 */
export function CommitBar({
  cwd,
  status,
  selected,
  onSelectedChange,
  onCommitted,
}: {
  cwd: string;
  status: GitStatusResponse | null;
  /** 选中提交的**绝对路径**集合（来自文件树） */
  selected: Set<string>;
  onSelectedChange: (next: Set<string>) => void;
  onCommitted: () => void;
}) {
  const files = status?.files ?? [];
  const [message, setMessage] = useState("");
  const [generating, setGenerating] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [lastCommit, setLastCommit] = useState<{ shortHash: string; subject: string } | null>(null);

  const selectedPaths = files.filter((f) => selected.has(f.filePath)).map((f) => f.filePath);
  const allSelected = files.length > 0 && selectedPaths.length === files.length;

  const relTo = (p: string) => {
    const root = status?.repositoryRoot;
    if (!root) return p;
    const toSlashes = (v: string) => v.split("\\").join("/");
    const prefix = `${toSlashes(root).replace(/\/+$/, "").toLowerCase()}/`;
    const cleaned = toSlashes(p);
    return cleaned.toLowerCase().startsWith(prefix) ? cleaned.slice(prefix.length) : cleaned;
  };

  const generate = async () => {
    if (selectedPaths.length === 0) return;
    setGenerating(true);
    try {
      const res = await fetch("/api/git/commit-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, files: selectedPaths }),
      });
      const d = (await res.json()) as { message?: string | null; error?: string };
      if (!res.ok) throw new Error(d.error || `生成失败（HTTP ${res.status}）`);
      if (!d.message) {
        toast("模型没能生成提交信息，请手动填写");
        return;
      }
      setMessage(d.message);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  };

  const commit = async () => {
    if (selectedPaths.length === 0 || !message.trim()) return;
    const ok = await dialogConfirm({
      title: "提交变更",
      message:
        `将提交 ${selectedPaths.length} 个文件：\n`
        + selectedPaths.slice(0, 8).map((p) => `· ${relTo(p)}`).join("\n")
        + (selectedPaths.length > 8 ? `\n…另有 ${selectedPaths.length - 8} 个` : "")
        + `\n\n提交信息：${message.trim()}`,
      confirmText: "提交",
    });
    if (!ok) return;

    setCommitting(true);
    try {
      const res = await fetch("/api/git/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, files: selectedPaths, message: message.trim() }),
      });
      const d = (await res.json()) as { shortHash?: string; subject?: string; error?: string };
      if (!res.ok) throw new Error(d.error || `提交失败（HTTP ${res.status}）`);
      toast(`已提交 ${d.shortHash}：${d.subject}`);
      setLastCommit({ shortHash: d.shortHash ?? "", subject: d.subject ?? "" });
      setMessage("");
      onSelectedChange(new Set());
      onCommitted();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setCommitting(false);
    }
  };

  const undo = async () => {
    const ok = await dialogConfirm({
      title: "撤销最近一次提交",
      message: "将执行 git reset --soft HEAD~1：只回退提交记录，改动全部留在工作区，不会丢文件。",
      confirmText: "撤销提交",
      danger: true,
    });
    if (!ok) return;
    setUndoing(true);
    try {
      const res = await fetch("/api/git/undo-commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd }),
      });
      const d = (await res.json()) as { previousSubject?: string; error?: string };
      if (!res.ok) throw new Error(d.error || `撤销失败（HTTP ${res.status}）`);
      toast(`已撤销提交「${d.previousSubject ?? ""}」，改动仍在`);
      setLastCommit(null);
      onCommitted();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setUndoing(false);
    }
  };

  if (!status?.isGitRepository) return null;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line bg-panel px-4 py-2.5" data-testid="commit-bar">
      <Upload size={14} className="shrink-0 text-accent" />
      <span className="shrink-0 text-[12px] text-dim">
        已选 <b className="tabular-nums text-fg">{selectedPaths.length}</b> / {files.length}
      </span>
      <button
        onClick={() =>
          onSelectedChange(allSelected ? new Set() : new Set(files.map((f) => f.filePath)))
        }
        disabled={files.length === 0}
        className="btn btn-sm btn-subtle shrink-0"
      >
        {allSelected ? "全不选" : "全选"}
      </button>

      <input
        value={message}
        onChange={(e) => setMessage(e.target.value.slice(0, 200))}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) void commit();
        }}
        placeholder="提交信息（一句话说明这次改了什么）"
        data-testid="commit-message"
        className="h-8 min-w-[220px] flex-1 rounded-md border border-line bg-panel-2 px-2.5 text-[12px] text-fg outline-none focus:border-accent/60"
      />
      <button
        onClick={() => void generate()}
        disabled={generating || selectedPaths.length === 0}
        data-testid="generate-message"
        className="btn btn-sm btn-ghost shrink-0"
        title="让模型读一遍改动，给一条提交信息建议（可再改）"
      >
        {generating ? <Loader2 size={10} className="anim-spin" /> : <Sparkles size={10} />} 生成信息
      </button>
      <button
        onClick={() => void commit()}
        disabled={committing || selectedPaths.length === 0 || !message.trim()}
        data-testid="do-commit"
        className="btn btn-primary shrink-0"
      >
        {committing ? <Loader2 size={12} className="anim-spin" /> : <Check size={12} />}
        提交{selectedPaths.length > 0 ? ` ${selectedPaths.length} 个` : ""}
      </button>
      <button
        onClick={() => void undo()}
        disabled={undoing}
        data-testid="undo-commit"
        title="撤销最近一次提交（reset --soft，改动不丢）"
        className="btn btn-sm btn-ghost shrink-0"
      >
        {undoing ? <Loader2 size={10} className="anim-spin" /> : <Undo2 size={10} />} 撤销上次
      </button>

      {lastCommit?.shortHash && (
        <span className="flex w-full items-center gap-2 border-t border-line-soft pt-1.5 text-[11px] text-success">
          <Check size={10} className="shrink-0" />
          已提交 <span className="font-mono">{lastCommit.shortHash}</span>
          <span className="min-w-0 flex-1 truncate text-muted">{lastCommit.subject}</span>
        </span>
      )}
    </div>
  );
}
