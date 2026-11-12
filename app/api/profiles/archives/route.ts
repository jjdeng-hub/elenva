import { NextResponse } from "next/server";
import { listArchives } from "@/lib/profiles-mutate";

export const dynamic = "force-dynamic";

/** GET /api/profiles/archives —— 回收站：~/.hermes/backups/profiles/*.tar.gz 清单。 */
export async function GET() {
  return NextResponse.json({ archives: listArchives() }, { headers: { "Cache-Control": "no-store" } });
}
