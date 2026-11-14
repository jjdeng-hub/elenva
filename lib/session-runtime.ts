"use client";

import { useAgentSession, type UseAgentSessionOptions } from "@/hooks/useAgentSession";
import { useAcpSession, type UseAcpSessionOptions } from "@/hooks/useAcpSession";
import type { TurnCheckpointsState } from "@/hooks/useTurnCheckpoints";

/**
 * 运行时适配器表面（P2 · 同一套会话外壳）。
 *
 * Pi（useAgentSession）与 Hermes（useAcpSession）对 ChatView 暴露同一组字段；
 * ChatView 只认这个形状，不关心背后是哪个运行时。
 *
 * P2 扩展字段：
 * - acpTurn：Hermes 的「本轮」（步数/耗时，来自 turn_end 事件）；Pi 侧没有。
 * - hermes*：Hermes 审批/标题/连接等内部状态，供宿主工作台（原 HermesChat 的
 *   职责）复用；Pi 侧不存在，访问前先判 runtime。
 */
export type SessionRuntimeSurface = ReturnType<typeof useAgentSession> & {
  acpTurn?: TurnCheckpointsState | null;
  hermesPermission?: unknown;
  hermesRespondToPermission?: (optionId: string) => Promise<void>;
  hermesTitle?: string | null;
  hermesConnection?: "live" | "lost";
  hermesTurnStat?: { steps: number; ms: number; tokens?: string } | null;
  hermesSessionDbId?: string | null;
  hermesProfile?: string;
};

export interface UseSessionRuntimeOptions extends UseAgentSessionOptions {
  /** 该会话的运行时；缺省 pi（内置 Elen 等既有入口零改动） */
  runtime?: "pi" | "hermes";
  /** runtime=hermes 时使用：ACP agent id */
  hermesAgentId?: string;
  /** runtime=hermes 时使用：Hermes profile 名 */
  hermesProfile?: string;
}

/**
 * 按运行时分发到对应适配器。
 *
 * runtime 由外层在挂载时决定（ChatView 按会话 key 重挂载，实例内恒定），
 * 所以这里按它分支调用不同 hook 是安全的：同一实例内的 hook 调用顺序永远稳定。
 */
export function useSessionRuntime(options: UseSessionRuntimeOptions): SessionRuntimeSurface {
  const { runtime, hermesAgentId, hermesProfile, ...rest } = options;
  void hermesProfile;
  if (runtime === "hermes") {
    const acpOptions: UseAcpSessionOptions = {
      agentId: hermesAgentId ?? "",
      profile: hermesProfile ?? hermesAgentId ?? "",
      session: options.session,
      onAgentEnd: options.onAgentEnd,
      onSystemToolsChange: options.onSystemToolsChange as UseAcpSessionOptions["onSystemToolsChange"],
    };
    return useAcpSession(acpOptions);
  }
  return useAgentSession(rest as UseAgentSessionOptions);
}
