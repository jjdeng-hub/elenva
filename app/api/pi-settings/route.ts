import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readModelsConfig } from "@/lib/models-config-store";
import { aggregateModelHealth } from "@/lib/model-health";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { readManagedSettings, validateManagedPatch, writeManagedSettings } from "@/lib/pi-user-settings";

export const dynamic = "force-dynamic";

/** GET /api/pi-settings → 受管的 ~/.pi/agent/settings.json 子集 */
export async function GET() {
  try {
    return NextResponse.json(readManagedSettings());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

/**
 * 已配置的 provider id 集合——写 `defaultProvider` 时的准入名单（模块 6 修复轮 B4）。
 *
 * 三个来源合起来才是"已配置"：
 * - 内核内置厂商目录（pi-ai providers/all）
 * - `models.json` 里的自定义 Provider（中转站 / 自建网关）
 * - `auth.json` 里已存凭据的条目（含目录外条目）
 *
 * 读不到某一来源时按空集处理：宁可误拒（用户会看到明确报错，且能改成有效值），
 * 也不放一个不存在的 provider 静默落盘。
 */
async function resolveKnownProviderIds(): Promise<Set<string>> {
  const known = new Set<string>();
  try {
    const all = (await import("@earendil-works/pi-ai/providers/all")) as {
      getBuiltinProviders?: () => string[];
    };
    for (const id of all.getBuiltinProviders?.() ?? []) known.add(id);
  } catch {
    /* 目录导入失败：只靠下面两份文件里的条目 */
  }
  try {
    const models = readModelsConfig();
    const providers = models.providers;
    if (providers !== null && typeof providers === "object" && !Array.isArray(providers)) {
      for (const id of Object.keys(providers as Record<string, unknown>)) known.add(id);
    }
  } catch {
    /* models.json 缺失/损坏：忽略 */
  }
  try {
    const authPath = join(getAgentDir(), "auth.json");
    if (existsSync(authPath)) {
      const parsed: unknown = JSON.parse(readFileSync(authPath, "utf8"));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const id of Object.keys(parsed as Record<string, unknown>)) known.add(id);
      }
    }
  } catch {
    /* auth.json 缺失/损坏：忽略 */
  }
  return known;
}

/** PUT /api/pi-settings → 校验并合并写入受管子集 */
export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = (await req.json()) as Record<string, unknown>;

    /* 坏默认拦截（B2）：把 `status=failing`（近 14 天成功率 <90% 且有近期失败）的模型
       设为启动默认时**不静默接受**——要么带 `confirmUnhealthy: true` 二次确认，
       要么由界面改选。健康数据即 `/api/model-health` 的同一份聚合（60s 缓存）。 */
    const wantsDefault = typeof body.defaultProvider === "string" && typeof body.defaultModel === "string";
    if (wantsDefault && body.confirmUnhealthy !== true) {
      const health = aggregateModelHealth().models.find(
        (entry) => entry.provider === body.defaultProvider && entry.model === body.defaultModel,
      );
      if (health?.status === "failing") {
        return NextResponse.json(
          {
            error: `「${health.model}」近 14 天成功率 ${Math.round(health.successRate * 100)}%（${health.calls} 次调用 / ${health.failures} 次失败）`
              + `${health.lastError ? `，最近失败：${health.lastError}` : ""}。仍要设为启动默认吗？`,
            code: "unhealthy_model",
            health: {
              provider: health.provider,
              model: health.model,
              calls: health.calls,
              failures: health.failures,
              successRate: health.successRate,
              lastFailureAt: health.lastFailureAt,
              lastError: health.lastError,
            },
          },
          { status: 409 },
        );
      }
    }

    const patch = validateManagedPatch(body, { knownProviders: await resolveKnownProviderIds() });
    writeManagedSettings(patch);
    return NextResponse.json(readManagedSettings());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
