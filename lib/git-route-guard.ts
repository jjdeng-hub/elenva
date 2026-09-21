import fs from "fs";
import { NextResponse } from "next/server";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
  isFilePathAllowed,
  isWindowsAbsolutePath,
} from "./file-access";

/**
 * git 路由共用的 cwd 门禁（读与写都要过）。
 *
 * 抽出来的原因：/api/git/{status,diff,commit,undo-commit,commit-message} 五处
 * 都要求「绝对路径 + 落在允许根内 + 存在且是目录」，复制五份迟早漏一处 ——
 * 而这里漏一处的后果是任意目录可被读写。
 *
 * 返回 NextResponse 表示拒绝，返回 null 表示放行。
 */
export async function guardGitCwd(rawCwd: string): Promise<{ cwd: string } | NextResponse> {
  const cwd = rawCwd.trim();
  if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
    return NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 });
  }

  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(cwd, allowedRoots)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(cwd);
  } catch {
    return NextResponse.json({ error: "Directory not found" }, { status: 404 });
  }
  if (!stat.isDirectory()) {
    return NextResponse.json({ error: "Not a directory" }, { status: 400 });
  }
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  return { cwd };
}
