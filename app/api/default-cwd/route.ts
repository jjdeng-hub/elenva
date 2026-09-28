import { NextResponse } from "next/server";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { allowFileRoot } from "@/lib/file-access";

// POST /api/default-cwd
// Returns the stable default workspace (~/pi-workspace), creating it if needed.
// 之前是每天一个 ~/pi-cwd-<YYYYMMDD>（日期命名 + 目录增殖，界面上很混乱，
// 2026-09-28 反馈）改为固定目录；旧的日期目录保留不动（老会话仍引用它们）。
export async function POST() {
  try {
    const dir = join(homedir(), "pi-workspace");
    mkdirSync(dir, { recursive: true });
    allowFileRoot(dir);
    return NextResponse.json({ cwd: dir });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
