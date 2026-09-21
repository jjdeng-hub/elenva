import { NextResponse } from "next/server";
import { resolve } from "path";
import { buildAgentSystemPromptPreview, readLiveAgentSystemPrompt } from "@/lib/agent-runtime";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";

export const dynamic = "force-dynamic";

/**
 * GET /api/system-prompt?cwd=<项目路径>
 *
 * 只读：返回该项目下会话看到的系统提示词。
 *  - source=live：该项目有已加载会话 → 直接读它最近一次运行实际使用的版本
 *    （含扩展每轮注入的内容，如记忆块）。
 *  - source=preview：没有在线会话 → 用与真实会话完全相同的装配路径现场构建基础版本
 *    （内存会话，不落盘、不触发 session_start）。
 */
export async function GET(req: Request) {
  try {
    const cwdParam = new URL(req.url).searchParams.get("cwd");
    if (!cwdParam || !cwdParam.trim()) {
      return NextResponse.json({ error: "缺少 cwd 参数" }, { status: 400 });
    }
    const cwd = resolve(cwdParam);
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const live = readLiveAgentSystemPrompt(cwd);
    if (live) {
      return NextResponse.json({
        cwd,
        source: "live" as const,
        sessionId: live.sessionId,
        prompt: live.prompt,
        generatedAt: new Date().toISOString(),
      });
    }

    const preview = await buildAgentSystemPromptPreview(cwd);
    return NextResponse.json({
      cwd: preview.cwd,
      source: "preview" as const,
      prompt: preview.prompt,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
