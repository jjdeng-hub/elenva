"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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

export interface TurnRound {
  /** 本轮的子轮次，新 → 旧（内核的 turn 是「一次 LLM 往返」，一轮用户消息常含多个） */
  checkpoints: TurnCheckpoint[];
  /** 合并去重后的文件：同一文件被多个子轮次改动只出现一次，保留最早一次的语义 */
  files: TurnFile[];
  /** 按时间顺序合并的命令 */
  commands: TurnCommand[];
  fileCount: number;
  createdCount: number;
  restorableCount: number;
}

export interface TurnCheckpointsState {
  /** 最新的在最前 */
  checkpoints: TurnCheckpoint[];
  /** 最近一轮：已把「子轮次」合并成用户轮（见 mergeRound） */
  latestRound: TurnRound | null;
  restoring: boolean;
  restore: (turnId?: string) => Promise<void>;
  reload: () => void;
}

/**
 * 把「子轮次」聚合成「用户轮」。
 *
 * 内核的 turn = 一次 LLM 往返（一次工具调用就是一轮），一轮用户消息通常包含多个
 * 子轮次，且**终答子轮次几乎没有文件/命令** —— 只取最后一个子轮次会让「本轮」在
 * 真实工作轮里几乎永远显示为空。turnIndex 每轮用户消息从 0 重新开始，用它做分界：
 * 从最新往回收集，直到（含）第一个 turnIndex === 0 的子轮次。
 */
export function mergeRound(checkpoints: readonly TurnCheckpoint[]): TurnRound | null {
  if (checkpoints.length === 0) return null;
  const round: TurnCheckpoint[] = [];
  for (const checkpoint of checkpoints) {
    round.push(checkpoint);
    if (checkpoint.turnIndex === 0) break;
  }
  // 旧 → 新遍历，每个路径保留第一次出现（即最早一次触碰）的 existed/restorable
  const filesByPath = new Map<string, TurnFile>();
  const commands: TurnCommand[] = [];
  for (let i = round.length - 1; i >= 0; i--) {
    for (const file of round[i].files) {
      if (!filesByPath.has(file.path)) filesByPath.set(file.path, file);
    }
    commands.push(...round[i].commands);
  }
  const files = [...filesByPath.values()];
  return {
    checkpoints: round,
    files,
    commands,
    fileCount: files.length,
    createdCount: files.filter((file) => !file.existed).length,
    restorableCount: files.filter((file) => file.restorable).length,
  };
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
    const round = mergeRound(checkpoints);
    // 无 turnId = 「回滚本轮」：整轮（全部子轮次）一起还原，新 → 旧
    const targets = turnId
      ? checkpoints.filter((item) => item.id === turnId)
      : (round?.checkpoints ?? []);
    if (!sessionId || targets.length === 0) return;

    const fileCount = turnId ? (targets[0]?.fileCount ?? 0) : (round?.fileCount ?? 0);
    const restorableCount = turnId ? (targets[0]?.restorableCount ?? 0) : (round?.restorableCount ?? 0);
    const commandCount = targets.reduce((sum, item) => sum + item.commands.length, 0);

    const shellWarning = commandCount > 0
      ? `\n\n注意：本轮还执行过 ${commandCount} 条命令，命令的副作用（生成物、安装、提交）不在回滚范围内。`
      : "";
    const ok = await dialogConfirm({
      title: "回滚本轮改动",
      message: `将还原本轮写入的 ${fileCount} 个文件（其中 ${restorableCount} 个可还原）。`
        + `本轮新建的文件会被删除，改动过的文件恢复原内容。${shellWarning}`,
      confirmText: "回滚",
      danger: true,
    });
    if (!ok) return;

    setRestoring(true);
    try {
      const restored: string[] = [];
      const deleted: string[] = [];
      const skipped: Array<{ path: string; reason: string }> = [];
      // 新 → 旧逐个子轮次还原：同一文件被多次改动时，先还原后发生的改动，才能让
      // 「新建文件删除」的校验（当前内容 == 该子轮次写入结果）成立，回到最早的原始状态。
      for (const target of targets) {
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/checkpoints/restore`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ turnId: target.id }),
          },
        );
        const data = (await res.json().catch(() => ({}))) as {
          restored?: string[];
          deleted?: string[];
          skipped?: Array<{ path: string; reason: string }>;
          error?: string;
        };
        if (!res.ok) throw new Error(data.error || `回滚失败（HTTP ${res.status}）`);
        restored.push(...(data.restored ?? []));
        deleted.push(...(data.deleted ?? []));
        skipped.push(...(data.skipped ?? []));
      }
      const parts = [`已还原 ${restored.length} 个文件`];
      if (deleted.length) parts.push(`删除 ${deleted.length} 个新建文件`);
      if (skipped.length) parts.push(`${skipped.length} 个跳过`);
      toast(parts.join("，"));
      for (const item of skipped.slice(0, 2)) {
        if (item.path) toast(`跳过 ${item.path}：${item.reason}`);
      }
      await load(sessionId);
    } catch (error) {
      toast(error instanceof Error ? error.message : "回滚失败");
    } finally {
      setRestoring(false);
    }
  }, [sessionId, checkpoints, load]);

  const latestRound = useMemo(() => mergeRound(checkpoints), [checkpoints]);

  return {
    checkpoints,
    latestRound,
    restoring,
    restore,
    reload: () => setReloadKey((value) => value + 1),
  };
}
