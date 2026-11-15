"use client";

import { AlertTriangle, Loader2, X } from "lucide-react";
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
  /**
   * prompt 模式：允许「空串」作为一个有效结果。
   *
   * 默认（不传）下，trim 后为空会返回 null —— 与「取消」不可区分。对「改名 / 存模板」
   * 这类场景这没问题（空名字本就不合法），但「清空标签」需要区分「清空」与「取消」：
   * 因此打开此开关后，确定与回车两条路径都返回 trim 后的字符串（含 ""），取消仍是 null。
   */
  allowEmpty?: boolean;
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

/** 打开新框前记下触发元素，关闭时把焦点还回去（M11） */
let dialogTrigger: HTMLElement | null = null;
function rememberTrigger() {
  dialogTrigger = typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null);
}

export function dialogConfirm(opts: DialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    // 明确口径：同一时刻只保留一个确认框；新框覆盖时，上一个未决框按「取消」结算
    // （返回 false/null），绝不当作确认，避免危险操作被静默放行。
    dialogState?.resolve(null);
    rememberTrigger();
    dialogState = { ...opts, mode: "confirm", resolve: (v) => resolve(Boolean(v)) };
    emit();
  });
}

export function dialogPrompt(opts: DialogOptions): Promise<string | null> {
  return new Promise((resolve) => {
    dialogState?.resolve(null);
    rememberTrigger();
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
    // M11：关闭后把焦点归还给打开对话框的触发元素
    const trigger = dialogTrigger;
    dialogTrigger = null;
    if (trigger?.isConnected) trigger.focus();
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
        if (e.key === "Escape") {
          close(null);
          return;
        }
        // M11：删掉遮罩层「Enter 无条件确认」——焦点停在「取消」时按 Enter 会先被
        // 这里当成确认、随后按钮自身的 close(null) 又因状态已清空而失效，键盘无法取消。
        // 现在 confirm 的回车由各按钮自己的 click 决定结果（prompt 输入框已 stopPropagation）。
        if (e.key !== "Tab") return;
        // Tab 焦点陷阱：焦点只在对话框内的可聚焦项之间循环，不跑出 aria-modal 容器
        const root = e.currentTarget.querySelector<HTMLElement>('[role="dialog"]');
        if (!root) return;
        const items = Array.from(
          root.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        );
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !root.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !root.contains(active))) {
          e.preventDefault();
          first.focus();
        }
      }}
    >
      <div className="w-full max-w-sm rounded-card border border-line bg-panel p-5 shadow-lg anim-fade-up" role="dialog" aria-modal aria-labelledby="elenva-dialog-title">
        <div className="flex items-start gap-2.5">
          {d.danger && (
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-danger/10 text-danger">
              <AlertTriangle size={14} />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h3 id="elenva-dialog-title" className="text-[14px] font-semibold text-fg">{d.title}</h3>
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
                const value = (e.target as HTMLInputElement).value.trim();
                close(d.allowEmpty ? value : value || null);
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
            onClick={() => {
              if (d.mode !== "prompt") return close(true);
              const value = inputRef.current?.value.trim() ?? "";
              close(d.allowEmpty ? value : value || null);
            }}
            className={cn(
              "h-8 cursor-pointer rounded-lg px-3.5 text-[12px] font-semibold text-accent-fg transition-opacity hover:opacity-90",
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

export type ToastType = "success" | "error" | "warning";

type ToastItem = {
  id: number;
  text: string;
  type: ToastType;
  /** 0 = 常驻，不自动消失 */
  duration: number;
  action?: { label: string; onClick: () => void };
};
type ToastOptions = {
  type?: ToastType;
  /** 毫秒；错误默认常驻（0） */
  duration?: number;
  /** 可点动作（如「重试」），点击后执行并关闭该 toast */
  action?: { label: string; onClick: () => void };
};

let toasts: ToastItem[] = [];
const toastListeners = new Set<() => void>();
let toastSeq = 0;

function emitToast() {
  toastListeners.forEach((l) => l());
}

function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emitToast();
}

/**
 * 轻提示（M12）。第二参数兼容旧的「直接传毫秒」写法 `toast(text, 6000)`；
 * 也可传对象标记类型与动作：
 *   toast("保存失败", { type: "error", action: { label: "重试", onClick: retry } })
 * 错误默认常驻（不会 3s 消失），成功/警告仍 3s。
 */
function showToast(text: string, opts?: number | ToastOptions) {
  const o: ToastOptions = typeof opts === "number" ? { duration: opts } : (opts ?? {});
  const type = o.type ?? "success";
  const duration = o.duration ?? (type === "error" ? 0 : 3000);
  const id = ++toastSeq;
  toasts = [...toasts, { id, text, type, duration, action: o.action }];
  emitToast();
}

/** 便捷入口：供调用点显式标注错误 / 警告类型 */
export const toast = Object.assign(showToast, {
  error: (text: string, action?: ToastOptions["action"]) => showToast(text, { type: "error", action }),
  warning: (text: string, action?: ToastOptions["action"]) => showToast(text, { type: "warning", action }),
});

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
    // 容器自身不拦截点击，只有 toast 卡片允许 pointer-events（放关闭 / 重试按钮）；
    // role=status + aria-live=polite 让读屏主动播报，错误项再用 role=alert 升级为即时播报。
    <div
      className="pointer-events-none fixed bottom-14 left-1/2 z-[150] flex -translate-x-1/2 flex-col items-center gap-2"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} item={t} />
      ))}
    </div>
  );
}

