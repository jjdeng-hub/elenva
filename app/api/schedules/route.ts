import { NextResponse } from "next/server";
import {
  createScheduleTask,
  listScheduleTasks,
  nextRunAtForTask,
  type ScheduleTask,
} from "@/lib/schedules";
import { ensureSchedulerStarted, getRunningScheduleTaskIds, getScheduleRuns } from "@/lib/scheduler";

export const dynamic = "force-dynamic";

/** 任务 id → 正在跑的那条会话 id（列表要能直接从「运行中」跳到会话）。 */
function runningSessionIdMap(): Map<string, string> {
  return new Map(getScheduleRuns().map((run) => [run.taskId, run.sessionId]));
}

/** 附带「下一次运行」与「是否正在跑」——列表要能直接显示，前端不再算。 */
function decorate(
  task: ScheduleTask,
  running: Set<string>,
  runningSessionIds: Map<string, string>,
): ScheduleTask & { nextRunAt: string | null; running: boolean; runningSessionId: string | null } {
  let nextRunAt: string | null = null;
  try {
    nextRunAt = nextRunAtForTask(task);
  } catch {
    nextRunAt = null;
  }
  return {
    ...task,
    nextRunAt,
    running: running.has(task.id),
    runningSessionId: runningSessionIds.get(task.id) ?? null,
  };
}

/** GET /api/schedules —— 全部节律任务（含 nextRunAt / running / lastRun）。 */
export async function GET() {
  try {
    ensureSchedulerStarted();
    const running = getRunningScheduleTaskIds();
    const runningSessionIds = runningSessionIdMap();
    return NextResponse.json(
      { tasks: listScheduleTasks().map((task) => decorate(task, running, runningSessionIds)) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

/** POST /api/schedules —— 创建一条节律任务。 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const task = createScheduleTask({
      name: body.name as string,
      prompt: body.prompt as string,
      cwd: body.cwd as string,
      schedule: body.schedule as never,
      ...(body.enabled !== undefined ? { enabled: Boolean(body.enabled) } : {}),
      ...(body.model !== undefined ? { model: body.model as never } : {}),
      ...(body.safety !== undefined ? { safety: body.safety as never } : {}),
      ...(body.catchUp !== undefined ? { catchUp: Boolean(body.catchUp) } : {}),
      ...(body.timeoutMinutes !== undefined ? { timeoutMinutes: body.timeoutMinutes as never } : {}),
    });
    ensureSchedulerStarted();
    return NextResponse.json({ task: decorate(task, getRunningScheduleTaskIds(), runningSessionIdMap()) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
