import { NextResponse } from "next/server";
import { deleteProviderAuth, listProviderAuthStatus, setProviderApiKey } from "@/lib/pi-auth";
import { invalidateModelsCache } from "@/lib/models-cache";

export const dynamic = "force-dynamic";

/** GET /api/auth —— 内置厂商目录 + 各厂商凭据状态 */
export async function GET() {
  try {
    const providers = await listProviderAuthStatus();
    return NextResponse.json({ providers });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

/** PUT /api/auth —— 保存某厂商的 API Key（写入 ~/.pi/agent/auth.json，0600） */
export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as { provider?: string; key?: string };
    if (!body.provider || typeof body.key !== "string") {
      return NextResponse.json({ error: "需要 provider 与 key" }, { status: 400 });
    }
    await setProviderApiKey(body.provider, body.key);
    // 模型列表缓存 TTL 60s：不失效的话，刚配好的厂商要等一分钟才出现在模型选择器里
    invalidateModelsCache();
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

/** DELETE /api/auth?provider=xxx —— 删除某厂商的凭据 */
export async function DELETE(request: Request) {
  try {
    const provider = new URL(request.url).searchParams.get("provider");
    if (!provider) return NextResponse.json({ error: "需要 provider 参数" }, { status: 400 });
    await deleteProviderAuth(provider);
    invalidateModelsCache();
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
