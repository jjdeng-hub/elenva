"use client";

import { useCallback, useState } from "react";
import { dialogConfirm, toast } from "@/components/ui/dialog";

/**
 * 会话级写操作的单一实现（重命名 / 删除 / 压缩 / 克隆 / 导出 / AI 命名）。
 *
 * 抽出来的原因：这些动作在界面上被重新分布到了多个位置
 * （标题内联重命名、标题旁删除、观测栏压缩与导出、菜单里的克隆），
 * 各自复制一份 fetch + 确认弹窗迟早会出现「某处忘了刷新」或文案不一致。
 */

export interface SessionActions {
  /** 重命名。返回是否成功（内联编辑用它决定要不要退出编辑态） */
  rename: (name: string) => Promise<boolean>;
  remove: () => Promise<void>;
  compact: () => Promise<void>;
  clone: () => Promise<void>;
  exportHtml: () => void;
  autoName: () => Promise<string | null>;
  busy: boolean;
  compacting: boolean;
}

export function useSessionActions({
  sessionId,
  sessionName,
  onRenamed,
  onDeleted,
  onAutoRename,
  onCompact,
  compacting = false,
  onClone,
}: {
  sessionId: string;
  sessionName: string;
  onRenamed: (name: string) => void;
  onDeleted: () => void;
  onAutoRename: () => Promise<string | null>;
  onCompact: () => void | Promise<void>;
  compacting?: boolean;
  onClone: () => void | Promise<void>;
}): SessionActions {
  const [busy, setBusy] = useState(false);

  const rename = useCallback(
    async (name: string): Promise<boolean> => {
      const trimmed = name.trim();
      if (!trimmed || trimmed === sessionName) return true;
      setBusy(true);
      try {
        const res = await fetch(`/api/sessions/${sessionId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: trimmed }),
        });
        if (!res.ok) throw new Error("重命名失败");
        onRenamed(trimmed);
        return true;
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [sessionId, sessionName, onRenamed],
  );

  const remove = useCallback(async () => {
    const ok = await dialogConfirm({
      title: "删除会话",
      message: `确定删除会话「${sessionName}」？此操作不可撤销。`,
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("删除失败");
      onDeleted();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [sessionId, sessionName, onDeleted]);

  const compact = useCallback(async () => {
    setBusy(true);
    try {
      await onCompact();
    } finally {
      setBusy(false);
    }
  }, [onCompact]);

  const clone = useCallback(async () => {
    setBusy(true);
    try {
      await onClone();
    } finally {
      setBusy(false);
    }
  }, [onClone]);

  const exportHtml = useCallback(() => {
    // 新窗口打开导出的 HTML；inline=1 让服务端直接返回页面而不是附件
    window.open(`/api/sessions/${sessionId}/export?inline=1`, "_blank");
  }, [sessionId]);

  const autoName = useCallback(async (): Promise<string | null> => {
    setBusy(true);
    try {
      const title = await onAutoRename();
      if (!title) toast("AI 命名失败，请稍后重试");
      return title;
    } finally {
      setBusy(false);
    }
  }, [onAutoRename]);

  return { rename, remove, compact, clone, exportHtml, autoName, busy, compacting };
}
