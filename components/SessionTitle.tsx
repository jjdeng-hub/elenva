"use client";

import { Check, Pencil, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/components/lib/utils";
import type { SessionActions } from "@/hooks/useSessionActions";

/**
 * 会话标题：点一下即可内联重命名。
 *
 * 为什么不再用「菜单 → 重命名 → 弹窗」：标题就在眼前，改名字应该就地发生。
 * 「重命名 / AI 命名 / 删除」三者都是「给这个会话定身份或销毁它」，
 * 放在标题旁形成一组，比埋在「…」里更好找（也是用户提出的方案）。
 */
export function SessionTitle({
  cwdName,
  title,
  actions,
  /** 新会话还没落盘，不能重命名/删除 */
  editable = true,
}: {
  cwdName: string;
  title: string;
  actions: SessionActions;
  editable?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editing) setDraft(title);
  }, [title, editing]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = async () => {
    const ok = await actions.rename(draft);
    setEditing(ok ? false : true);
    if (!ok) inputRef.current?.focus();
  };

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] font-medium">
      {cwdName && <span className="shrink-0 text-muted">{cwdName}</span>}
      <span className="shrink-0 text-dim/50">/</span>

      {editing ? (
        <span className="flex min-w-0 items-center gap-1">
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void commit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
              }
            }}
            onBlur={() => void commit()}
            data-testid="session-title-input"
            className="h-6 min-w-0 flex-1 rounded-sm border border-accent/50 bg-panel-2 px-1.5 text-[13px] text-fg outline-none"
          />
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void commit()}
            title="保存（Enter）"
            aria-label="保存标题"
            className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm text-success t-fast hover:bg-hover"
          >
            <Check size={12} />
          </button>
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setEditing(false)}
            title="取消（Esc）"
            aria-label="取消重命名"
            className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm text-dim t-fast hover:bg-hover hover:text-fg"
          >
            <X size={12} />
          </button>
        </span>
      ) : (
        <>
          <button
            onClick={() => editable && setEditing(true)}
            disabled={!editable}
            title={editable ? "点击重命名" : undefined}
            data-testid="session-title"
            className={cn(
              "min-w-0 truncate rounded-sm px-1 py-0.5 text-left t-fast",
              editable ? "cursor-text hover:bg-hover" : "cursor-default",
            )}
          >
            {title}
          </button>
          {/* 标题旁的操作：常显但低对比 —— 悬停才出现的入口等于不存在（实测反馈「没看到」）。
              自动命名已移除：首轮对话结束会自动命名，不满意直接改名更直接；
              需要重跑模型命名时仍可用 /name 命令。 */}
          {editable && (
            <span className="flex shrink-0 items-center gap-0.5">
              <button
                onClick={() => setEditing(true)}
                title="重命名"
                aria-label="重命名"
                className="flex size-6 cursor-pointer items-center justify-center rounded-sm text-dim/60 t-fast hover:bg-hover hover:text-fg"
              >
                <Pencil size={12} />
              </button>
              <button
                onClick={() => void actions.remove()}
                disabled={actions.busy}
                title="删除会话"
                aria-label="删除会话"
                className="flex size-6 cursor-pointer items-center justify-center rounded-sm text-dim/60 t-fast hover:bg-danger/10 hover:text-danger disabled:opacity-50"
              >
                <Trash2 size={12} />
              </button>
            </span>
          )}
        </>
      )}
    </div>
  );
}
