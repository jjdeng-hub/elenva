/**
 * 统一会话索引（P2 · 单一真源投影）。
 *
 * Pi 的会话文件与 Hermes 的 state.db 都投影成同一个 SessionInfo
 * （lib/types.ts，本轮补了 runtime / source / running 三个可选字段），
 * 侧栏、搜索、分组只认这个形状；正文不在这里 —— 点开会话时向它所属的
 * 运行时取消息（Pi 读会话文件，Hermes 读 state.db）。
 *
 * 只存元数据、可随时重建：这里是索引层，不是第二个真源。
 */

import type { SessionInfo } from "@/lib/types";
import { hermesHome } from "@/lib/hermes-home";
import { listAgents } from "@/lib/agents/registry";
import { findAgent, type AgentRecord } from "@/lib/agents/manifest";
import { listHermesSessions } from "@/lib/agents/resources";
import {
  attachSessionProjectInfo,
  listAllSessions,
  mergeSessionLists,
} from "@/lib/session-reader";
import { getRunningAgentSessionIds } from "@/lib/agent-runtime";

/** ACP 宿主地址（与 app/api/agents/pending 同口径） */
const ACP_HOST = process.env.ELENVA_ACP_HOST?.trim() || "http://127.0.0.1:30201";

/** Hermes 会话的统一 id 前缀：避免与 Pi 会话 id 撞车 */
const HERMES_ID_PREFIX = "hermes";

/** 把一条 Hermes 会话投影成统一 SessionInfo */
export function hermesSessionToInfo(
  agent: AgentRecord,
  row: {
    id: string;
    title: string;
    source: string;
    startedAt: string;
    lastActivityAt: string;
    messageCount: number;
    cwd?: string | null;
  },
): SessionInfo {
  // cwd 兑底：state.db 里可为 null（webhook/feishu 来源），用应用包目录顶上，
  // 保证 SessionInfo.cwd 非空 —— 侧栏分组/展示都依赖它。
  const cwd = row.cwd || agent.dir || `${hermesHome()}/profiles/${agent.profile ?? agent.id}`;
  return {
    path: `state.db:${row.id}`,
    id: `${HERMES_ID_PREFIX}:${agent.profile ?? agent.id}:${row.id}`,
    cwd,
    name: row.title || "(无标题)",
    created: row.startedAt || row.lastActivityAt,
    modified: row.lastActivityAt || row.startedAt,
    messageCount: row.messageCount,
    firstMessage: row.title || "",
    projectKey: cwd.toLowerCase(),
    runtime: "hermes",
    source: `state.db:${row.id}`,
    running: false, // 由调用方按 ACP 宿主状态补
  };
}

/** 从统一 id 里取 Hermes 的 state.db 会话 id；非 hermes 索引行返回 null */
export function hermesStateDbSessionId(info: Pick<SessionInfo, "id" | "source">): string | null {
  if (!info.id.startsWith(`${HERMES_ID_PREFIX}:`)) return null;
  const source = info.source ?? "";
  return source.startsWith("state.db:") ? source.slice("state.db:".length) : null;
}

/** 查每个 Hermes Agent 是否有一轮在跑（ACP 宿主 state=idle 之外都算跑） */
async function hermesRunningAgentIds(agentIds: string[]): Promise<Set<string>> {
  const running = new Set<string>();
  await Promise.all(
    agentIds.map(async (id) => {
      try {
        const res = await fetch(`${ACP_HOST}/pending?agentId=${encodeURIComponent(id)}`, {
          cache: "no-store",
          signal: AbortSignal.timeout(2500),
        });
        if (!res.ok) return;
        const data = (await res.json()) as { state?: string };
        if (data.state && data.state !== "idle" && data.state !== "n/a") running.add(id);
      } catch {
        /* 宿主没起来：全都算空闲，不报错 */
      }
    }),
  );
  return running;
}

/**
 * 统一会话列表：Pi（会话文件）+ Hermes（state.db）投影成同一形状。
 * 侧栏、搜索、分组只吃这里；失败降级为空数组（不阻塞界面）。
 */
export async function listUnifiedSessions(): Promise<SessionInfo[]> {
  const { agents } = listAgents();
  const hermesAgents = agents.filter((agent) => agent.runtime === "hermes");

  // Pi：现有扫描 + 内存中的运行时会话，投影时补 runtime/source
  const piPromise = (async () => {
    try {
      const persisted = await listAllSessions();
      const runtimeInfos = await attachSessionProjectInfo([]); // 运行中会话由 runningIds 表达
      const merged = mergeSessionLists(persisted, runtimeInfos);
      const runningIds = new Set(getRunningAgentSessionIds());
      return merged.map((info) => ({
        ...info,
        runtime: "pi" as const,
        source: info.path,
        running: runningIds.has(info.id),
      }));
    } catch {
      return [];
    }
  })();

  // Hermes：每个 runtime=hermes 的 Agent 投影它的 state.db 会话
  const hermesPromise = (async () => {
    if (hermesAgents.length === 0) return [] as SessionInfo[];
    const runningAgentIds = await hermesRunningAgentIds(hermesAgents.map((agent) => agent.id));
    const out: SessionInfo[] = [];
    for (const agent of hermesAgents) {
      const profile = agent.profile ?? agent.id;
      try {
        const rows = await listHermesSessions(profile, 40);
        for (const row of rows) {
          const info = hermesSessionToInfo(agent, row);
          // 「正在跑」只标到该 Agent 最近的一条会话上（ACP 宿主每 Agent 一条活跃会话）
          info.running = runningAgentIds.has(agent.id) && out.length === 0 && rows[0]?.id === row.id;
          out.push(info);
        }
      } catch {
        /* 这个 profile 读不了：跳过，不拖垮整个索引 */
      }
    }
    return out;
  })();

  const [pi, hermes] = await Promise.all([piPromise, hermesPromise]);
  // Hermes 行排在前面没有意义；按更新时间混排由消费端（侧栏）分组处理，这里只拼接。
  return [...pi, ...hermes];
}
