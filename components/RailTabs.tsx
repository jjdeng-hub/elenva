"use client";

import { Activity, FileCode2, ListTree, X } from "lucide-react";
import { cn } from "@/components/lib/utils";

/** 右侧槽位可承载的面板（与 ChatView 的 RightPanel 同集合，去掉 null） */
export type RailPanel = "tree" | "files" | "observatory";

/** tab 内单个按钮：统一尺寸（约 28×28）+ 动效 */
const TAB_CLASS = "flex h-7 min-w-7 cursor-pointer items-center justify-center rounded-md t-fast";
const ACTIVE_CLASS = "bg-active text-accent";
const IDLE_CLASS = "text-dim hover:bg-hover hover:text-fg";

/**
 * 右栏面板头部的标签栏（观测 / 文件 / 树 + 收起）。
 *
 * 三个右栏面板（会话树 / 文件预览 / 观测栏）共用同一个头部：不再各写标题行，
 * 而是把面板切换收进这一个 segmented 控件里。点 tab = 直接切页（右栏保持打开），
 * 收起统一走右侧的 ×（以及顶栏的 rail-toggle）。
 *
 * 由 ChatView 组装后通过各面板的 `header` 插槽渲染 —— 面板自己只管内容与宽度，
 * 头部归一个来源，避免三处样式漂移。
 */
export function RailTabs({
  active,
  railAllowed,
  fileCount,
  treeNodes,
  onSelect,
  onClose,
}: {
  /** 当前激活面板；右栏收起时为 null（此时整栏正在淡出，不点亮任何 tab） */
  active: RailPanel | null;
  /** 观测 tab 是否可用（窄屏下右栏整体不可用） */
  railAllowed: boolean;
  /** 文件 tab 计数；<= 0 时不出现 */
  fileCount: number;
  /** 树 tab 节点数；undefined / <= 0 时不出现 */
  treeNodes?: number;
  /** 切换面板（右栏保持打开） */
  onSelect: (panel: RailPanel) => void;
  /** 收起整个右栏 */
  onClose: () => void;
}) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3.5">
      <div
        data-testid="rail-tabs"
        className="flex h-8 shrink-0 items-center rounded-lg border border-line bg-panel-2 p-0.5"
      >
        {railAllowed && (
          <button
            data-testid="rail-tab-observatory"
            onClick={() => onSelect("observatory")}
            title="观测：本会话实时数据"
            aria-label="观测：本会话实时数据"
            aria-pressed={active === "observatory"}
            className={cn(TAB_CLASS, active === "observatory" ? ACTIVE_CLASS : IDLE_CLASS)}
          >
            <Activity size={14} />
          </button>
        )}
        {fileCount > 0 && (
          <button
            data-testid="rail-tab-files"
            onClick={() => onSelect("files")}
            title="本会话 Agent 写入的文件（右侧预览）"
            aria-label="本会话 Agent 写入的文件（右侧预览）"
            aria-pressed={active === "files"}
            className={cn(TAB_CLASS, "gap-0.5 px-1", active === "files" ? ACTIVE_CLASS : IDLE_CLASS)}
          >
            <FileCode2 size={14} />
            <span className="text-[10px] tabular-nums">{fileCount}</span>
          </button>
        )}
        {treeNodes !== undefined && treeNodes > 0 && (
          <button
            data-testid="rail-tab-tree"
            onClick={() => onSelect("tree")}
            title="会话树：浏览分支、跳转到任意历史点继续"
            aria-label="会话树：浏览分支、跳转到任意历史点继续"
            aria-pressed={active === "tree"}
            className={cn(TAB_CLASS, "gap-0.5 px-1", active === "tree" ? ACTIVE_CLASS : IDLE_CLASS)}
          >
            <ListTree size={14} />
            <span className="text-[10px] tabular-nums">{treeNodes}</span>
          </button>
        )}
      </div>
      <button
        onClick={onClose}
        data-testid="rail-close"
        title="收起右栏"
        aria-label="收起右栏"
        className="ml-auto flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-dim t-fast hover:bg-hover hover:text-fg"
      >
        <X size={14} />
      </button>
    </div>
  );
}
