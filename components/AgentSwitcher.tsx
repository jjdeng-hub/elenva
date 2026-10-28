"use client";

import { cn } from "@/components/lib/utils";
import { agentGlyph, type AgentRecord } from "@/lib/agents/manifest";

/**
 * 侧栏顶部的 Agent 切换器（P0）。
 *
 * 只负责「选谁」：切换后整个 workspace（视图 / 会话 / 数据 / 运行时）换一套，
 * 具体视图由外壳决定。收起态只留图标，与侧栏其余导航一致。
 */
export function AgentSwitcher({
  agents,
  activeId,
  collapsed,
  onSelect,
}: {
  agents: AgentRecord[];
  activeId: string;
  collapsed: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <div
      data-testid="agent-switcher"
      className={cn("shrink-0 border-b border-line", collapsed ? "pb-2" : "px-0 pb-2.5")}
    >
      {!collapsed && (
        <div className="px-2.5 pb-1 text-[10px] font-medium tracking-wide text-dim/70">Agent</div>
      )}
      <div className="flex flex-col gap-0.5">
        {agents.map((agent) => {
          const active = agent.id === activeId;
          return (
            <button
              key={agent.id}
              type="button"
              onClick={() => onSelect(agent.id)}
              aria-pressed={active}
              title={agent.description ? `${agent.name} · ${agent.description}` : agent.name}
              className={cn(
                "flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg text-left t-fast",
                collapsed ? "justify-center" : "px-2",
                active ? "bg-hover text-fg" : "text-dim hover:bg-hover hover:text-fg",
              )}
            >
              <span
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-md border text-[11px]",
                  active ? "border-accent/40 text-accent" : "border-line text-dim",
                )}
              >
                {agentGlyph(agent)}
              </span>
              {!collapsed && (
                <>
                  <span className="min-w-0 flex-1 truncate text-[12px]">{agent.name}</span>
                  {agent.runtime !== "pi" && (
                    <span className="shrink-0 rounded-sm border border-line px-1 text-[10px] text-dim/80">
                      {agent.runtime}
                    </span>
                  )}
                </>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
