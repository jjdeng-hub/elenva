import { NextResponse } from "next/server";
import { findAgent } from "@/lib/agents/manifest";
import { listAgents } from "@/lib/agents/registry";
import {
  listHermesSessions,
  listHermesSkills,
  readHermesMemories,
  readHermesMessages,
  readRhythm,
  readSoul,
  readUsage,
  writeSoul,
} from "@/lib/agents/resources";

export const dynamic = "force-dynamic";

/**
 * GET /api/agents/resources?id=<agentId>&kind=sessions|messages|memory|skills[&session=<id>]
 *
 * 应用包 Agent 的资源（只读）。目前只支持 Hermes 运行时：pi 的会话/记忆/技能
 * 已经在平台自己的页面里了，不需要这条通道。
 */
export async function PUT(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const id = String(body.id ?? "");
  const content = typeof body.content === "string" ? body.content : null;
  if (!id || content === null) return NextResponse.json({ error: "id / content 必填" }, { status: 400 });

  const agent = findAgent(listAgents().agents, id);
  if (!agent) return NextResponse.json({ error: "Agent 不存在" }, { status: 404 });
  if (agent.runtime !== "hermes") {
    return NextResponse.json({ error: "只有 Hermes 运行时的 Agent 走这条写入" }, { status: 400 });
  }

  const result = writeSoul(agent.profile ?? agent.id, content);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  // SOUL 是稳定层第 1 段：改完要新会话（或下一次压缩）才生效
  return NextResponse.json({ ok: true, bytes: result.bytes, backup: result.backup, note: "已写入；新会话才会读到新 SOUL" });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const kind = url.searchParams.get("kind") ?? "sessions";
  const session = url.searchParams.get("session") ?? "";
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const agent = findAgent(listAgents().agents, id);
  if (!agent) return NextResponse.json({ error: "Agent 不存在" }, { status: 404 });
  if (agent.runtime !== "hermes") {
    return NextResponse.json({ error: `这个 Agent 的运行时是 ${agent.runtime}，资源走平台页面` }, { status: 400 });
  }

  const profile = agent.profile ?? agent.id;
  try {
    if (kind === "sessions") {
      return NextResponse.json({ profile, sessions: await listHermesSessions(profile) }, { headers: { "Cache-Control": "no-store" } });
    }
    if (kind === "messages") {
      if (!session) return NextResponse.json({ error: "session required" }, { status: 400 });
      return NextResponse.json({ profile, messages: await readHermesMessages(profile, session) }, { headers: { "Cache-Control": "no-store" } });
    }
    if (kind === "memory") {
      return NextResponse.json({ profile, files: readHermesMemories(profile) }, { headers: { "Cache-Control": "no-store" } });
    }
    if (kind === "skills") {
      return NextResponse.json({ profile, skills: listHermesSkills(profile) }, { headers: { "Cache-Control": "no-store" } });
    }
    if (kind === "soul") {
      const soul = readSoul(profile);
      return NextResponse.json({ profile, soul }, { headers: { "Cache-Control": "no-store" } });
    }
    if (kind === "rhythm") {
      return NextResponse.json({ profile, jobs: readRhythm(profile) }, { headers: { "Cache-Control": "no-store" } });
    }
    if (kind === "usage") {
      return NextResponse.json({ profile, usage: await readUsage(profile) }, { headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ error: `未知的 kind：${kind}` }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
