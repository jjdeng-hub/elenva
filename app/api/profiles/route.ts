import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import {
  appendAudit,
  discoverProfiles,
  invalidateProfilesCache,
  PROFILE_ID_RE,
} from "@/lib/profiles";

export const dynamic = "force-dynamic";

/**
 * Hermes profile 名册 API（P3a：发现 + 接入/断开；不做创建/删除）。
 *
 * GET                → 发现列表（含接入状态、会话数、最后活动）
 * POST {action,id}   → connect / disconnect
 *   connect    = 写 ~/.elenva/agents/<id>/manifest.json
 *   disconnect = 删该应用包目录（Hermes 数据一条不动）
 */
export async function GET() {
  try {
    const profiles = await discoverProfiles();
    return NextResponse.json({ profiles }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

interface ConnectBody {
  action?: string;
  id?: string;
}

export async function POST(req: Request) {
  let body: ConnectBody;
  try {
    body = (await req.json()) as ConnectBody;
  } catch {
    return NextResponse.json({ error: "body 不是 JSON" }, { status: 400 });
  }

  const action = body.action?.trim();
  const id = body.id?.trim() ?? "";
  if (action !== "connect" && action !== "disconnect") {
    return NextResponse.json({ error: "action 只支持 connect / disconnect" }, { status: 400 });
  }
  // 路径穿越防线：id 必须过名册同款规则，拒绝任何 / .. 变体
  if (!PROFILE_ID_RE.test(id)) {
    return NextResponse.json({ error: `profile id 不合法：${id || "(空)"}` }, { status: 400 });
  }

  const profiles = await discoverProfiles();
  const profile = profiles.find((entry) => entry.id === id);
  if (!profile) {
    return NextResponse.json({ error: `profile 不存在：${id}` }, { status: 404 });
  }

  const agentsRootDir = path.join(process.env.HOME ?? "", ".elenva", "agents");
  const packageDir = path.join(agentsRootDir, id);

  if (action === "connect") {
    if (profile.connected) {
      return NextResponse.json({ error: `profile 已接入：${id}` }, { status: 409 });
    }
    if (!profile.available) {
      return NextResponse.json({ error: `profile 不可用（缺 config.yaml）：${id}` }, { status: 409 });
    }
    const manifest = {
      id,
      name: profile.displayName,
      runtime: "hermes",
      profile: id,
      version: "0.1.0",
    };
    try {
      fs.mkdirSync(packageDir, { recursive: true });
      fs.writeFileSync(path.join(packageDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    } catch (error) {
      appendAudit({ ts: new Date().toISOString(), action: "connect", profile: id, result: "error", detail: String(error) });
      return NextResponse.json({ error: `写 manifest 失败：${String(error)}` }, { status: 500 });
    }
    invalidateProfilesCache();
    appendAudit({ ts: new Date().toISOString(), action: "connect", profile: id, result: "ok" });
    return NextResponse.json({ ok: true, manifest });
  }

  // disconnect：删包目录（二次确认由界面负责；这里只删 manifest 所在的包目录）
  const manifestPath = path.join(packageDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return NextResponse.json({ error: `profile 未接入 ELENVA：${id}` }, { status: 409 });
  }
  try {
    // 只删 ELENVA 自己的应用包目录，绝不上溯、绝不碰 ~/.hermes
    fs.rmSync(packageDir, { recursive: true, force: true });
  } catch (error) {
    appendAudit({ ts: new Date().toISOString(), action: "disconnect", profile: id, result: "error", detail: String(error) });
    return NextResponse.json({ error: `删除应用包失败：${String(error)}` }, { status: 500 });
  }
  invalidateProfilesCache();
  appendAudit({ ts: new Date().toISOString(), action: "disconnect", profile: id, result: "ok" });
  return NextResponse.json({ ok: true });
}
