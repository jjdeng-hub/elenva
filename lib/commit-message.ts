import { completeSimple } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { sanitizeCommitSubject } from "./git-commit";
import { resolveVisibleModels, selectInitialModelScope } from "./model-scope";
import { readManagedSettings } from "./pi-user-settings";

/**
 * 用模型根据改动内容生成一条提交信息。
 *
 * 刻意做成「生成建议、用户可改」而不是自动填好直接提交：提交信息是写给未来的人看的，
 * 必须经过一次人的确认。失败时返回 null，由调用方退回手填。
 *
 * 不复用会话内核（不需要工具、不需要会话文件），直接走一次性补全：
 * 与 /api/models-config/test 同一套 ModelRuntime + completeSimple 用法。
 */

const TIMEOUT_MS = 30_000;
const SYSTEM_PROMPT = [
  "你是一个 Git 提交信息生成器。",
  "根据给定的改动内容，输出**一条**提交信息。",
  "要求：",
  "1. 中文，动词开头，直白描述「做了什么」；",
  "2. 单行，不要换行，不超过 50 个字；",
  "3. 不要加引号、句号、前缀标签（如 feat:）、也不要解释你的思路；",
  "4. 只输出这一行提交信息本身。",
].join("\n");

/**
 * opencode / opencode-go（以及 baseUrl 指向 opencode.ai 的模型）要求请求带
 * `x-opencode-session`，否则网关直接返回 400 MissingSessionID —— 实测如此。
 *
 * 内核在会话内自动注入这两个头（pi-coding-agent 的 core/provider-attribution
 * 里 getSessionHeaders 的规则），但那是内部模块、未从包入口导出；而本模块是
 * 绕过内核的一次性补全，本来就没有 sessionId，所以这里按同一规则自己补一个
 * 进程级的稳定标识。SDK 若将来导出该工具函数，应改回复用。
 */
const ONE_SHOT_SESSION_ID = `elenva-oneshot-${Math.random().toString(36).slice(2, 10)}`;

function providerSessionHeaders(model: { provider?: string; baseUrl?: string }): Record<string, string> {
  let host = "";
  try {
    host = new URL(model.baseUrl ?? "").hostname;
  } catch {
    host = "";
  }
  const isOpenCode = model.provider === "opencode" || model.provider === "opencode-go" || host === "opencode.ai";
  return isOpenCode
    ? { "x-opencode-session": ONE_SHOT_SESSION_ID, "x-opencode-client": "pi" }
    : {};
}

export async function generateCommitMessage(patchContext: string): Promise<string | null> {  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const modelRuntime = await ModelRuntime.create();
    // 用与新会话相同的模型解析路径：遵守 enabledModels 白名单，否则回落默认模型
    const { settings } = readManagedSettings();
    const scope = await resolveVisibleModels(modelRuntime, settings.enabledModels);
    const initial = selectInitialModelScope(scope, {
      ...(settings.defaultProvider && settings.defaultModel
        ? { defaultModel: { provider: settings.defaultProvider, modelId: settings.defaultModel } }
        : {}),
    });
    const model = initial.model ?? scope.visible[0];
    if (!model) {
      console.warn("[elenva] commit message: 没有可用模型（enabledModels 过滤后为空？）");
      return null;
    }

    const resolved = await modelRuntime.getAuth(model);
    const apiKey = resolved?.auth.apiKey;
    if (!apiKey) {
      console.warn(`[elenva] commit message: ${model.provider}/${model.id} 没有可用凭据`);
      return null;
    }
    /*
     * 必须带上 SDK 的「兼容性请求头」。
     * 实测：opencode-go 要求 `x-opencode-session`，不发送则网关直接 400
     * （MissingSessionID）。会话内的调用由内核自动注入，而 completeSimple
     * 是绕过内核的一次性补全，得自己合进来。
     */
    const headers = {
      ...providerSessionHeaders(model),
      ...asStringRecord(modelRuntime.getCompatibilityRequestConfig?.(model)?.headers),
      ...asStringRecord(resolved?.auth.headers),
    };

    const message = await completeSimple(
      model,
      {
        systemPrompt: SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: `改动内容如下：\n\n${patchContext}`,
          timestamp: Date.now(),
        }],
      },
      {
        apiKey,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        maxTokens: 120,
        timeoutMs: TIMEOUT_MS,
        maxRetries: 0,
        cacheRetention: "none",
        signal: controller.signal,
      },
    );

    if (message.stopReason === "error" || message.stopReason === "aborted") {
      console.warn(`[elenva] commit message: 模型返回 ${message.stopReason} — ${message.errorMessage ?? "无详情"}`);
      return null;
    }
    const text = message.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("")
      .trim();
    if (!text) return null;

    const subject = sanitizeCommitSubject(text);
    return subject || null;
  } catch (error) {
    // 生成失败不该阻塞提交流程，前端会退回到手填 —— 但要留下可排查的痕迹
    console.warn("[elenva] commit message generation failed:", error instanceof Error ? error.message : error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** 只保留字符串值的 header 记录（SDK 返回的是 Record<string, string>，但类型上可能更宽） */
function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string" && v) out[k] = v;
  }
  return out;
}
