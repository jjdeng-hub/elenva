import { NextResponse } from "next/server";
import { getSessionListVersion } from "@/lib/session-reader";
import {
  getCompletionNotificationSuppressedAgentSessionIds,
  getRunningAgentSessionIds,
} from "@/lib/agent-runtime";

export const dynamic = "force-dynamic";

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
export async function GET() {
  return NextResponse.json(
    {
      sessionListVersion: getSessionListVersion(),
      runningSessionIds: getRunningAgentSessionIds(),
      completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedAgentSessionIds(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
