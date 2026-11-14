import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { hermesHome } from "@/lib/hermes-home";

export const dynamic = "force-dynamic";

/* ---------------- 常量 ---------------- */

const HERMES_BASE = "http://127.0.0.1:9119/api";
const TOKEN_FILE = path.join(hermesHome(), ".elenva-serve-token");
const AUDIT_FILE = path.join(os.homedir(), ".elenva", "audit.jsonl");
const READ_TIMEOUT_MS = 8_000;
const WRITE_TIMEOUT_MS = 30_000;
/** trigger 会真的跑一轮 Agent / 脚本，给 120s（见 docs/specs/2026-11-13-hermes-admin-api.md）。 */
const TRIGGER_TIMEOUT_MS = 120_000;

/**
 * 白名单。key = /api/hermes/ 之后的段模式，`*` 匹配单个段。
 * 明确排除：fs / files / env / gateway（安全边界，见 docs/specs/2026-11-13-hermes-admin-api.md）。
 */
const READ_ROUTES: string[] = [
  "health",
  "health/*",
  "ops/status",
  "cron/jobs",
  "cron/jobs/*/runs",
  "cron/delivery-targets",
  "skills",
  "auth/me",
];

/** 写方法策略表（P4b 放行 cron 写路由）。写请求必须带 confirm，否则 428。 */
const WRITE_ROUTES: string[] = [
  "cron/jobs", // POST 创建
  "cron/jobs/*", // PATCH 修改 / DELETE 删除
  "cron/jobs/*/trigger", // POST 立即执行
  "cron/jobs/*/pause", // POST 暂停
  "cron/jobs/*/resume", // POST 恢复
];

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
  detail?: string;
}): Promise<void> {
  try {
    const text = JSON.stringify({ ts: new Date().toISOString(), ...line }) + "\n";
    await fsp.appendFile(AUDIT_FILE, text, "utf8");
  } catch {
    /* 审计写失败不阻塞主流程 */
  }
}

/* ---------------- 写锁（进程内串行化） ---------------- */

let writeChain: Promise<unknown> = Promise.resolve();

/** 串行执行写操作：同一进程内一次只有一个写请求在向上游跑。 */
function serializeWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => undefined);
  return run;
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

function err(code: string, message: string, status: number, detail?: string): NextResponse {
  return NextResponse.json({ error: { code, message, ...(detail ? { detail } : {}) } }, { status, headers: { "Cache-Control": "no-store" } });
}

/** confirm: true（body 字段）或 X-Elenva-Confirm: 1（header，DELETE 等 bodyless 方法用）。 */
async function hasConfirm(request: NextRequest, bodyText: string | null): Promise<boolean> {
  if (request.headers.get("X-Elenva-Confirm") === "1") return true;
  if (!bodyText) return false;
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (parsed && typeof parsed === "object" && "confirm" in parsed) {
      return (parsed as { confirm?: unknown }).confirm === true;
    }
  } catch {
    /* 非 JSON body 视为未确认 */
  }
  return false;
}

/** 转发前把客户端的 confirm 标记剥掉——上游 Pydantic 不认识它，PATCH 的 updates 里更不能混进去。 */
function stripConfirmFields(bodyText: string | null): string | null {
  if (!bodyText) return null;
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null) return bodyText;
    delete parsed.confirm;
    delete parsed._confirm;
    return JSON.stringify(parsed);
  } catch {
    return bodyText;
  }
}

/* ---------------- 处理器 ---------------- */

async function handle(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;
  const segments = pathname.replace(/^\/api\/hermes\/?/, "").split("/").filter(Boolean);
  const routeKey = segments.join("/");
  const method = request.method.toUpperCase();
  const started = Date.now();

  if (!matchRoute(segments, READ_ROUTES) && !matchRoute(segments, WRITE_ROUTES)) {
    void audit({ action: "hermes-proxy", path: routeKey, method, result: "denied", ms: Date.now() - started });
    return err("not_allowed", `路由不在 Hermes 代理白名单：${routeKey}`, 403);
  }

  const isWrite = method !== "GET" && method !== "HEAD";
  if (!isWrite && !matchRoute(segments, READ_ROUTES)) {
    void audit({ action: "hermes-proxy", path: routeKey, method, result: "denied", ms: Date.now() - started });
    return err("not_allowed", `路由不在 Hermes 代理白名单：${routeKey}`, 403);
  }

  // 写请求：读 body 一次（后面转发复用），校验 confirm，串行化
  let bodyText: string | null = null;
  if (isWrite) {
    if (!matchRoute(segments, WRITE_ROUTES)) {
      void audit({ action: "hermes-proxy", path: routeKey, method, result: "denied", ms: Date.now() - started });
      return err("write_not_allowed", "该路由未开放写操作", 428);
    }
    if (method !== "DELETE") {
      bodyText = await request.text();
    }
    if (!(await hasConfirm(request, bodyText))) {
      void audit({ action: "hermes-write", path: routeKey, method, result: "denied", ms: Date.now() - started });
      return err("confirm_required", "写操作需要二次确认：body 带 confirm:true 或 header X-Elenva-Confirm:1", 428);
    }
    bodyText = stripConfirmFields(bodyText);
  }

  const token = await readToken();
  if (!token) return err("token_missing", "Hermes 令牌文件缺失", 503);

  const timeoutMs = segments.includes("trigger") ? TRIGGER_TIMEOUT_MS : isWrite ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS;

  const doFetch = async (): Promise<NextResponse> => {
    try {
      const upstream = await fetch(`${HERMES_BASE}/${segments.join("/")}${search}`, {
        method,
        headers: {
          "X-Hermes-Session-Token": token,
          ...(bodyText !== null ? { "Content-Type": "application/json" } : {}),
        },
        body: bodyText,
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
      const body = await upstream.text();
      void audit({
        action: isWrite ? "hermes-write" : "hermes-proxy",
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
      const timedOut = detail.includes("timeout") || detail.includes("aborted") || detail.includes("TimeoutError");
      void audit({
        action: isWrite ? "hermes-write" : "hermes-proxy",
        path: routeKey,
        method,
        result: "error",
        status: timedOut ? 504 : 503,
        ms: Date.now() - started,
        detail,
      });
      return NextResponse.json(
        {
          error: {
            code: timedOut ? "upstream_timeout" : "backend_down",
            message: timedOut
              ? `上游请求超时（${Math.round(timeoutMs / 1000)}s）——trigger 的运行可能仍在后台进行，以运行记录为准`
              : "Hermes 后端不可达",
            detail,
          },
        },
        { status: timedOut ? 504 : 503, headers: { "Cache-Control": "no-store" } },
      );
    }
  };

  return isWrite ? serializeWrite(doFetch) : doFetch();
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
