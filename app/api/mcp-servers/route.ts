import { NextResponse } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "@/lib/atomic-file";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { probeMcpServers, type McpProbeEntry, type McpProbeResult } from "@/lib/mcp-probe";

export const dynamic = "force-dynamic";

/**
 * MCP 服务器配置（~/.pi/agent/mcp.json）的列表 + 启用/禁用 + 连接探针。
 *
 * 服务器本体由 pi 内核的 MCP 内置扩展在**会话启动时**连接；本路由默认只碰配置文件，
 * 不改动运行中的会话（改动对新会话生效，或会话里 /reload）。
 * 注意：这里只负责「看得见、能开关」；新增/删除服务器仍走文件（由维护者代管）。
 *
 * `GET ?probe=1` 额外做一次**连接探针**：逐服务器临时建连 → listTools → close（见
 * `lib/mcp-probe.ts`），让插件页能显示「已连接 · N 工具 / 失败 · 原因 / 未配置」。
 * 不带 `probe` 的 GET 保持原样（只读文件、不拉起任何进程）。
 */

type McpServerConfig = {
  command?: string;
  args?: string[];
  url?: string;
  description?: string;
  enabled?: boolean;
  exposure?: string;
  timeout?: number;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  cwd?: string;
};

type McpConfigFile = { mcpServers?: Record<string, McpServerConfig> };

type McpServerInfo = {
  name: string;
  description?: string;
  enabled: boolean;
  transport: "stdio" | "http";
  target: string;
  /** 仅在 `?probe=1` 时出现 */
  status?: McpProbeResult;
};

function configPath(): string {
  return join(getAgentDir(), "mcp.json");
}

function readServers(): {
  servers: McpServerInfo[];
  entries: McpProbeEntry[];
  fileExists: boolean;
  error?: string;
} {
  const path = configPath();
  if (!existsSync(path)) return { servers: [], entries: [], fileExists: false };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as McpConfigFile;
    const map = parsed?.mcpServers ?? {};
    const entries = Object.entries(map).map(([name, cfg]): McpProbeEntry => ({
      name,
      enabled: cfg?.enabled !== false,
      config: (cfg ?? {}) as Record<string, unknown>,
    }));
    const servers = entries.map(({ name, enabled, config: cfg }): McpServerInfo => {
      const cfg2 = cfg as McpServerConfig;
      const transport: McpServerInfo["transport"] = typeof cfg2?.url === "string" ? "http" : "stdio";
      const target = transport === "http"
        ? cfg2.url ?? ""
        : [cfg2?.command ?? "", ...(cfg2?.args ?? [])].join(" ").trim();
      return {
        name,
        ...(typeof cfg2?.description === "string" && cfg2.description ? { description: cfg2.description } : {}),
        enabled,
        transport,
        target: target.length > 200 ? `${target.slice(0, 200)}…` : target,
      };
    });
    return { servers, entries, fileExists: true };
  } catch {
    return { servers: [], entries: [], fileExists: true, error: "mcp.json 解析失败" };
  }
}

/** GET /api/mcp-servers[?probe=1] —— 列出配置的 MCP 服务器（含启用状态；probe=1 时附连接态） */
export async function GET(req: Request) {
  try {
    const wantProbe = new URL(req.url).searchParams.get("probe") === "1";
    const data = readServers();
    if (!wantProbe || data.servers.length === 0) {
      return NextResponse.json(
        {
          servers: data.servers,
          fileExists: data.fileExists,
          path: configPath(),
          ...(data.error ? { error: data.error } : {}),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    // 探针是 best-effort：失败也返回配置态（status 为 unavailable），不把整个 GET 打挂
    let statuses = new Map<string, McpProbeResult>();
    try {
      statuses = await probeMcpServers(data.entries, process.cwd());
    } catch {
      statuses = new Map();
    }
    const servers = data.servers.map((server): McpServerInfo => ({
      ...server,
      status: server.enabled
        ? (statuses.get(server.name) ?? { state: "unavailable" })
        : { state: "disabled" },
    }));
    return NextResponse.json(
      {
        servers,
        fileExists: data.fileExists,
        path: configPath(),
        ...(data.error ? { error: data.error } : {}),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

/** POST /api/mcp-servers —— { action: "setEnabled", name, enabled } */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Expected application/json" }, { status: 415 });
  }
  try {
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      name?: string;
      enabled?: boolean;
    };
    if (body.action !== "setEnabled" || !body.name) {
      return NextResponse.json({ error: "未知操作" }, { status: 400 });
    }
    const path = configPath();
    if (!existsSync(path)) {
      return NextResponse.json({ error: "还没有 mcp.json" }, { status: 404 });
    }
    let parsed: McpConfigFile;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8")) as McpConfigFile;
    } catch {
      return NextResponse.json({ error: "mcp.json 解析失败，未改动" }, { status: 400 });
    }
    const entry = parsed.mcpServers?.[body.name];
    if (!entry) {
      return NextResponse.json({ error: `没有名为 ${body.name} 的服务器` }, { status: 404 });
    }
    entry.enabled = body.enabled !== false;
    writePrivateFileAtomicSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
    return NextResponse.json({ ...readServers() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
