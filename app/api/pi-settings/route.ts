import { NextResponse } from "next/server";
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

/** PUT /api/pi-settings → 校验并合并写入受管子集 */
export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = await req.json();
    const patch = validateManagedPatch(body);
    writeManagedSettings(patch);
    return NextResponse.json(readManagedSettings());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
