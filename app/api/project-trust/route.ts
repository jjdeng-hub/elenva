import { stat } from "fs/promises";
import { resolve } from "path";
import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { invalidateModelsCache } from "@/lib/models-cache";
import { getProjectTrustStatus, trustProject } from "@/lib/project-trust";
import { restartAgentSessionsForCwd } from "@/lib/agent-runtime";
import type { ProjectTrustUpdate } from "@/lib/api-types";

export const dynamic = "force-dynamic";

async function validateCwd(value: unknown): Promise<
  { cwd: string } | { response: NextResponse }
> {
  if (typeof value !== "string" || !value.trim()) {
    return { response: NextResponse.json({ error: "cwd required" }, { status: 400 }) };
  }

  const cwd = resolve(value);
  try {
    if (!(await stat(cwd)).isDirectory()) {
      return { response: NextResponse.json({ error: "cwd must be a directory" }, { status: 400 }) };
    }
  } catch {
    return { response: NextResponse.json({ error: "Directory does not exist" }, { status: 400 }) };
  }

  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return { response: NextResponse.json({ error: "Access denied" }, { status: 403 }) };
  }
  return { cwd };
}

export async function GET(req: Request) {
  const result = await validateCwd(new URL(req.url).searchParams.get("cwd"));
  if ("response" in result) return result.response;
  return NextResponse.json(getProjectTrustStatus(result.cwd, getAgentDir()));
}

export async function POST(req: Request) {
  try {
    const body = await req.json() as { cwd?: unknown };
    const result = await validateCwd(body.cwd);
    if ("response" in result) return result.response;

    const agentDir = getAgentDir();
    const current = getProjectTrustStatus(result.cwd, agentDir);
    if (!current.requiresTrust) {
      return NextResponse.json({ error: "This project has no resources that require trust" }, { status: 409 });
    }

    // The trust decision is a property of the project, not of a session, so it
    // is recorded even while sessions are running (blocking it here used to be
    // a dead end: the button did nothing until every session in the project
    // happened to be idle). Sessions that already exist keep the resource set
    // they were created with, so they are closed to force a fresh load — idle
    // ones now, running ones right after their current run settles.
    const status = trustProject(result.cwd, agentDir);
    invalidateModelsCache();
    const { restarted, deferred } = restartAgentSessionsForCwd(result.cwd);
    const update: ProjectTrustUpdate = { ...status, restarted, deferred };
    return NextResponse.json(update);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
