import { NextResponse } from "next/server";
import { getSystemStatus } from "@/lib/system-status";

export const dynamic = "force-dynamic";

/** 系统页只读快照（服务/门禁/备份/版本/部署/资源）。 */
export async function GET() {
  try {
    const status = await getSystemStatus();
    return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
