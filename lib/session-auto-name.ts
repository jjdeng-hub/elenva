import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { generateSessionTitle } from "./session-title";
import { invalidateSessionListCache } from "./session-reader";

/**
 * 会话标题自动生成。
 *
 * 内核默认拿「首条用户消息截断」当标题，于是列表里会出现
 * `/api/auto/fix/preview.test.tsx, 内容为: …` 这类原始文本。
 * `generateSessionTitle` 早就能产出干净标题，但入口一直只挂在会话菜单的
 * 「AI 自动命名」上——必须手动点，且只对当前打开的那个会话生效。
 *
 * 这里把它接到「一次 agent 运行结束」的钩子上（见 agent-runtime 的
 * onAgentRunComplete）：首轮跑完、且会话还没有名字时，后台静默生成一次。
 */

/** 每个会话最多尝试几次（失败后重试有上限，避免反复消耗 token） */
const MAX_ATTEMPTS = 2;

const inFlight = new Set<string>();
const attempts = new Map<string, number>();

/** 自动命名默认开启；设 ELENVA_AUTO_TITLE=0 可关闭 */
export function isAutoTitleEnabled(): boolean {
  return process.env.ELENVA_AUTO_TITLE !== "0";
}

/**
 * 若该会话尚无标题且已完成至少一轮对话，则后台生成一次标题。
 * 调用方不需要 await，也无需处理异常。
 */
export async function autoNameSessionIfNeeded(session: AgentSession): Promise<void> {
  if (!isAutoTitleEnabled()) return;

  const sessionId = session.sessionId as string | undefined;
  if (!sessionId) return;

  // 已有名字：说明手动或此前已命名过 —— 保持不动，天然做到「每个会话只做一次」
  if (session.sessionManager.getSessionName()) return;

  const messages = session.agent.state.messages;
  const hasUser = messages.some((message) => message.role === "user");
  const hasAssistant = messages.some((message) => message.role === "assistant");
  if (!hasUser || !hasAssistant) return;

  if (inFlight.has(sessionId)) return;
  if ((attempts.get(sessionId) ?? 0) >= MAX_ATTEMPTS) return;

  inFlight.add(sessionId);
  attempts.set(sessionId, (attempts.get(sessionId) ?? 0) + 1);
  try {
    const result = await generateSessionTitle(session);
    // 生成期间用户可能已经手动命名，别覆盖
    if (session.sessionManager.getSessionName()) return;
    session.setSessionName(result.title);
    invalidateSessionListCache();
  } finally {
    inFlight.delete(sessionId);
  }
}
