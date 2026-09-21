import { NextResponse } from "next/server";
import { listAllSessions } from "@/lib/session-reader";
import { getRunningAgentSessionIds } from "@/lib/agent-runtime";
import { detectAttention } from "@/lib/attention";

export const dynamic = "force-dynamic";

/** Idle sessions that need attention (interrupted / tool error). */
export async function GET() {
  try {
    const sessions = await listAllSessions();
    const items = await detectAttention(sessions, new Set(getRunningAgentSessionIds()));
    return NextResponse.json({ items }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
