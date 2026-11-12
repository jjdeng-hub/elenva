"use client";

import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import type { AgentRecord } from "@/lib/agents/manifest";

/**
 * Agent 专属视图尚未接入时的占位页。
 *
 * 之前这类点击是**静默拦截**（`if (isPackageAgent && v !== "home") return`）：
 * 菜单还在、点了没反应，看不出是坏了还是没做。这里改成明确说清三件事：
 * 这个视图属于谁、它的数据在哪、现在能用什么。
 */

const VIEW_LABELS: Record<string, string> = {
  chat: "会话",
  code: "代码",
  rhythm: "节律",
  growth: "成长",
  memory: "记忆",
  skills: "技能",
  identity: "身份",
  prompt: "提示词",
  approvals: "审批历史",
};

/**
 * 「这类 Agent 本来就没有这个视图」时该说的话。
 *
 * 与「还没接」分开：代码 / 提示词对 Hermes 运行时不是待办，是设计上不适用——
 * 把不适用说成「快做完了」，下次还会有人来问同一个问题。
 */
const NOT_APPLICABLE: Record<string, { reason: string; instead: string[] }> = {
  code: {
    reason: "这个 Agent 不把代码当工作物。它的活儿在数据文件里（工作台的那些块），代码视图留给编码 Agent（Elen）。",
    instead: ["回「工作台」看今天 / 练 / 日志", "要看它改过哪些文件：在会话里让它报告，或去「工作台」的相关块"],
  },
  prompt: {
    reason: "提示词不是一份文件：它由 SOUL（身份）+ 记忆索引 + 技能索引 + 平台指令在每次会话启动时拼成。",
    instead: ["改人格与规则 → 「身份」（就是 SOUL.md，可编辑）", "改会被带进去的事实 → 「记忆」", "改会被带进去的能力 → 「技能」"],
  },
};

function dataHome(agent: AgentRecord): { runtime: string; paths: string[] } {
  if (agent.runtime === "hermes") {
    const profile = agent.profile ?? agent.id;
    const root = profile === "default" ? "~/.hermes" : `~/.hermes/profiles/${profile}`;
    return {
      runtime: `Hermes（profile: ${profile}）`,
      paths: [
        `${root}/state.db —— 会话与消息（sqlite）`,
        `${root}/memories/{MEMORY,USER}.md —— 记忆`,
        `${root}/skills/ —— 技能`,
        `${root}/cron/jobs.json —— 节律`,
        `${root}/SOUL.md —— 身份`,
      ],
    };
  }
  return {
    runtime: `Pi 内核（进程内）`,
    paths: ["~/.pi/agent/ —— 会话 / 技能 / 记忆都由内核自己管理"],
  };
}

export function AgentScopePlaceholder({ agent, view }: { agent: AgentRecord; view: string }) {
  const label = VIEW_LABELS[view] ?? view;
  const home = dataHome(agent);
  const notApplicable = NOT_APPLICABLE[view];

  return (
    <div className="flex-1 overflow-y-auto px-6 py-8" data-testid="agent-scope-placeholder">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <div>
          <h1 className="text-[20px] font-bold tracking-tight">{agent.name} · {label}</h1>
          <p className="mt-1 text-[12px] leading-relaxed text-dim">
            {notApplicable ? notApplicable.reason : "这个视图的数据还没接进工作台。它不是坏了，是还没有入口。"}
          </p>
        </div>

        {notApplicable ? (
          <Card>
            <CardHeader>
              <CardTitle>那该去哪儿</CardTitle>
            </CardHeader>
            <div className="flex flex-col gap-1.5 px-4 py-3 text-[12px] text-dim">
              {notApplicable.instead.map((line) => (
                <div key={line}>· {line}</div>
              ))}
            </div>
          </Card>
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle>它的数据在哪</CardTitle>
                <span className="ml-auto text-[10px] text-dim/70">{home.runtime}</span>
              </CardHeader>
              <div className="flex flex-col gap-1 px-4 py-3">
                {home.paths.map((path) => (
                  <div key={path} className="font-mono text-[11px] text-muted">
                    {path}
                  </div>
                ))}
              </div>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>现在能做什么</CardTitle>
              </CardHeader>
              <div className="flex flex-col gap-1.5 px-4 py-3 text-[12px] text-dim">
                <div>· 回「工作台」：这条 Agent 的视图与数据都在那里</div>
                <div>· 已经能进：会话 / 记忆 / 技能 / 节律 / 成长 / 身份</div>
                <div>· 「平台」那一组（模型 / 插件 / 系统 / 设置）是所有 Agent 共用的，随时可进</div>
              </div>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
