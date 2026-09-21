"use client";

import {
  Bot,
  Brain,
  Cpu,
  FlaskConical,
  FolderGit2,
  House,
  ListChecks,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  ScrollText,
  Server,
  Settings,
  Sparkles,
} from "lucide-react";
import { useEffect } from "react";
import { cn } from "@/components/lib/utils";
import { Logo, LogoMark } from "@/components/Logo";
import { Resizer, usePersistedWidth } from "@/components/ui/Resizer";

export type View =
  | "home"
  | "chat"
  /** 代码：文件浏览 + 改动查看 + 提交（由原「Git 变更」与「文件浏览器」合并而来） */
  | "code"
  | "skills"
  | "memory"
  /** 提示词：模型每轮实际看到的内容（pi 基座 + 宿主层 + 项目指令 + 技能索引） */
  | "prompt"
  | "models"
  | "plugins"
  | "subagents"
  /** 并行试验：同一任务开 N 个候选，各自在独立 worktree 里跑，跑完并排比 */
  | "candidates"
  /** 系统：服务 / 门禁 / 备份 / 版本 / 部署 / 资源的只读快照 */
  | "system"
  | "settings";

/** 导航项。展开态为「图标 + 文字」整行，收起态为 36×36 纯图标按钮（靠 title 兜底提示）。
 *  注意：导航一律不显示计数角标，所有计数统一收在底部内核状态卡里。 */
function NavItem({
  icon,
  label,
  active,
  disabled,
  collapsed,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  disabled?: boolean;
  collapsed: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={collapsed ? label : undefined}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "mb-0.5 flex items-center rounded-lg text-[13px] t-fast",
        collapsed ? "size-9 shrink-0 justify-center" : "w-full gap-2.5 px-2.5 py-2 text-left",
        disabled
          ? "cursor-not-allowed text-dim/60"
          : active
            ? "bg-active font-semibold text-accent"
            : "cursor-pointer text-muted hover:bg-hover hover:text-fg",
      )}
    >
      <span className="flex w-4 shrink-0 justify-center">{icon}</span>
      {/* 文字常驻、只做 opacity：收起时若卸载 DOM，宽度动画还在走而文字已消失，
          看起来就是「文字被删掉了」。这一条与容器的宽度过渡是同一个 150ms。 */}
      <span
        className={cn(
          "min-w-0 overflow-hidden whitespace-nowrap text-left transition-opacity duration-150",
          collapsed ? "pointer-events-none w-0 opacity-0" : "opacity-100",
        )}
      >
        {label}
        {disabled && <span className="ml-1.5 text-[10px] text-dim/60">建设中</span>}
      </span>
    </button>
  );
}

