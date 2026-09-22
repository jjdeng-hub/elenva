"use client";

import { FileCode2, ListTree, RotateCcw, Terminal } from "lucide-react";
import { cn } from "@/components/lib/utils";
import { summarizeTurn, toneClass } from "@/lib/turn-evidence";
import type { TurnCheckpointsState } from "@/hooks/useTurnCheckpoints";

/**
 * 输入框上方的本轮状态行 —— 观测栏的**入口**，不是明细本身。
 *
 * 明细（改了哪些文件、跑了哪些命令、哪条验证失败）都在右侧观测栏的「本轮」区，
 * 这里只留一行。为什么一行也不肯撤掉（三条都很硬）：
 *   · 观测栏窄屏不可用（<1024px），且**用户可能自己把它关了** —— 明细不能只有那一个入口；
 *   · 「回滚」是纠错动作，要能在看到问题的当下就按，不该先去开面板；
 *   · 一轮结束时用户正好在看输入框附近（刚发完消息），不打扰的成本最低。
 *
 * 但文案必须短：结论用 shortHeadline（不带命令），观测栏开着时连「明细」按钮也不给 ——
 * 明细就在右边，再摆一个入口只是多占宽度。
 */
export function TurnFooter({
  turn,
  running,
  railOpen,
  canOpenRail,
  onOpenRail,
}: {
  turn: TurnCheckpointsState;
  running: boolean;
  /** 观测栏当前**开着**：明细就在右边，不必再给一个「明细」入口 */
  railOpen?: boolean;
  /** 观测栏当前可用（窄屏时为 false，此时不显示「明细」入口） */
  canOpenRail?: boolean;
  onOpenRail?: () => void;
}) {
  // 「本轮」= 合并后的用户轮。内核的 turn 是「一次 LLM 往返」，一轮用户消息常含多个
  // 子轮次，且终答子轮次几乎没有文件/命令 —— 只取最后一个子轮次会让这行在真实工作
  // 轮里几乎永远显示为空（详见 useTurnCheckpoints.mergeRound）。
  const round = turn.latestRound;
  // 纯问答轮（没有文件也没有命令）不占用输入框上方的空间
  if (running || !round) return null;
  if (round.fileCount === 0 && round.commands.length === 0) return null;

  const summary = summarizeTurn(round.fileCount, round.createdCount, round.commands);
  const hasWrites = summary.files > 0;

  return (
    /* 外层 .chat-col 不能省：消息区、状态条、输入框都靠它对齐（左右各一份 --chat-pad），
       少一层就会左右各多出 40px（实测 781px vs 701px），看起来像另一列的东西。 */
    <div className="chat-col">
      <div
        className="mb-1.5 flex items-center gap-2 rounded-card border border-line bg-panel-2/60 px-2.5 py-1"
        data-testid="turn-footer"
      >
        {hasWrites
          ? <FileCode2 size={12} className="shrink-0 text-dim" />
          : <Terminal size={12} className="shrink-0 text-dim" />}

        <span className="min-w-0 flex-1 truncate text-[12px] text-muted">
          {hasWrites ? (
            <>改动 <span className="text-fg">{summary.files}</span> 个文件</>
          ) : (
            <>未改动文件</>
          )}
          {summary.commands > 0 && (
            <>
              {" · "}
              <span className="tabular-nums text-fg">{summary.commands}</span>
              {" 条命令"}
              {summary.failed > 0 && <span className="text-danger">（{summary.failed} 失败）</span>}
            </>
          )}
          {hasWrites && (
            <>
              {" · "}
              <span className={cn(summary.level === "suite" && "text-success")}>{summary.shortHeadline}</span>
            </>
          )}
        </span>

        <div className="flex shrink-0 items-center gap-1">
          {canOpenRail && !railOpen && onOpenRail && (
            <button
              onClick={onOpenRail}
              className="flex h-6 cursor-pointer items-center gap-1 rounded-md border border-line bg-panel px-1.5 text-[11px] text-muted t-fast hover:text-fg"
              title="在右侧观测栏查看本轮明细（改动 / 执行 / 验证）"
              data-testid="turn-detail"
            >
              <ListTree size={12} />
              明细
            </button>
          )}
          {hasWrites && (
            <button
              onClick={() => void turn.restore()}
              disabled={turn.restoring || round.restorableCount === 0}
              className="flex h-6 cursor-pointer items-center gap-1 rounded-md border border-line bg-panel px-1.5 text-[11px] text-muted t-fast hover:border-danger/40 hover:text-danger disabled:opacity-50"
              title="把本轮写入的文件恢复原状"
              data-testid="rollback-turn"
            >
              <RotateCcw size={12} />
              {turn.restoring ? "回滚中…" : "回滚本轮"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