function ToastCard({ item }: { item: ToastItem }) {
  const [paused, setPaused] = useState(false);
  // hover 暂停计时：鼠标移入清掉定时器，移出后重新计时
  useEffect(() => {
    if (item.duration <= 0 || paused) return;
    const timer = setTimeout(() => dismissToast(item.id), item.duration);
    return () => clearTimeout(timer);
  }, [item.id, item.duration, paused]);

  return (
    <div
      role={item.type === "error" ? "alert" : undefined}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className={cn(
        "anim-fade-up pointer-events-auto flex items-center gap-3 rounded-card border px-4 py-2 text-[12px] shadow-lg",
        item.type === "error"
          ? "border-danger/40 bg-panel text-danger"
          : item.type === "warning"
            ? "border-warn/40 bg-panel text-warn"
            : "border-line bg-panel text-fg",
      )}
    >
      <span className="min-w-0 flex-1">{item.text}</span>
      {item.action && (
        <button
          onClick={() => {
            item.action?.onClick();
            dismissToast(item.id);
          }}
          className="shrink-0 cursor-pointer rounded-sm px-1.5 py-0.5 text-[11px] font-semibold underline underline-offset-2 hover:opacity-80"
        >
          {item.action.label}
        </button>
      )}
      <button
        onClick={() => dismissToast(item.id)}
        aria-label="关闭提示"
        className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-dim hover:bg-hover hover:text-fg"
      >
        <X size={12} />
      </button>
    </div>
  );
}

/**
 * 业务弹层共享的对话框行为（M11）：Esc 关闭、Tab 焦点陷阱、关闭时把焦点归还触发元素。
 * panelRef 指向弹层自身的 role="dialog" 容器，避免多层弹叠加时抓错边界。
 */
export function useDialogBehavior(
  open: boolean,
  onClose: () => void,
  panelRef: { current: HTMLElement | null },
) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const trigger = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // 有更高层对话框（如全局确认框）打开、且焦点不在本弹层内时，把 Esc 让给它，
        // 不误关底层弹层。
        const others = Array.from(
          document.querySelectorAll('[role="dialog"][aria-modal="true"]'),
        ).filter((el) => el !== panelRef.current);
        if (others.length > 0 && !panelRef.current?.contains(document.activeElement)) return;
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = panelRef.current.contains(active);
      if (e.shiftKey && (active === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (trigger?.isConnected) trigger.focus();
    };
  }, [open, panelRef]);
}

/** 内联 spinner（按钮/标题内使用） */
export function InlineSpinner({ className }: { className?: string }) {
  return <Loader2 size={12} className={cn("anim-spin", className)} />;
}
