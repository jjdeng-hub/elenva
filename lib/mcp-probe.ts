import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * MCP 服务器「连接探针」——把「连没连上、报什么错」从会话里的 `/mcp` 搬到插件页。
 *
 * 做法（best-effort）：逐服务器**临时建连 → listTools → close**，用完即断，不影响运行中会话。
 *
 * ## 为什么走内部路径
 *
 * pi 1.0.0 的 `package.json` `exports` 只暴露包根（`createMcpExtension` + 类型），
 * MCP 连接的实现（`McpServerConnection` / `createDefaultTransport`）在
 * `dist/extensions/mcp/runtime.js`，不在 exports map 里。包根未提供「只探测、不建会话」的入口，
 * 所以这里用 `getPackageDir()`（公开导出）解析包内绝对路径后动态 import。
 * 这是**非公开面**：内核升级可能改动该文件布局/导出。为此：
 *   · `loadRuntime()` 会校验导出形态，缺了就整体降级（状态 = unavailable，路由回落配置态）；
 *   · `tools/mcp-probe-selftest.mjs` 对这条路径做回归断言（升级内核时能红）。
 * 仓库内已有同类先例：`app/api/sessions/[id]/export/route.ts` 动态 import
 * `dist/core/export-html/index.js`。
 *
 * ## 成本与副作用
 *
 * stdio 服务器会被**真正拉起**（`McpServerConnection` → `StdioTransport` spawn），用完 close 会
 * 连进程组一起收掉。因此：串行、单服务器 ≤5s、结果缓存 60s、同刻只允许一个探针（自锁），
 * 且只探测 `enabled !== false` 的服务器。
 */

export type McpProbeState = "connected" | "failed" | "disabled" | "unavailable";

export interface McpProbeResult {
  state: McpProbeState;
  /** state === "connected" 时的工具数 */
  toolCount?: number;
  /** state === "failed" 时的原因（已截断） */
  error?: string;
}

export interface McpProbeEntry {
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

/** 单服务器超时上限（毫秒） */
export const MCP_PROBE_TIMEOUT_MS = 5_000;
/** 结果缓存时长（毫秒） */
export const MCP_PROBE_CACHE_MS = 60_000;
/** 错误摘要截断长度 */
export const MCP_PROBE_ERROR_CHARS = 200;

interface McpConnectionLike {
  state: string;
  tools: Array<{ name: string }>;
  error?: string;
  getClient(): Promise<unknown>;
  close(): Promise<void>;
}

interface McpRuntimeModule {
  McpServerConnection: new (options: Record<string, unknown>) => McpConnectionLike;
  createDefaultTransport: unknown;
  McpOAuthCredentialStore: new () => unknown;
}

let runtimePromise: Promise<McpRuntimeModule> | null = null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 只保留错误摘要的前 N 个字符（连接错误的首行通常就是原因；进程 stderr 尾巴在后） */
export function truncateProbeError(value: string | undefined): string {
  const text = (value ?? "").replace(/\s+$/g, "");
  if (text.length <= MCP_PROBE_ERROR_CHARS) return text;
  return `${text.slice(0, MCP_PROBE_ERROR_CHARS - 1)}…`;
}

/** 惰性加载内核的 MCP 运行时（内部路径）；形态不符时抛错，由调用方降级。 */
async function loadRuntime(): Promise<McpRuntimeModule> {
  runtimePromise ??= (async () => {
    const url = pathToFileURL(join(getPackageDir(), "dist", "extensions", "mcp", "runtime.js")).href;
    // webpackIgnore / turbopackIgnore：这是运行时才解析的绝对路径，别让打包器去静态解析它。
    const mod = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url)) as Partial<McpRuntimeModule>;
    if (typeof mod.McpServerConnection !== "function" || typeof mod.createDefaultTransport !== "function") {
      throw new Error("内核 MCP 运行时形态变化：缺 McpServerConnection / createDefaultTransport");
    }
    return mod as McpRuntimeModule;
  })();
  return runtimePromise;
}

