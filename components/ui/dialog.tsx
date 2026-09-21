"use client";

import { AlertTriangle, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/components/lib/utils";

/* ================= 全局对话框（替换 window.confirm / window.prompt） ================= */

type DialogOptions = {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  /** prompt 模式：输入框默认值 */
  defaultValue?: string;
  placeholder?: string;
  /** prompt 模式：自动聚焦选中默认值 */
  select?: boolean;
};

type DialogState = DialogOptions & {
  mode: "confirm" | "prompt";
  resolve: (v: boolean | string | null) => void;
};

let dialogState: DialogState | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function dialogConfirm(opts: DialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    dialogState?.resolve(null); // 取消上一个未决对话框
    dialogState = { ...opts, mode: "confirm", resolve: (v) => resolve(Boolean(v)) };
    emit();
  });
}

export function dialogPrompt(opts: DialogOptions): Promise<string | null> {
  return new Promise((resolve) => {
    dialogState?.resolve(null);
    dialogState = { ...opts, mode: "prompt", resolve: (v) => resolve(typeof v === "string" ? v : null) };
    emit();
  });
}

export function DialogHost() {
  const [, force] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const okRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);

  useEffect(() => {
    if (!dialogState) return;
    if (dialogState.mode === "prompt") {
      const el = inputRef.current;
      if (el) {
        el.focus();
        if (dialogState.select && dialogState.defaultValue) el.select();
      }
    } else {
      // confirm 默认聚焦「确定」
      okRef.current?.focus();
    }
  });

  const close = (v: boolean | string | null) => {
    dialogState?.resolve(v);
    dialogState = null;
    emit();
  };

  if (!dialogState) return null;
  const d = dialogState;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-overlay p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close(null);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") close(null);
        if (e.key === "Enter" && d.mode === "confirm") close(true);
      }}
    >
      <div className="w-full max-w-sm rounded-card border border-line bg-panel p-5 shadow-lg anim-fade-up" role="dialog" aria-modal>
        <div className="flex items-start gap-2.5">
          {d.danger && (
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-danger/10 text-danger">
              <AlertTriangle size={14} />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h3 className="text-[14px] font-semibold text-fg">{d.title}</h3>
            {/* whitespace-pre-line：确认文案允许带换行（如列出待提交文件清单），
                普通单行文案不受影响。 */}
            {d.message && (
              <p className="mt-1 whitespace-pre-line text-[12px] leading-relaxed text-muted">{d.message}</p>
            )}
          </div>
        </div>

        {d.mode === "prompt" && (
          <input
            ref={inputRef}
            defaultValue={d.defaultValue ?? ""}
            placeholder={d.placeholder}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.stopPropagation();
                close((e.target as HTMLInputElement).value.trim() || null);
              }
            }}
            className="mt-3.5 h-9 w-full rounded-lg border border-line bg-panel-2 px-3 text-[13px] text-fg outline-none focus:border-accent/60"
          />
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={() => close(null)}
            className="h-8 cursor-pointer rounded-lg border border-line bg-panel-2 px-3.5 text-[12px] text-muted t-fast hover:text-fg"
          >
            {d.cancelText ?? "取消"}
          </button>
          <button
            ref={okRef}
            onClick={() => close(d.mode === "prompt" ? (inputRef.current?.value.trim() || null) : true)}
            className={cn(
              "h-8 cursor-pointer rounded-lg px-3.5 text-[12px] font-semibold text-white transition-opacity hover:opacity-90",
              d.danger ? "bg-danger" : "bg-accent",
            )}
          >
            {d.confirmText ?? "确定"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ================= 全局 Toast ================= */

type ToastItem = { id: number; text: string };
let toasts: ToastItem[] = [];
const toastListeners = new Set<() => void>();
let toastSeq = 0;

export function toast(text: string, duration = 3000) {
  const id = ++toastSeq;
  toasts = [...toasts, { id, text }];
  toastListeners.forEach((l) => l());
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    toastListeners.forEach((l) => l());
  }, duration);
}

export function ToastHost() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    toastListeners.add(l);
    return () => {
      toastListeners.delete(l);
    };
  }, []);

  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-14 left-1/2 z-[150] flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="anim-fade-up rounded-card border border-line bg-panel px-4 py-2 text-[12px] text-fg shadow-lg"
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}

/** 内联 spinner（按钮/标题内使用） */
export function InlineSpinner({ className }: { className?: string }) {
  return <Loader2 size={12} className={cn("anim-spin", className)} />;
}
