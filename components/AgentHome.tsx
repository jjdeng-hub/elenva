import { AgentWorkspace } from "@/components/AgentWorkspace";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import type { AgentRecord } from "@/lib/agents/manifest";

/**
 * 应用包 Agent 的首页。
 *
 * 壳在这里，内容由应用包的 manifest 声明：`views`（导航项）→ `blocks`（元件）。
 * 元件由平台实现（`components/agent-blocks.tsx`），所以「每个 Agent 一套 UI」
 * 不等于「每个 Agent 一套前端代码」。
 */
export function AgentHome({ agent, onOpenSession }: { agent: AgentRecord; onOpenSession?: () => void }) {
  if (!agent.dir) {
    return (
      <div className="mx-auto w-full max-w-3xl px-6 py-8">
        <Card>
          <CardHeader>
            <CardTitle>内置 Agent</CardTitle>
          </CardHeader>
          <div className="px-4 py-3 text-[12px] text-dim">
            {agent.name} 没有应用包目录，界面由平台自带视图接管。
          </div>
        </Card>
      </div>
    );
  }
  return <AgentWorkspace agent={agent} onOpenSession={onOpenSession} />;
}
