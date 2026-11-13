import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/* ---------------- 常量 ---------------- */

const HERMES_BASE = "http://127.0.0.1:9119/api";
const TOKEN_FILE = path.join(os.homedir(), ".hermes", ".elenva-serve-token");
const AUDIT_FILE = path.join(os.homedir(), ".elenva", "audit.jsonl");
const READ_TIMEOUT_MS = 8_000;

/**
 * 白名单（第一步只读）。key = /api/hermes/ 之后的段模式，`*` 匹配单个段。
 * 明确排除：fs / files / env / gateway（安全边界，见 docs/specs/2026-11-13-hermes-admin-api.md）。
 */
const READ_ROUTES: string[] = [
  "health",
  "health/*",
  "ops/status",
  "cron/jobs",
  "cron/jobs/*/runs",
  "skills",
  "auth/me",
];

/** 写方法策略表：本步全部拒绝（428），机制先建好，后续步骤填路由。 */
const WRITE_ROUTES: string[] = [];

function matchRoute(segments: string[], patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const parts = pattern.split("/");
    if (parts.length !== segments.length) return false;
    return parts.every((p, i) => p === "*" || p === segments[i]);
  });
}

/* ---------------- 审计 ---------------- */

async function audit(line: {
  action: string;
  path: string;
  method: string;
  result: "ok" | "denied" | "error";
  status?: number;
  ms?: number;
}): Promise<void> {
  try {
    const text = JSON.stringify({ ts: new Date().toISOString(), ...line }) + "\n";
    await fsp.appendFile(AUDIT_FILE, text, "utf8");
  } catch {
    /* 审计写失败不阻塞主流程 */
  }
}

/* ---------------- 工具 ---------------- */

async function readToken(): Promise<string | null> {
  try {
    const token = (await fsp.readFile(TOKEN_FILE, "utf8")).trim();
    return token || null;
  } catch {
    return null;
  }
}

function err(code: string, message: string, status: number): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}

/* ---------------- 处理器 ---------------- */

async function handle(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;
  const segments = pathname.replace(/^\/api\/hermes\/?/, "").split("/").filter(Boolean);
  const routeKey = segments.join("/");
  const method = request.method.toUpperCase();
  const started = Date.now();

  // 写方法策略：白名单里的写路由需要 confirm，其余写方法一律 428（本步无写路由，全部 428）
  if (method !== "GET" && method !== "HEAD") {
    if (!matchRoute(segments, WRITE_ROUTES)) {
      void audit({ action: "hermes-proxy", path: routeKey, method, result: "denied", ms: Date.now() - started });
      return err("write_not_allowed", "Hermes 代理本阶段只读（写通道待后续开放）", 428);
    }
    // TODO(后续步骤)：WRITE_ROUTES 填充后在这里做 confirm 校验 + 写锁 + 写审计
  }

  if (!matchRoute(segments, READ_ROUTES)) {
    void audit({ action: "hermes-proxy", path: routeKey, method, result: "denied", ms: Date.now() - started });
    return err("not_allowed", `路由不在 Hermes 代理白名单：${routeKey}`, 403);
  }

  const token = await readToken();
  if (!token) return err("token_missing", "Hermes 令牌文件缺失", 503);

  try {
    const upstream = await fetch(`${HERMES_BASE}/${segments.join("/")}${search}`, {
      method,
      headers: { "X-Hermes-Session-Token": token },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      cache: "no-store",
    });
    const body = await upstream.text();
    void audit({
      action: "hermes-proxy",
      path: routeKey,
      method,
      result: "ok",
      status: upstream.status,
      ms: Date.now() - started,
    });
    return new NextResponse(body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    void audit({
      action: "hermes-proxy",
      path: routeKey,
      method,
      result: "error",
      status: 503,
      ms: Date.now() - started,
    });
    return NextResponse.json(
      { error: { code: "backend_down", message: "Hermes 后端不可达", detail } },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function HEAD(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}

export async function PATCH(request: NextRequest) {
  return handle(request);
}

export async function PUT(request: NextRequest) {
  return handle(request);
}

export async function DELETE(request: NextRequest) {
  return handle(request);
}