export function WorkstationSidebar({
  view,
  onViewChange,
  sessionCount,
  runningCount,
  projectCount,
  defaultCwd,
  collapsed,
  onToggle,
  drawer = false,
  drawerOpen = false,
  onWidthChange,
}: {
  view: View;
  onViewChange: (v: View) => void;
  sessionCount: number;
  runningCount: number;
  projectCount: number;
  defaultCwd: string | null;
  collapsed: boolean;
  onToggle: () => void;
  /** 窄屏抽屉模式：脱离文档流，从左侧滑入覆盖内容区 */
  drawer?: boolean;
  /** 抽屉是否已滑出（仅 drawer 模式有意义） */
  drawerOpen?: boolean;
  /** 宽度变化时通知外壳（用于同步布局） */
  onWidthChange?: (width: number) => void;
}) {
  const running = runningCount > 0;
  /* 展开态宽度可拖拽；抽屉模式（窄屏浮层）保持固定，拖拽只对静态侧栏有意义 */
  const { width, grow, reset } = usePersistedWidth("elenva-ws-sidebar-width", 220, 180, 360);
  useEffect(() => {
    onWidthChange?.(width);
  }, [width, onWidthChange]);
  // 抽屉模式恒为展开态（220px 完整导航），收起态只属于 >=1024px 的静态侧栏
  const isCollapsed = drawer ? false : collapsed;

  /* 收起/展开的文字过渡：元素常驻，只改 opacity，与容器宽度动画（.t-slow 200ms）同时进行。
     150ms 比宽度略快，收起来时文字先淡走、栏还在收，视觉上不拖泥带水。 */
  const fadeText = cn(
    "min-w-0 overflow-hidden whitespace-nowrap transition-opacity duration-150",
    isCollapsed ? "pointer-events-none opacity-0" : "opacity-100",
  );
  const fadeBox = cn(
    "transition-opacity duration-150",
    isCollapsed ? "pointer-events-none opacity-0" : "opacity-100",
  );
  const groupCls = cn(
    "text-[11px] text-dim transition-opacity duration-150",
    // 收起时收成一条 10px 的间隔，与原来的 h-2.5 分隔一致（全归零会让三组图标糊成一片）
    isCollapsed ? "h-2.5 overflow-hidden py-0 opacity-0" : "px-2.5 pb-1.5 pt-3 opacity-100",
  );

  const aside = (
    <aside
      className={cn(
        "flex flex-col border-r border-line bg-panel t-pane",
        drawer
          ? cn(
              // lg:hidden 兜底：窗口由窄变宽、而 matchMedia 回调尚未跑完时，不让浮层盖住内容区
              "fixed inset-y-0 left-0 z-[91] w-[220px] px-3 py-4 lg:hidden",
              drawerOpen ? "translate-x-0" : "-translate-x-full",
            )
          : cn(
              // max-lg:hidden 兜底：窄屏首帧（JS 尚未判定 isNarrow）先隐藏静态侧栏，避免闪一下 220px
              "shrink-0 max-lg:hidden",
              isCollapsed ? "w-14 items-center py-2.5" : "px-3 py-4",
            ),
      )}
      style={drawer || isCollapsed ? undefined : { width }}
    >
      {/* ── 一套结构：靠 isCollapsed 控制样式，不再按状态切换 JSX 树 ──
          旧版是 `isCollapsed ? <56px 图标栏> : <220px 完整栏>` 两个分支。分支切换会
          重建整棵子树 —— 于是容器宽度还在走 200ms 过渡、文字却已经换掉了，
          观感就是「文字被直接删掉，栏还在慢慢缩」。现在文字常驻、只改 opacity。 */}
      {isCollapsed ? <LogoMark size={24} /> : <Logo />}

      <div className={groupCls}>工作区</div>
          <NavItem collapsed={isCollapsed} icon={<House size={14} />} label="工作台" active={view === "home"} onClick={() => onViewChange("home")} />
          <NavItem collapsed={isCollapsed} icon={<ListChecks size={14} />} label="会话" active={view === "chat"} onClick={() => onViewChange("chat")} />
          <NavItem collapsed={isCollapsed} icon={<FolderGit2 size={14} />} label="代码" active={view === "code"} onClick={() => onViewChange("code")} />

      <div className={groupCls}>资源</div>
          <NavItem collapsed={isCollapsed} icon={<Cpu size={14} />} label="模型" active={view === "models"} onClick={() => onViewChange("models")} />
          <NavItem collapsed={isCollapsed} icon={<Sparkles size={14} />} label="技能" active={view === "skills"} onClick={() => onViewChange("skills")} />
          <NavItem collapsed={isCollapsed} icon={<Brain size={14} />} label="记忆" active={view === "memory"} onClick={() => onViewChange("memory")} />
          <NavItem collapsed={isCollapsed} icon={<ScrollText size={14} />} label="提示词" active={view === "prompt"} onClick={() => onViewChange("prompt")} />
          <NavItem collapsed={isCollapsed} icon={<Plug size={14} />} label="插件" active={view === "plugins"} onClick={() => onViewChange("plugins")} />
          <NavItem collapsed={isCollapsed} icon={<Bot size={14} />} label="子代理" active={view === "subagents"} onClick={() => onViewChange("subagents")} />
          <NavItem collapsed={isCollapsed} icon={<FlaskConical size={14} />} label="并行试验" active={view === "candidates"} onClick={() => onViewChange("candidates")} />

      <div className={groupCls}>本机</div>
          <NavItem collapsed={isCollapsed} icon={<Server size={14} />} label="系统" active={view === "system"} onClick={() => onViewChange("system")} />
          <NavItem collapsed={isCollapsed} icon={<Settings size={14} />} label="设置" active={view === "settings"} onClick={() => onViewChange("settings")} />

      {/* 侧栏统计卡。这里**刻意不再重复「Pi 内核就绪」** —— 内核状态已移到页脚
          （任何视图可见），侧栏再放一份只是同一信息的第三处副本。 */}
      <div className={cn("mt-auto rounded-card bg-panel-2 px-3 py-3 text-[12px] text-dim", fadeBox)}>
        <div className="flex justify-between">
          <span>会话</span>
          <b className="font-medium text-fg tabular-nums">{sessionCount}</b>
        </div>
        <div className="flex justify-between">
          <span>运行中</span>
          <b className={cn("font-medium tabular-nums", running ? "text-accent" : "text-fg")}>{runningCount}</b>
        </div>
        <div className="flex justify-between">
          <span>项目</span>
          <b className="font-medium text-fg tabular-nums">{projectCount}</b>
        </div>
        {defaultCwd && (
          <div
            className="mt-1.5 truncate border-t border-line-soft pt-1.5 font-mono text-[11px] text-dim/80"
            title={defaultCwd}
          >
            {defaultCwd}
          </div>
        )}
      </div>

      {/* 收起/展开按钮固定在栏底（两个状态同一位置）；图标切换、文字淡出 */}
      <button
        onClick={onToggle}
        title={isCollapsed ? "展开侧栏" : "收起侧栏"}
        aria-label={isCollapsed ? "展开侧栏" : "收起侧栏"}
        className="mt-1.5 flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg py-1.5 text-[11px] text-dim t-fast hover:bg-hover hover:text-fg"
      >
        {isCollapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
        <span className={fadeText}>收起侧栏</span>
      </button>
    </aside>
  );

  /* 手柄放在侧栏**外侧**（右侧），拖拽改变侧栏宽度 */
  if (drawer || isCollapsed) return aside;
  return (
    <>
      {aside}
      <Resizer onDrag={grow} onDoubleClick={reset} label="调整主侧栏宽度" />
    </>
  );
}
