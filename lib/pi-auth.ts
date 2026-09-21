import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

/**
 * Pi 内置厂商密钥管理（对应 CLI 的 /login → 选择厂商 → 输入 API Key）。
 * 凭据保存在 ~/.pi/agent/auth.json（0600），类型为 { type: "api_key", key } 或 OAuth 令牌。
 * 本模块只做文件级读写，绝不解析/返回完整 Key 值。
 */

export function getAuthPath(): string {
  return join(homedir(), ".pi", "agent", "auth.json");
}

type AuthEntry = { type?: string; key?: string; [k: string]: unknown };

function readAuthRaw(): Record<string, AuthEntry> {
  const p = getAuthPath();
  if (!existsSync(p)) return {};
  try {
    const data = JSON.parse(readFileSync(p, "utf8")) as Record<string, AuthEntry>;
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

/** 对字面量 Key 做尾 4 位掩码；`!command` / `$ENV` 形式的引用值原样标注不泄露内容 */
function maskKey(entry: AuthEntry): string | undefined {
  if (entry.type !== "api_key" || typeof entry.key !== "string") return undefined;
  const k = entry.key;
  if (k.startsWith("!")) return "(命令引用)";
  if (k.startsWith("$")) return "(环境变量引用)";
  if (k.length <= 8) return "••••";
  return `••••${k.slice(-4)}`;
}

/** 支持输入 Key 的内置厂商元数据（OAuth 订阅类厂商除外，见 providers.md） */
export const PROVIDER_META: Record<string, { label: string; env?: string; oauthOnly?: boolean; note?: string }> = {
  anthropic: { label: "Anthropic", env: "ANTHROPIC_API_KEY" },
  openai: { label: "OpenAI", env: "OPENAI_API_KEY" },
  deepseek: { label: "DeepSeek", env: "DEEPSEEK_API_KEY" },
  google: { label: "Google Gemini", env: "GEMINI_API_KEY" },
  "google-vertex": { label: "Google Vertex AI", note: "使用 gcloud 应用默认凭据，非 API Key" },
  "amazon-bedrock": { label: "Amazon Bedrock", env: "AWS_BEARER_TOKEN_BEDROCK" },
  "azure-openai-responses": { label: "Azure OpenAI", env: "AZURE_OPENAI_API_KEY" },
  xai: { label: "xAI（Grok）", env: "XAI_API_KEY" },
  openrouter: { label: "OpenRouter", env: "OPENROUTER_API_KEY" },
  groq: { label: "Groq", env: "GROQ_API_KEY" },
  mistral: { label: "Mistral", env: "MISTRAL_API_KEY" },
  cerebras: { label: "Cerebras", env: "CEREBRAS_API_KEY" },
  fireworks: { label: "Fireworks", env: "FIREWORKS_API_KEY" },
  together: { label: "Together AI", env: "TOGETHER_API_KEY" },
  baseten: { label: "Baseten", env: "BASETEN_API_KEY" },
  nvidia: { label: "NVIDIA NIM", env: "NVIDIA_API_KEY" },
  huggingface: { label: "Hugging Face", env: "HF_TOKEN" },
  "kimi-coding": { label: "Kimi For Coding", env: "KIMI_API_KEY" },
  moonshotai: { label: "Moonshot AI（国际）" },
  "moonshotai-cn": { label: "Moonshot AI（中国）" },
  minimax: { label: "MiniMax", env: "MINIMAX_API_KEY" },
  "minimax-cn": { label: "MiniMax（中国）", env: "MINIMAX_CN_API_KEY" },
  "ant-ling": { label: "Ant Ling（蚂蚁百灵）", env: "ANT_LING_API_KEY" },
  zai: { label: "ZAI Coding Plan（国际）", env: "ZAI_API_KEY" },
  "zai-coding-cn": { label: "ZAI Coding Plan（中国）", env: "ZAI_CODING_CN_API_KEY" },
  "qwen-token-plan": { label: "Qwen Token Plan", env: "QWEN_TOKEN_PLAN_API_KEY" },
  "qwen-token-plan-cn": { label: "Qwen Token Plan（中国）", env: "QWEN_TOKEN_PLAN_CN_API_KEY" },
  "qwen-token-plan-individual": { label: "Qwen Token Plan（Individual）", env: "QWEN_TOKEN_PLAN_API_KEY" },
  xiaomi: { label: "Xiaomi MiMo", env: "XIAOMI_API_KEY" },
  "xiaomi-token-plan-cn": { label: "Xiaomi MiMo（中国）", env: "XIAOMI_TOKEN_PLAN_CN_API_KEY" },
  "xiaomi-token-plan-ams": { label: "Xiaomi MiMo（阿姆斯特丹）", env: "XIAOMI_TOKEN_PLAN_AMS_API_KEY" },
  "xiaomi-token-plan-sgp": { label: "Xiaomi MiMo（新加坡）", env: "XIAOMI_TOKEN_PLAN_SGP_API_KEY" },
  opencode: { label: "OpenCode Zen", env: "OPENCODE_API_KEY" },
  "opencode-go": { label: "OpenCode Go", env: "OPENCODE_API_KEY" },
  "vercel-ai-gateway": { label: "Vercel AI Gateway", env: "AI_GATEWAY_API_KEY" },
  "cloudflare-ai-gateway": { label: "Cloudflare AI Gateway", env: "CLOUDFLARE_API_KEY", note: "还需 CLOUDFLARE_ACCOUNT_ID / GATEWAY_ID" },
  "cloudflare-workers-ai": { label: "Cloudflare Workers AI", env: "CLOUDFLARE_API_KEY" },
  "openai-codex": { label: "OpenAI Codex（ChatGPT 订阅）", oauthOnly: true },
  "github-copilot": { label: "GitHub Copilot", env: "COPILOT_GITHUB_TOKEN" },
  radius: { label: "Radius", oauthOnly: true },
};

export type ProviderAuthStatus = {
  id: string;
  label: string;
  /** 该厂商在内置目录中的模型数量 */
  modelCount: number;
  /** 环境变量名提示 */
  env?: string;
  /** 仅支持 OAuth 订阅登录（界面上走「接入模型」向导的订阅登录流程） */
  oauthOnly?: boolean;
  note?: string;
  /** auth.json 中的凭据状态 */
  auth: { type: string; masked?: string } | null;
  /** 检测到服务进程环境变量（存在即视为已配置） */
  envSet: boolean;
};

export async function listProviderAuthStatus(): Promise<ProviderAuthStatus[]> {
  const auth = readAuthRaw();
  const env = process.env as Record<string, string | undefined>;
  const envProviders = new Set<string>();
  for (const [id, meta] of Object.entries(PROVIDER_META)) {
    if (meta.env && env[meta.env]) envProviders.add(id);
  }
  // 特例：多个厂商共享同一环境变量
  if (env.OPENCODE_API_KEY) {
    envProviders.add("opencode");
    envProviders.add("opencode-go");
  }
  if (env.CLOUDFLARE_API_KEY) {
    envProviders.add("cloudflare-ai-gateway");
    envProviders.add("cloudflare-workers-ai");
  }
  if (env.QWEN_TOKEN_PLAN_API_KEY) {
    envProviders.add("qwen-token-plan");
    envProviders.add("qwen-token-plan-individual");
  }

  const out: ProviderAuthStatus[] = [];
  try {
    const all = (await import("@earendil-works/pi-ai/providers/all")) as AnyRecord;
    const names = all.getBuiltinProviders() as string[];
    for (const id of names) {
      const meta = PROVIDER_META[id] ?? { label: id };
      const entry = auth[id];
      out.push({
        id,
        label: meta.label,
        modelCount: (all.getBuiltinModels(id) as unknown[]).length,
        env: meta.env,
        oauthOnly: meta.oauthOnly,
        note: meta.note,
        auth: entry ? { type: entry.type ?? "unknown", masked: maskKey(entry) } : null,
        envSet: envProviders.has(id),
      });
    }
  } catch {
    // 目录导入失败时退化为静态表
    for (const [id, meta] of Object.entries(PROVIDER_META)) {
      const entry = auth[id];
      out.push({
        id,
        label: meta.label,
        modelCount: 0,
        env: meta.env,
        oauthOnly: meta.oauthOnly,
        note: meta.note,
        auth: entry ? { type: entry.type ?? "unknown", masked: maskKey(entry) } : null,
        envSet: envProviders.has(id),
      });
    }
  }
  // auth.json 里可能有目录之外的自定义/OAuth 条目
  for (const [id, entry] of Object.entries(auth)) {
    if (out.some((p) => p.id === id)) continue;
    out.push({
      id,
      label: PROVIDER_META[id]?.label ?? id,
      modelCount: 0,
      auth: { type: entry.type ?? "unknown", masked: maskKey(entry) },
      envSet: false,
    });
  }
  return out;
}

export async function setProviderApiKey(provider: string, key: string): Promise<void> {
  if (!provider || /[^a-z0-9-]/i.test(provider)) throw new Error("非法的 provider id");
  if (typeof key !== "string" || key.trim().length === 0) throw new Error("Key 不能为空");
  const meta = PROVIDER_META[provider];
  if (meta?.oauthOnly) throw new Error(`${meta.label} 仅支持 OAuth 订阅登录，请使用 pi CLI 的 /login`);
  const p = getAuthPath();
  const data = readAuthRaw();
  data[provider] = { type: "api_key", key: key.trim() };
  const { writePrivateFileAtomicSync } = await import("./atomic-file");
  mkdirsGuard(p);
  writePrivateFileAtomicSync(p, `${JSON.stringify(data, null, 2)}\n`);
  await refreshSessions();
}

export async function deleteProviderAuth(provider: string): Promise<void> {
  const p = getAuthPath();
  const data = readAuthRaw();
  if (!(provider in data)) throw new Error("该厂商没有已保存的凭据");
  delete data[provider];
  const { writePrivateFileAtomicSync } = await import("./atomic-file");
  writePrivateFileAtomicSync(p, Object.keys(data).length > 0 ? `${JSON.stringify(data, null, 2)}\n` : "");
  await refreshSessions();
}

/** 让运行中的会话立即重新加载凭据与模型目录 */
async function refreshSessions(): Promise<void> {
  const g = globalThis as AnyRecord;
  const sessions = g.__piSessions as Map<string, { inner?: { modelRuntime?: { refresh?: (o?: unknown) => Promise<unknown> } } }> | undefined;
  if (!sessions) return;
  await Promise.allSettled(
    Array.from(sessions.values()).map((s) => s.inner?.modelRuntime?.refresh?.({ allowNetwork: false })),
  );
}

function mkdirsGuard(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}
