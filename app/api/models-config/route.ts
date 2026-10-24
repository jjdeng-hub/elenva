import { NextResponse } from "next/server";
import { readModelsConfig, validateModelsConfig, writeModelsConfig } from "@/lib/models-config-store";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function GET() {
  return NextResponse.json(readModelsConfig());
}

export async function PUT(req: Request) {
  try {
    const body = (await req.json()) as unknown;
    if (!isRecord(body) || !isRecord(body.providers)) {
      return NextResponse.json({ error: "请求体必须是 { providers: { … } }" }, { status: 400 });
    }
    for (const [providerId, provider] of Object.entries(body.providers)) {
      if (!isRecord(provider)) {
        return NextResponse.json({ error: `厂商「${providerId}」必须是对象` }, { status: 400 });
      }
      if (provider.models !== undefined && !Array.isArray(provider.models)) {
        return NextResponse.json({ error: `厂商「${providerId}」的 models 必须是数组` }, { status: 400 });
      }
    }
    // 写入前先用内核加载器验一遍：`models.json` 是「整份全通过或整份失败」，
    // 一条缺 `api` 的配置会让整个模型库加载不出来，界面上常驻「模型库加载失败」，
    // 而用户没有就地修复的入口（2026-10-24 实测：测试数据 `bad`/`ok-model`）。
    const loadError = await validateModelsConfig(body);
    if (loadError) {
      return NextResponse.json({ error: `模型库校验未通过：${loadError}` }, { status: 400 });
    }
    writeModelsConfig(body);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
