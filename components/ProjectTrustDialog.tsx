"use client";

import { FolderOpen, ShieldCheck } from "lucide-react";
import { useState } from "react";

/**
 * 项目信任对话框（对应 Pi 的 project-trust 机制）：
 * 项目包含 .pi/extensions、项目级 .pi/settings.json 扩展条目或 .agents/skills 时，
 * 必须明确信任后 Pi 才会加载并执行这些项目资源——否则会静默失效。
 */
export function ProjectTrustDialog({
  cwd,
  onConfirm,
  onCancel,
}: {
  cwd: string;
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-overlay p-4"
      onClick={(e) => {
        if (!busy && e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="w-[460px] max-w-full overflow-hidden rounded-card border border-line bg-panel shadow-lg"
        data-testid="trust-dialog"
      >
        <div className="flex gap-3 p-5 pb-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-card bg-warn/15 text-warn">
            <ShieldCheck size={16} />
          </div>
          <div className="min-w-0">
            <div className="text-[14px] font-bold text-fg">信任此项目？</div>
            <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
              该项目包含需要信任的 Pi 资源（扩展、项目级设置或技能）。信任后 Pi
              将加载并执行这些<strong className="text-fg">本项目内的代码</strong>
              ；不信任则它们保持休眠（扩展功能会静默失效）。
            </p>
            <code className="mt-2.5 flex items-center gap-1.5 overflow-hidden rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 font-mono text-[11px] text-muted">
              <FolderOpen size={12} className="shrink-0 text-dim" />
              <span className="truncate">{cwd}</span>
            </code>
            {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-line-soft bg-panel-2/60 px-5 py-3">
          <button
            onClick={onCancel}
            disabled={busy}
            className="h-8 cursor-pointer rounded-lg border border-line bg-panel px-3 text-[12px] text-muted t-fast hover:text-fg disabled:opacity-50"
          >
            不信任，返回
          </button>
          <button
            onClick={() => void confirm()}
            disabled={busy}
            data-testid="trust-confirm"
            className="h-8 cursor-pointer rounded-lg bg-accent px-3.5 text-[12px] font-medium text-accent-fg t-fast hover:bg-accent-hover disabled:opacity-60"
          >
            {busy ? "处理中…" : "信任并继续"}
          </button>
        </div>
      </div>
    </div>
  );
}
