/**
 * 智能体阶段的类型与展示文案。
 *
 * 从 components/ChatWindow.tsx 原样搬过来（纯移动，判定逻辑一字未改），
 * 目的是让 hooks/useAgentSession.ts 的空闲看门狗也能拿到同一份阶段文案——
 * 否则「已等待 90s（阶段：？）」这种提示就会各写一套、两边说法不一致。
 */

export type AgentPhase =
  | { kind: "connecting" }
  | { kind: "waiting_model" }
  | { kind: "running_command" }
  | { kind: "running_tools"; tools: { id: string; name: string; progress?: string }[] }
  | null;

export function phaseToLabel(phase: AgentPhase, running: boolean): string {
  /* 守卫：phase 与 running 不一致时不能只信 phase。
     之前只要有 waiting_model 就无条件渲染，一旦出现「phase 残留 + 已经不在运行」
     就会永久卡着一行「等待模型…」，而此时输入框是发送态（没有停止按钮）——
     用户看到的是一个既没在跑、又不能中断的死状态。 */
  if (phase?.kind === "connecting") return "正在连接内核…";
  if (phase?.kind === "waiting_model") return running ? "等待模型…" : "";
  if (phase?.kind === "running_command") return "执行命令…";
  if (phase?.kind === "running_tools") {
    const active = phase.tools[phase.tools.length - 1];
    return active ? `工具执行中 · ${active.name}${active.progress ? ` · ${active.progress}` : ""}` : "工具执行中…";
  }
  if (running) return "思考中…";
  return "";
}
