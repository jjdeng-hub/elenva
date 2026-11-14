import { NextResponse } from "next/server";
import { findAgent } from "@/lib/agents/manifest";
import { listAgents } from "@/lib/agents/registry";
import { normalizePanelData } from "@/lib/agents/panels";
import { listMarkdownFiles, readAgentFile } from "@/lib/agents/data-store";
import { listFilms } from "@/lib/agents/film";
import { asPanelType, isDocBlock, type AgentBlock } from "@/lib/agents/workspace";

export const dynamic = "force-dynamic";

/**
 * GET /api/agents/workspace?id=<agentId> —— 该 Agent 的整个工作台（views + 每块的数据）。
 *
 * 一次取全：切 view 不再发请求，慢的只有 Agent 自己写盘之后的刷新。
 * 单块读失败只影响那一块（带 `error` 字段），不让整页变错误页。
 */
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  try {
    const { agents } = listAgents();
    const agent = findAgent(agents, id);
    if (!agent) return NextResponse.json({ error: "Agent 不存在" }, { status: 404 });

    const root = agent.dir;
    const views = (agent.views ?? []).map((view) => ({
      view: { id: view.id, title: view.title },
      blocks: !root
        ? view.blocks.map((block) => withBlock(block, { error: "内置 Agent 没有应用包目录" }))
        : view.blocks.map((block) => readBlock(root, block)),
    }));

    return NextResponse.json(
      {
        agent: {
          id: agent.id,
          name: agent.name,
          runtime: agent.runtime,
          profile: agent.profile ?? agent.id,
        },
        views,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

function withBlock(block: AgentBlock, extra: Record<string, unknown>) {
  return {
    id: block.id,
    title: block.title,
    type: block.type,
    source: block.source,
    schema: block.schema,
    editable: block.editable,
    emptyHint: block.emptyHint,
    actions: block.actions,
    ...extra,
  };
}

function readBlock(root: string, block: AgentBlock) {
  const base = withBlock(block, {});

  if (!block.source) return { ...base, error: "未声明数据来源" };

  if (isDocBlock(block)) {
    const files = listMarkdownFiles(root, block.source);
    return { ...base, files };
  }

  if (block.type === "film") {
    return { ...base, films: listFilms(root, block.source) };
  }

  const panelType = asPanelType(block.type);
  if (!panelType) return { ...base, error: `未知块类型：${block.type}` };

  const file = readAgentFile(root, block.source);
  if (!file.ok) return { ...base, error: file.error };
  try {
    return { ...base, data: normalizePanelData(panelType, JSON.parse(file.content)), revision: file.revision };
  } catch (error) {
    return { ...base, error: `数据不是合法 JSON：${String(error)}` };
  }
}
