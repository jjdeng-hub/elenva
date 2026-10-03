import { NextResponse } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "@/lib/atomic-file";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

/**
 * MCP 服务器配置（~/.pi/agent/mcp.json）的列表 + 启用/禁用。
 *
 * 服务器本体由 pi 内核的 MCP 内置扩展在**会话启动时**连接；本路由只碰配置文件，
 * 不改动运行中的会话（改动对新会话生效，或会话里 /reload）。
 * 注意：这里只负责「看得见、能开关」；新增/删除服务器仍走文件（由维护者代管）。
 */

type McpServerConfig = {
  command?: string;
  args?: string[];
  url?: string;
  description?: string;
  enabled?: boolean;
};

type McpConfigFile = { mcpServers?: Record<string, McpServerConfig> };

type McpServerInfo = {
  name: string;
  description?: string;
  enabled: boolean;
  transport: "stdio" | "http";
  target: string;
};

function configPath(): string {
  return join(getAgentDir(), "mcp.json");
}

function readServers(): { servers: McpServerInfo[]; fileExists: boolean; error?: string } {
  const path = configPath();
  if (!existsSync(path)) return { servers: [], fileExists: false };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as McpConfigFile;
    const map = parsed?.mcpServers ?? {};
    const servers = Object.entries(map).map(([name, cfg]): McpServerInfo => {
      const transport: McpServerInfo["transport"] = typeof cfg?.url === "string" ? "http" : "stdio";
      const target = transport === "http"
        ? cfg.url ?? ""
        : [cfg?.command ?? "", ...(cfg?.args ?? [])].join(" ").trim();
      return {
        name,
        ...(typeof cfg?.description === "string" && cfg.description ? { description: cfg.description } : {}),
        enabled: cfg?.enabled !== false,
        transport,
        target: target.length > 200 ? `${target.slice(0, 200)}…` : target,
      };
    });
    return { servers, fileExists: true };
  } catch {
    return { servers: [], fileExists: true, error: "mcp.json 解析失败" };
  }
}

/** GET /api/mcp-servers —— 列出配置的 MCP 服务器（含启用状态） */
export async function GET() {
  try {
    return NextResponse.json(
      { ...readServers(), path: configPath() },
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
