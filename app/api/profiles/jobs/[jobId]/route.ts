import { NextResponse } from "next/server";
import { getProfileJob } from "@/lib/profiles-mutate";

export const dynamic = "force-dynamic";

/** GET /api/profiles/jobs/<jobId> —— 创建任务轮询（status / step / error）。 */
export async function GET(_req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const job = getProfileJob(jobId);
  if (!job) return NextResponse.json({ error: `任务不存在：${jobId}` }, { status: 404 });
  return NextResponse.json(job, { headers: { "Cache-Control": "no-store" } });
}
