import { NextResponse } from "next/server";
import { readFileSync, writeFileSync, renameSync, statSync } from "fs";
import { join } from "path";
import { isApiRequestAllowed } from "@/lib/request-security";
import { isNewerStableVersion } from "@/lib/app-update";

export const dynamic = "force-dynamic";

/**
 * 一键更新的「下单」与「进度」端点。
 *
 * 网页不能给自己做手术（重建要替换它脚下的文件并重启它），所以这里只负责：
 * - GET：报告更新状态（启动器写入 .elenva-update.json）与「是否有一键更新能力」
 *   （启动器心跳 .elenva-launcher.json 是否新鲜）；
 * - POST：把更新请求写进 .elenva-update.json，由启动器（start-launcher.js）
 *   轮询到后执行：拉取 → 安装依赖（按需）→ 停服务 → 重建（失败回滚）→ 重启。
 */

const STATE_FILE = join(process.cwd(), ".elenva-update.json");
const HEARTBEAT_FILE = join(process.cwd(), ".elenva-launcher.json");
const HEARTBEAT_FRESH_MS = 20_000;
const ACTIVE_PHASES = new Set(["requested", "pulling", "installing", "building", "restarting"]);
const CURRENT_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0";
const GITHUB_LATEST_RELEASE_URL = "https://api.github.com/repos/jjdeng-hub/elenva/releases/latest";

function readState(): Record<string, unknown> | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    return raw as Record<string, unknown>;
  } catch {
    return null;
  }
}

function launcherFresh(): boolean {
  try {
    return Date.now() - statSync(HEARTBEAT_FILE).mtimeMs < HEARTBEAT_FRESH_MS;
  } catch {
    return false;
  }
}

export async function GET() {
  const state = readState();
  return NextResponse.json({
    phase: typeof state?.phase === "string" ? state.phase : "idle",
    message: typeof state?.message === "string" ? state.message : "",
    targetVersion: typeof state?.targetVersion === "string" ? state.targetVersion : null,
    fromVersion: typeof state?.fromVersion === "string" ? state.fromVersion : null,
    toVersion: typeof state?.toVersion === "string" ? state.toVersion : null,
    updatedAt: typeof state?.updatedAt === "number" ? state.updatedAt : null,
    canApply: launcherFresh(),
    currentVersion: CURRENT_VERSION,
  });
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const state = readState();
  if (state && typeof state.phase === "string" && ACTIVE_PHASES.has(state.phase)) {
    return NextResponse.json({ error: "更新已在进行中" }, { status: 409 });
  }
  if (!launcherFresh()) {
    return NextResponse.json(
      { error: "未检测到启动器在运行：一键更新需要通过「生产模式.cmd」启动，由启动器执行" },
      { status: 409 },
    );
  }

  // 现查最新版本（不走 12h 缓存），避免用过期信息发起更新。
  let latest = "";
  try {
    const response = await fetch(GITHUB_LATEST_RELEASE_URL, {
      cache: "no-store",
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { tag_name?: unknown };
    latest = typeof body.tag_name === "string" ? body.tag_name.replace(/^v/, "") : "";
  } catch {
    return NextResponse.json({ error: "无法确认最新版本（GitHub 请求失败）" }, { status: 502 });
  }
  if (!latest || !isNewerStableVersion(latest, CURRENT_VERSION)) {
    return NextResponse.json({ error: "已是最新版本" }, { status: 400 });
  }

  const request = {
    phase: "requested",
    requestedAt: Date.now(),
    targetVersion: latest,
    fromVersion: CURRENT_VERSION,
    message: `已请求更新到 v${latest}，等待启动器执行…`,
  };
  try {
    const tmp = `${STATE_FILE}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(request, null, 2)}\n`);
    renameSync(tmp, STATE_FILE);
  } catch {
    return NextResponse.json({ error: "无法写入更新请求（磁盘？）" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, targetVersion: latest, message: request.message });
}
