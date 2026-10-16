import { NextResponse } from "next/server";
import { loadModelsWithCache } from "@/lib/models-cache";
import { EMPTY_MODELS, isVisibleModel, loadModelsForCwd } from "@/lib/models-loader";
import {
  buildReviewPrompt,
  buildReviewTitle,
  createModelReview,
  extractFirstUserTask,
  findReviewRelations,
  readModelReviews,
  truncateTaskPreview,
  updateModelReview,
  type ModelReviewModel,
} from "@/lib/model-review";
import { startNewAgentSession } from "@/lib/session-launch";
import { getSessionEntries, readSessionHeader, resolveSessionPath } from "@/lib/session-reader";

export const dynamic = "force-dynamic";

/**
 * 「换模型复核」。
 *
 * 这是把已经固化成手工动作的流程（同任务换模型再跑一遍、并排比结果）变成一等流程的
 * 服务端一半：起一条**独立**复核会话，并把「谁复核了谁、用哪个模型」落档。
 *
 * 独立复核的语义很关键：复核会话只收到**原任务原文 + 一行声明**，绝不注入原会话的
 * 产出（diff / 结论 / 上下文）。否则只是换个模型去同意上一个模型。
 *
 * 会话创建统一走 `lib/session-launch.ts`（与「新建会话」、「并行试验」同一条路径），
 * 不在这里另起炉灶拼 cwd 允许根 / 列表失效那几步。
 */

/** GET /api/model-reviews?sessionId=<id> —— 该会话的复核关系（作为原会话 / 作为复核会话）。 */
export async function GET(req: Request) {
  try {
    const sessionId = new URL(req.url).searchParams.get("sessionId");
    const reviews = readModelReviews();
    if (!sessionId) return NextResponse.json({ reviews }, { headers: { "Cache-Control": "no-store" } });
    return NextResponse.json(findReviewRelations(reviews, sessionId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

/** POST /api/model-reviews  body: { parentSessionId, provider?, modelId? } */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      parentSessionId?: unknown;
      provider?: unknown;
      modelId?: unknown;
    };

    const parentSessionId = typeof body.parentSessionId === "string" ? body.parentSessionId.trim() : "";
    if (!parentSessionId) {
      return NextResponse.json({ error: "缺少 parentSessionId" }, { status: 400 });
    }

    const provider = typeof body.provider === "string" && body.provider.trim() ? body.provider.trim() : undefined;
    const modelId = typeof body.modelId === "string" && body.modelId.trim() ? body.modelId.trim() : undefined;
    if ((provider && !modelId) || (!provider && modelId)) {
      return NextResponse.json({ error: "provider 与 modelId 需同时提供" }, { status: 400 });
    }

    // 只允许现存会话：解析不到文件、也读不出 header 的 id 一律拒。
    const sessionFile = await resolveSessionPath(parentSessionId);
    if (!sessionFile) {
      return NextResponse.json({ error: "原会话不存在" }, { status: 404 });
    }
    const header = readSessionHeader(sessionFile);
    if (!header || header.id !== parentSessionId) {
      return NextResponse.json({ error: "原会话不存在" }, { status: 404 });
    }
    const cwd = typeof header.cwd === "string" && header.cwd ? header.cwd : undefined;
    if (!cwd) {
      return NextResponse.json({ error: "原会话缺少工作区，无法在相同工作区起复核" }, { status: 400 });
    }

    const taskText = extractTaskText(sessionFile);
    if (!taskText) {
      return NextResponse.json({ error: "原会话没有可复核的任务文本" }, { status: 400 });
    }

    // 模型必须来自「已配置可选集」——与 /api/models 界面用的是同一份解析（enabledModels 白名单）。
    let models;
    try {
      models = await loadModelsWithCache(cwd, () => loadModelsForCwd(cwd));
    } catch {
      models = EMPTY_MODELS;
    }
    if (models.modelList.length === 0) {
      return NextResponse.json({ error: "模型列表暂时不可用，无法校验复核模型" }, { status: 400 });
    }

    let model: ModelReviewModel;
    if (provider && modelId) {
      if (!isVisibleModel(models, provider, modelId)) {
        return NextResponse.json({ error: "模型不在已配置可选集内" }, { status: 400 });
      }
      model = { provider, modelId };
    } else {
      const fallback = models.defaultModel ?? { provider: models.modelList[0].provider, modelId: models.modelList[0].id };
      model = { provider: fallback.provider, modelId: fallback.modelId };
    }

    const taskPreview = truncateTaskPreview(taskText);
    const review = createModelReview({
      parentSessionId,
      model,
      taskPreview,
      status: "creating",
    });

    // 起会话：失败把记录标红，别留一条假装在跑的僵尸。
    let session;
    let reviewSessionId: string;
    try {
      ({ session, realSessionId: reviewSessionId } = await startNewAgentSession(cwd, {
        initialModel: model,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateModelReview(review.id, { status: "error", error: message });
      return NextResponse.json({ error: `创建复核会话失败：${message}` }, { status: 500 });
    }

    updateModelReview(review.id, { status: "running", reviewSessionId });

    // 标题失败不影响执行（与节律的无头会话同一口径）。
    try {
      await session.send({ type: "set_session_name", name: buildReviewTitle(model, taskPreview) });
    } catch {
      /* 无标题可接受 */
    }

    /* 状态流转：agent_end → done；prompt_error → error。
       监听器在终态时自摘，避免会话长期存活时攒下一次性回调。 */
    const unsubscribe = session.onEvent((event) => {
      if (event.type === "prompt_error") {
        const message = typeof event.errorMessage === "string" ? event.errorMessage : "复核执行失败";
        updateModelReview(review.id, { status: "error", error: message });
        unsubscribe();
      } else if (event.type === "agent_end") {
        updateModelReview(review.id, { status: "done" });
        unsubscribe();
      }
    });

    /* 不 await 整轮执行：接口要立刻返回，让界面把「复核中」的 chip 显示出来。
       执行本身挂在进程内的会话注册表上，用户可以在会话列表里打开它、续聊、删除。 */
    void session
      .send({ type: "prompt", message: buildReviewPrompt(taskText) })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        updateModelReview(review.id, { status: "error", error: message });
        unsubscribe();
      });

    return NextResponse.json({ review: { ...review, status: "running", reviewSessionId } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

/** 从会话文件里抽首条有文字的用户消息（放这里是为了让路由保持只做编排）。 */
function extractTaskText(sessionFile: string): string | null {
  return extractFirstUserTask(getSessionEntries(sessionFile));
}
