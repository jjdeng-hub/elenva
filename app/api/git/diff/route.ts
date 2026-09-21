import { NextRequest, NextResponse } from "next/server";
import { isFilePathAllowed, isWindowsAbsolutePath } from "@/lib/file-access";
import { getAllowedFileRoots } from "@/lib/file-access";
import { getGitFileDiff } from "@/lib/git-changes";
import { guardGitCwd } from "@/lib/git-route-guard";

export async function GET(request: NextRequest) {
  try {
    const guard = await guardGitCwd(request.nextUrl.searchParams.get("cwd") ?? "");
    if (guard instanceof NextResponse) return guard;

    const filePath = request.nextUrl.searchParams.get("path")?.trim() ?? "";
    if (!filePath || (!filePath.startsWith("/") && !isWindowsAbsolutePath(filePath))) {
      return NextResponse.json({ error: "path must be an absolute path" }, { status: 400 });
    }
    // 文件本身可能已不存在（Git 报为删除），所以不要求 exists；
    // getGitFileDiff 会另行校验该路径属于本仓库且确实处于变更状态。
    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(filePath, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    return NextResponse.json(await getGitFileDiff(guard.cwd, filePath));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
