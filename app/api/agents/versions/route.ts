import { NextResponse } from "next/server";
import { findAgent } from "@/lib/agents/manifest";
import { listAgents } from "@/lib/agents/registry";
import { listVersions, restoreVersion } from "@/lib/agents/data-store";
import { findBlockByDataPath } from "@/lib/agents/workspace";

export const dynamic = "force-dynamic";

/**
 * 历史版本。
 *
 * GET  ?id=&path=                列出这个文件的历次自动备份（最新在前）
 * POST {id, path, name, revision} 把某一份写回正文（写前仍会备份当前内容，恢复也能后悔）
 *
 * 只对 manifest 声明过的路径开放 —— 与写入通道同一道门。
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const path = url.searchParams.get("path");
  if (!id || !path) return NextResponse.json({ error: "id 与 path 必填" }, { status: 400 });

  const agent = findAgent(listAgents().agents, id);
  if (!agent?.dir) return NextResponse.json({ error: "Agent 不存在或没有应用包目录" }, { status: 404 });
  if (!findBlockByDataPath(agent.views ?? [], path)) {
    return NextResponse.json({ error: "该文件没有在 manifest 的 views 里声明" }, { status: 400 });
  }

  return NextResponse.json(
    { path, versions: listVersions(agent.dir, path) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const id = String(body.id ?? "");
  const path = String(body.path ?? "");
  const name = String(body.name ?? "");
  const revision = typeof body.revision === "string" ? body.revision : undefined;
  if (!id || !path || !name) return NextResponse.json({ error: "id / path / name 必填" }, { status: 400 });

  const agent = findAgent(listAgents().agents, id);
  if (!agent?.dir) return NextResponse.json({ error: "Agent 不存在或没有应用包目录" }, { status: 404 });
  if (!findBlockByDataPath(agent.views ?? [], path)) {
    return NextResponse.json({ error: "该文件没有在 manifest 的 views 里声明" }, { status: 400 });
  }

  const result = restoreVersion(agent.dir, path, name, { expectedRevision: revision });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, revision: "revision" in result ? result.revision : undefined },
      { status: result.status },
    );
  }
  return NextResponse.json({ ok: true, path: result.path, revision: result.revision });
}
