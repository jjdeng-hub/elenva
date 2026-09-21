"use client";

import { Check, ChevronDown, Folder, FolderOpen, Home } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/components/lib/utils";

export interface WorkspaceOption {
  /** 显示名（目录 basename，重名由调用方消歧） */
  name: string;
  /** 绝对路径 */
  path: string;
}

/**
 * 新会话的工作区选择器（仅空态新会话显示）。
 * 不选择则落默认工作区；选择后首条消息发送时才真正创建会话。
 */
export function WorkspacePicker({
  picked,
  defaultCwd,
  recent,
  onPick,
  onOpenFolder,
}: {
  /** 用户显式选择的工作区（null = 未选择，跟随默认） */
  picked: string | null;
  /** 默认工作区路径（null 时隐藏「默认工作区」项） */
  defaultCwd: string | null;
  /** 最近的工作区（来自已有会话聚合） */
  recent: WorkspaceOption[];
  onPick: (cwd: string | null) => void;
  /** 打开本地文件夹（目录选择器） */
  onOpenFolder: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const pickedName = picked ? picked.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || picked : null;
  const label = pickedName || "默认工作区";

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        title={picked || defaultCwd || "选择会话的工作区"}
        className="flex h-7 max-w-72 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[12px] text-muted t-fast hover:bg-hover hover:text-fg"
      >
        <Folder size={12} className="shrink-0 text-dim" />
        <span className="shrink-0 text-[11px] text-dim">工作区</span>
        <span className={cn("truncate", pickedName && "text-fg/85")}>{label}</span>
        <ChevronDown size={12} className={cn("shrink-0 text-dim transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="absolute left-1/2 top-full z-50 mt-1.5 w-80 -translate-x-1/2 overflow-hidden rounded-card border border-line bg-panel shadow-lg">
          {/* 默认工作区 */}
          {defaultCwd && (
            <button
              onClick={() => {
                onPick(null);
                setOpen(false);
              }}
              className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left t-fast hover:bg-hover"
            >
              <Home size={14} className="shrink-0 text-dim" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] text-fg">默认工作区</span>
                <span className="block truncate text-[11px] text-dim" title={defaultCwd}>
                  {defaultCwd}
                </span>
              </span>
              {!picked && <Check size={14} className="shrink-0 text-accent" />}
            </button>
          )}

          {/* 最近工作区 */}
          {recent.length > 0 && (
            <div className="max-h-56 overflow-y-auto border-t border-line-soft py-1">
              <div className="px-3 pb-0.5 pt-1 text-[11px] text-dim">最近</div>
              {recent.map((w) => (
                <button
                  key={w.path}
                  onClick={() => {
                    onPick(w.path);
                    setOpen(false);
                  }}
                  title={w.path}
                  className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left t-fast hover:bg-hover"
                >
                  <Folder size={14} className="shrink-0 text-dim" />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-fg/90">{w.name}</span>
                  {picked === w.path && <Check size={14} className="shrink-0 text-accent" />}
                </button>
              ))}
            </div>
          )}

          {/* 打开本地文件夹 */}
          <button
            onClick={() => {
              setOpen(false);
              onOpenFolder();
            }}
            className="flex w-full cursor-pointer items-center gap-2 border-t border-line-soft px-3 py-2 text-left t-fast hover:bg-hover"
          >
            <FolderOpen size={14} className="shrink-0 text-dim" />
            <span className="text-[12px] text-fg/90">打开本地文件夹…</span>
          </button>

          <div className="border-t border-line-soft px-3 py-1.5 text-[11px] text-dim/80">
            发送首条消息时生效；不选择则使用默认工作区
          </div>
        </div>
      )}
    </div>
  );
}
