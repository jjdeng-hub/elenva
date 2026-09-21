"use client";

import { useEffect } from "react";
import { X } from "lucide-react";

/**
 * 快捷键总览面板：`?` 唤起，`Esc` 关闭。
 *
 * 硬约束：只收录代码里**真实实现**的键位。面板是一种承诺，
 * 列出没实现的键位等于给用户埋坑 —— 改了键位记得同步这里。
 * 对应实现位置：AppShell（Ctrl+K / Ctrl+Alt+N）、ChatView（Ctrl+F / Esc）、
 * ChatInput（Enter / Shift+Enter / Alt+Enter）。
 */

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="shrink-0 rounded-sm border border-line bg-panel-2 px-1.5 py-0.5 font-mono text-[11px] leading-4 text-muted">
      {children}
    </kbd>
  );
}

type Shortcut = { label: string; keys: string[]; note?: string };

const GROUPS: { title: string; items: Shortcut[] }[] = [
  {
    title: "全局",
    items: [
      { label: "聚焦搜索框", keys: ["Ctrl", "K"] },
      { label: "新建会话", keys: ["Ctrl", "Alt", "N"] },
      { label: "快捷键总览", keys: ["?"] },
    ],
  },
  {
    title: "会话内",
    items: [
      { label: "发送消息", keys: ["Enter"] },
      { label: "插入换行", keys: ["Shift", "Enter"] },
      { label: "插话纠偏", keys: ["Enter"], note: "Agent 工作中" },
      { label: "排队跟发", keys: ["Alt", "Enter"], note: "Agent 工作中" },
      { label: "会话内搜索", keys: ["Ctrl", "F"] },
      { label: "关闭浮层 / 退出菜单", keys: ["Esc"] },
    ],
  },
  {
    title: "输入框语法",
    items: [
      { label: "调用命令 / 技能 / 模板", keys: ["/"] },
      { label: "引用文件（fuzzy）", keys: ["@"] },
      { label: "直接执行 shell 命令", keys: ["!"] },
      { label: "执行 shell 且不进上下文", keys: ["!!"] },
    ],
  },
];

export function ShortcutPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-overlay p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="快捷键总览"
        onMouseDown={(e) => e.stopPropagation()}
        className="anim-fade-up w-full max-w-[620px] rounded-card border border-line bg-panel p-6"
      >
        <div className="flex items-center gap-2">
          <h2 className="text-[16px] font-semibold text-fg">快捷键总览</h2>
          <span className="text-[11px] text-dim">按 ? 打开 · Esc 关闭</span>
          <button
            onClick={onClose}
            aria-label="关闭"
            className="ml-auto flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm text-dim t-fast hover:bg-hover hover:text-fg"
          >
            <X size={14} />
          </button>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-x-6 sm:grid-cols-2">
          {GROUPS.map((g) => (
            <div key={g.title} className="min-w-0">
              <div className="mb-1 text-[11px] font-semibold text-accent">{g.title}</div>
              {g.items.map((it) => (
                <div key={it.label} className="flex items-center gap-2 py-1">
                  <span className="min-w-0 flex-1 truncate text-[12px] text-fg">
                    {it.label}
                    {it.note && <span className="ml-1 text-[10px] text-dim">（{it.note}）</span>}
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    {it.keys.map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>

        <div className="mt-4 rounded-lg bg-panel-2 px-3 py-2 text-[11px] leading-relaxed text-dim">
          面板只列出已实现且可用的键位，未实现的快捷键不在此列。
        </div>
      </div>
    </div>
  );
}
