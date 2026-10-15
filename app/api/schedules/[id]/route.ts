import { NextResponse } from "next/server";
import {
  deleteScheduleTask,
  getScheduleTask,
  nextRunAtForTask,
  updateScheduleTask,
  type ScheduleTaskPatch,
  type ScheduleTask,
} from "@/lib/schedules";
import { ensureSchedulerStarted, getRunningScheduleTaskIds, getScheduleRuns } from "@/lib/scheduler";

export const dynamic = "force-dynamic";

function decorate(task: ScheduleTask) {
  let nextRunAt: string | null = null;
  try {
    nextRunAt = nextRunAtForTask(task);
  } catch {
    nextRunAt = null;
  }
  const running = getRunningScheduleTaskIds().has(task.id);
  const runningSessionId = running
    ? (getScheduleRuns().find((run) => run.taskId === task.id)?.sessionId ?? null)
    : null;
  return { ...task, nextRunAt, running, runningSessionId };
}

const NOT_FOUND = "找不到该节律任务";

/** GET /api/schedules/[id] —— 单条节律任务。 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    ensureSchedulerStarted();
    const task = getScheduleTask(id);
    if (!task) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
    return NextResponse.json({ task: decorate(task) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

/** PATCH /api/schedules/[id] —— 编辑（含 enabled 切换）。 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const allowed = ["name", "enabled", "schedule", "prompt", "cwd", "model", "safety", "catchUp", "timeoutMinutes"] as const;
    const patch: ScheduleTaskPatch = {};
    for (const key of allowed) {
      if (body[key] !== undefined) {
        (patch as Record<string, unknown>)[key] = body[key];
      }
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "没有可修改的字段" }, { status: 400 });
    }
    const task = updateScheduleTask(id, patch);
    return NextResponse.json({ task: decorate(task) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message === NOT_FOUND ? 404 : 400 });
  }
}

/** DELETE /api/schedules/[id] —— 删除。 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    deleteScheduleTask(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message === NOT_FOUND ? 404 : 400 });
  }
}
