"use client";

import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { AgentPanels } from "@/components/AgentPanels";
import { AgentChat } from "@/components/AgentChat";
import { agentGlyph, type AgentRecord } from "@/lib/agents/manifest";

/**
 * 应用包 Agent 的首页（P0 占位）。
 *
 * P0 只做「注册表 + 切换」：这里如实展示应用包的清单信息，并说明运行时尚未接入，
 * 不伪造会话、不伪造数据。P1 起，这个位置会被该 Agent 自己声明的首屏面板接管
 * （装修 Agent 的第一屏是「预算与决策」，面板类型 table）。
 */
export function AgentHome({ agent }: { agent: AgentRecord }) {
  return (
    <div data-testid="agent-home" className="mx-auto w-full max-w-3xl px-6 py-8">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-card border border-line bg-panel text-[16px]">
          {agentGlyph(agent)}
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[20px] font-bold tracking-tight">{agent.name}</h1>
            <span className="rounded-sm border border-line px-1.5 py-0.5 text-[10px] text-dim">
              runtime: {agent.runtime}
            </span>
            {agent.version && (
              <span className="rounded-sm border border-line px-1.5 py-0.5 text-[10px] text-dim">
                v{agent.version}
              </span>
            )}
          </div>
          {agent.description && <p className="mt-1 text-[12px] text-dim">{agent.description}</p>}
        </div>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>应用包</CardTitle>
        </CardHeader>
        <div className="flex flex-col gap-1 px-4 py-3 text-[12px] text-dim">
          <div>
            标识：{agent.id}
            {agent.version ? ` · v${agent.version}` : ""}
          </div>
          <div className="break-all">目录：{agent.dir ?? "（内置，不占用户目录）"}</div>
          <div>面板：{agent.panels?.length ? agent.panels.map((panel) => panel.title).join(" / ") : "未声明"}</div>
        </div>
      </Card>

      <AgentPanels agentId={agent.id} />

      {agent.runtime === "hermes" ? (
        <AgentChat agentId={agent.id} profile={agent.profile ?? agent.id} />
      ) : (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>运行时尚未接入</CardTitle>
          </CardHeader>
          <div className="px-4 py-3 text-[12px] text-dim">
            这个 Agent 声明的是 {agent.runtime} 运行时。平台内置的 Justin 走进程内 Pi；
            应用包目前支持 hermes（ACP 子进程）。
          </div>
        </Card>
      )}
    </div>
  );
}
