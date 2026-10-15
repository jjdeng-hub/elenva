import { randomUUID } from "node:crypto";
import { allowFileRoot } from "./file-access";
import { invalidateSessionListCache } from "./session-reader";
import { startAgentSession, type AgentSessionStartOptions, type AgentSessionWrapper } from "./agent-runtime";

/**
 * 「新建一条会话」的唯一路径（模块 3 · 第 4 轮抽出）。
 *
 * 此前 `app/api/agent/new` 里就地拼了这四步：生成一次性 tempKey → 起会话 →
 * 把 cwd 加进 files-route 允许根 → 让会话列表缓存失效。节律的无头执行要用
 * **同一条**路径（否则新会话的工作区可能读不到文件、列表也不刷新），所以把
 * 它抽到这里，两个调用方共用——不复制逻辑。
 *
 * tempKey 必须每次唯一：startAgentSession 会把同一 key 的并发调用合并成一条
 * 会话，用 Date.now() 同毫秒会碰撞成一条。
 */
export interface StartNewAgentSessionResult {
  session: AgentSessionWrapper;
  realSessionId: string;
}

export async function startNewAgentSession(
  cwd: string,
  options: AgentSessionStartOptions = {},
): Promise<StartNewAgentSessionResult> {
  const tempKey = `__new__${randomUUID()}`;
  const { session, realSessionId } = await startAgentSession(tempKey, "", cwd, options);
  // files-route 的允许根缓存（见 app/api/files/[...path]/route.ts）要立刻同步，
  // 否则新工作区下的文件请求会在缓存 TTL 内 403。
  allowFileRoot(cwd);
  invalidateSessionListCache();
  return { session, realSessionId };
}
