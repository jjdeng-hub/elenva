import { NextRequest, NextResponse } from "next/server";
import { getGitStatus } from "@/lib/git-changes";
import { guardGitCwd } from "@/lib/git-route-guard";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const guard = await guardGitCwd(request.nextUrl.searchParams.get("cwd") ?? "");
    if (guard instanceof NextResponse) return guard;
    return NextResponse.json(await getGitStatus(guard.cwd));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