class ProbeTimeoutError extends Error {
  constructor() {
    super(`连接超时（${MCP_PROBE_TIMEOUT_MS / 1000}s）`);
  }
}

/** 探测单个服务器：建连 → 读 tools → 关掉。绝不抛（异常收敛成 failed）。 */
async function probeOne(runtime: McpRuntimeModule, entry: McpProbeEntry, cwd: string): Promise<McpProbeResult> {
  let connection: McpConnectionLike;
  try {
    connection = new runtime.McpServerConnection({
      entry: {
        name: entry.name,
        // 覆盖超时：内核按秒读 config.timeout（默认 60），探针要卡在 5s 内
        config: { ...entry.config, timeout: MCP_PROBE_TIMEOUT_MS / 1000 },
        source: "mcp.json",
        scope: "global",
      },
      cwd,
      createTransport: runtime.createDefaultTransport,
      credentials: new runtime.McpOAuthCredentialStore(),
      // 不写 mcp.log、不注册工具、不触发任何变更回调：探针是只读旁观
      log: undefined,
      onTools: () => undefined,
      onChange: () => undefined,
    });
  } catch (error) {
    return { state: "failed", error: truncateProbeError(errorMessage(error)) };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      connection.getClient(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ProbeTimeoutError()), MCP_PROBE_TIMEOUT_MS);
      }),
    ]);
    if (connection.state === "connected") {
      return { state: "connected", toolCount: connection.tools.length };
    }
    if (connection.state === "needs-auth") {
      return { state: "failed", error: "需要登录（会话内输入 /mcp 后按提示授权）" };
    }
    return { state: "failed", error: truncateProbeError(connection.error ?? connection.state) };
  } catch (error) {
    if (connection.state === "needs-auth") {
      return { state: "failed", error: "需要登录（会话内输入 /mcp 后按提示授权）" };
    }
    return { state: "failed", error: truncateProbeError(connection.error ?? errorMessage(error)) };
  } finally {
    if (timer) clearTimeout(timer);
    // 无论成败都断干净：client.close() 会关 transport / 杀掉 stdio 进程组
    await connection.close().catch(() => undefined);
  }
}

interface ProbeCache {
  key: string;
  at: number;
  results: Map<string, McpProbeResult>;
}

let cache: ProbeCache | null = null;
let inflight: Promise<Map<string, McpProbeResult>> | null = null;

/**
 * 逐服务器串行探测（同刻只允许一个探针在跑；60s 内复用结果）。
 * 返回 Map<name, result>，只含 enabled 的服务器；探测能力不可用时全部返回 unavailable。
 */
export async function probeMcpServers(
  entries: readonly McpProbeEntry[],
  cwd: string,
  now: number = Date.now(),
): Promise<Map<string, McpProbeResult>> {
  const enabled = entries.filter((entry) => entry.enabled);
  const key = JSON.stringify(enabled.map((entry) => [entry.name, entry.config]));

  if (cache && cache.key === key && now - cache.at < MCP_PROBE_CACHE_MS) return cache.results;
  if (inflight) return inflight;

  inflight = (async () => {
    const results = new Map<string, McpProbeResult>();
    if (enabled.length === 0) {
      cache = { key, at: Date.now(), results };
      return results;
    }
    let runtime: McpRuntimeModule;
    try {
      runtime = await loadRuntime();
    } catch (error) {
      const error$ = truncateProbeError(errorMessage(error));
      for (const entry of enabled) results.set(entry.name, { state: "unavailable", error: error$ });
      cache = { key, at: Date.now(), results };
      return results;
    }
    for (const entry of enabled) {
      // 串行：一次只跑一个，避免多个 stdio 服务器同时被拉起
      results.set(entry.name, await probeOne(runtime, entry, cwd));
    }
    cache = { key, at: Date.now(), results };
    return results;
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}

/** 测试用：清掉缓存与在途探针 */
export function resetMcpProbeState(): void {
  cache = null;
  inflight = null;
}
