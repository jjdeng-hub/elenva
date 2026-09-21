"use client";

import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/components/lib/utils";

/**
 * 轻量 Popover：内置 outside-click / Esc 关闭。
 * trigger 为 render-prop，children 收到 close() 用于选中后关闭。
 */
export function Popover({
  trigger,
  children,
  align = "right",
  panelClassName,
  containerClassName,
}: {
  trigger: (o: { open: boolean; toggle: () => void }) => React.ReactNode;
  children: (close: () => void) => React.ReactNode;
  align?: "left" | "right";
  panelClassName?: string;
  containerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={cn("relative", containerClassName)} ref={ref}>
      {trigger({ open, toggle: () => setOpen((v) => !v) })}
      {open && (
        <div
          className={cn(
            "absolute z-50 overflow-hidden rounded-card border border-line bg-panel shadow-lg",
            align === "right" ? "right-0" : "left-0",
            panelClassName,
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/** 菜单项（配合 Popover 使用） */
export function MenuItem({
  icon,
  label,
  danger,
  disabled,
  onClick,
}: {
  icon?: React.ReactNode;
  label: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[12px] t-fast hover:bg-hover disabled:cursor-default disabled:opacity-50",
        danger ? "text-danger hover:bg-danger/10" : "text-fg",
      )}
    >
      {icon && <span className={cn(danger ? "" : "text-dim")}>{icon}</span>}
      {label}
    </button>
  );
}

/** 带 X 关闭按钮的标题条（配合 Popover 使用） */
export function PopoverHeader({ label, onClose }: { label: React.ReactNode; onClose?: () => void }) {
  return (
    <div className="flex items-center gap-1.5 border-b border-line-soft px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-dim">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {onClose && (
        <button onClick={onClose} className="cursor-pointer rounded-sm p-0.5 hover:bg-hover hover:text-fg" title="关闭">
          <X size={12} />
        </button>
      )}
    </div>
  );
}
