"use client";

import { useCallback, useEffect, useState } from "react";
import { dialogConfirm, toast } from "@/components/ui/dialog";

/**
 * 「本轮」数据的唯一来源。
 *
 * 同一份快照要喂两个地方：输入框上方的一行状态（窄屏 / 观测栏关着时的入口）
 * 和右侧观测栏的明细列表。分别 fetch 会导致两处数字不一致（一个刷新了、
 * 另一个还是上一轮），所以在这里拉一次、两处共用。
 */

export interface TurnFile {
  path: string;
  tool: string;
  existed: boolean;
  restorable: boolean;
  skippedReason: string | null;
  bytes: number | null;
}

export interface TurnCommand {
  command: string;
  /** null = 没拿到结果（被拦下或仍在跑） */
  failed: boolean | null;
}

export interface TurnCheckpoint {
  id: string;
  turnIndex: number;
  createdAt: string;
  closedAt: string | null;
  status: string;
  cwd: string;
  fileCount: number;
  restorableCount: number;
  commands: TurnCommand[];
  files: TurnFile[];
}

export interface TurnCheckpointsState {
  /** 最新的在最前 */
  checkpoints: TurnCheckpoint[];
  /** 最近一轮 */
  latest: TurnCheckpoint | null;
  restoring: boolean;
  restore: (turnId?: string) => Promise<void>;
  reload: () => void;
}

export function useTurnCheckpoints(
  sessionId: string | null,
  refreshKey: number,
): TurnCheckpointsState {
  const [checkpoints, setCheckpoints] = useState<TurnCheckpoint[]>([]);
  const [restoring, setRestoring] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async (sid: string) => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}/checkpoints`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { checkpoints?: TurnCheckpoint[] };
      setCheckpoints(Array.isArray(data.checkpoints) ? data.checkpoints : []);
    } catch {
      /* 拿不到就不显示，不打扰 */
    }
  }, []);

  useEffect(() => {
    if (!sessionId) {
      setCheckpoints([]);
      return;
    }
    void load(sessionId);
  }, [sessionId, refreshKey, reloadKey, load]);

  const restore = useCallback(async (turnId?: string) => {
    const target = turnId ?? checkpoints[0]?.id;
    if (!sessionId || !target) return;
    const checkpoint = checkpoints.find((item) => item.id === target);
    if (!checkpoint) return;

    const shellWarning = checkpoint.commands.length > 0
      ? `\n\n注意：本轮还执行过 ${checkpoint.commands.length} 条命令，命令的副作用（生成物、安装、提交）不在回滚范围内。`
      : "";
    const ok = await dialogConfirm({
      title: "回滚本轮改动",
      message: `将还原本轮写入的 ${checkpoint.fileCount} 个文件（其中 ${checkpoint.restorableCount} 个可还原）。`
        + `本轮新建的文件会被删除，改动过的文件恢复原内容。${shellWarning}`,
      confirmText: "回滚",
      danger: true,
    });
    if (!ok) return;

    setRestoring(true);
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/checkpoints/restore`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ turnId: target }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        restored?: string[];
        deleted?: string[];
        skipped?: Array<{ path: string; reason: string }>;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || `回滚失败（HTTP ${res.status}）`);
      const parts = [`已还原 ${data.restored?.length ?? 0} 个文件`];
      if (data.deleted?.length) parts.push(`删除 ${data.deleted.length} 个新建文件`);
      if (data.skipped?.length) parts.push(`${data.skipped.length} 个跳过`);
      toast(parts.join("，"));
      for (const item of (data.skipped ?? []).slice(0, 2)) {
        if (item.path) toast(`跳过 ${item.path}：${item.reason}`);
      }
      await load(sessionId);
    } catch (error) {
      toast(error instanceof Error ? error.message : "回滚失败");
    } finally {
      setRestoring(false);
    }
  }, [sessionId, checkpoints, load]);

  return {
    checkpoints,
    latest: checkpoints[0] ?? null,
    restoring,
    restore,
    reload: () => setReloadKey((value) => value + 1),
  };
}
