import { NextResponse } from "next/server";
import { findAgent } from "@/lib/agents/manifest";
import { listAgents } from "@/lib/agents/registry";
import { parseSchema, validateData } from "@/lib/agents/data-schema";
import { readAgentFile, writeAgentFile } from "@/lib/agents/data-store";
import { findBlockByDataPath } from "@/lib/agents/workspace";

export const dynamic = "force-dynamic";

const MAX_BODY = 512 * 1024;

/**
 * Agent 数据文件的读与写。
 *
 * GET  ?id=&path=                       读单个文件（doc 块打开某篇草稿时用）
 * PUT  {id, path, content, revision}    写回；revision 是并发闸门
 *
 * 写入只允许落在 **manifest 里声明过** 的位置：JSON 必须是某个块的 `source`，
 * Markdown 必须落在 doc 块的 `source` 目录内。没有声明＝没有写入口 ——
 * 否则界面就成了一个能往应用包里随便写文件的洞。
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const path = url.searchParams.get("path");
  if (!id || !path) return NextResponse.json({ error: "id 与 path 必填" }, { status: 400 });

  const agent = findAgent(listAgents().agents, id);
  if (!agent?.dir) return NextResponse.json({ error: "Agent 不存在或没有应用包目录" }, { status: 404 });

  const file = readAgentFile(agent.dir, path);
  if (!file.ok) return NextResponse.json({ error: file.error }, { status: file.status });
  return NextResponse.json(
    { path: file.path, content: file.content, revision: file.revision, size: file.size },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function PUT(req: Request) {
  let body: Record<string, unknown>;
  try {
    const raw = await req.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY) {
      return NextResponse.json({ error: "请求体过大" }, { status: 413 });
    }
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const id = String(body.id ?? "");
  const path = String(body.path ?? "");
  const content = typeof body.content === "string" ? body.content : null;
  const revision = typeof body.revision === "string" ? body.revision : undefined;
  if (!id || !path || content === null) {
    return NextResponse.json({ error: "id / path / content 必填" }, { status: 400 });
  }

  const agent = findAgent(listAgents().agents, id);
  if (!agent?.dir) return NextResponse.json({ error: "Agent 不存在或没有应用包目录" }, { status: 404 });

  const block = findBlockByDataPath(agent.views ?? [], path);
  if (!block) {
    return NextResponse.json(
      { error: "该文件没有在 manifest 的 views 里声明，界面不写入" },
      { status: 400 },
    );
  }

  if (path.toLowerCase().endsWith(".json")) {
    let data: unknown;
    try {
      data = JSON.parse(content);
    } catch (error) {
      return NextResponse.json({ error: `不是合法 JSON：${String(error)}` }, { status: 400 });
    }

    if (block.schema) {
      const schemaFile = readAgentFile(agent.dir, block.schema);
      if (!schemaFile.ok) {
        return NextResponse.json({ error: `读取契约失败：${schemaFile.error}` }, { status: 500 });
      }
      let rawSchema: unknown;
      try {
        rawSchema = JSON.parse(schemaFile.content);
      } catch (error) {
        return NextResponse.json({ error: `契约不是合法 JSON：${String(error)}` }, { status: 500 });
      }
      const parsed = parseSchema(rawSchema);
      if (!parsed.ok) return NextResponse.json({ error: `契约无效：${parsed.error}` }, { status: 500 });
      const result = validateData(parsed.schema, data);
      if (!result.ok) {
        return NextResponse.json({ error: "数据不满足契约", details: result.errors }, { status: 400 });
      }
    }
  }

  const written = writeAgentFile(agent.dir, path, content, { expectedRevision: revision, actor: "ui" });
  if (!written.ok) {
    return NextResponse.json(
      { error: written.error, revision: "revision" in written ? written.revision : undefined },
      { status: written.status },
    );
  }
  return NextResponse.json({ ok: true, path: written.path, revision: written.revision });
}
