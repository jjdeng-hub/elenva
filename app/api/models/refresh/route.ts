import { join } from "node:path";
import { NextResponse } from "next/server";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { invalidateModelsCache } from "@/lib/models-cache";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

/**
 * 强制刷新模型目录（pi.dev 的上游目录 → 本地 models-store.json 缓存）。
 *
 * 为什么需要这个端点：应用内所有会话都通过 `createAgentSessionServices`
 * 构造 ModelRuntime，而它在 `allowModelNetwork` 缺省为 false 的情况下**不会联网**，
 * 只会读本地 models-store.json 缓存。所以厂商上新模型后，界面里永远看不到，
 * 除非用户手动刷新（或去跑一次 pi CLI）。
 *
 * `force: true` 会绕过内核的新鲜度门槛（REMOTE_CATALOG_REFRESH_INTERVAL_MS）立即请求。
 */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const agentDir = getAgentDir();
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      allowModelNetwork: true,
    });

    const before = (await runtime.getAvailable()).length;
    const result = await runtime.refresh({ allowNetwork: true, force: true });
    const after = (await runtime.getAvailable()).length;

    // 应用侧的 60s 缓存里存的是旧清单，必须作废。
    invalidateModelsCache();

    return NextResponse.json({
      ok: !result.aborted,
      aborted: result.aborted,
      before,
      after,
      added: Math.max(0, after - before),
      errors: [...result.errors].map(([provider, error]) => ({
        provider,
        message: error instanceof Error ? error.message : String(error),
      })),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "刷新失败" },
      { status: 502 },
    );
  }
}
