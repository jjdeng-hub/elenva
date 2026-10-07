/**
 * elenva-comfyui 核心逻辑：配置解析 / 工作流参数注入 / ComfyUI 客户端。
 *
 * 纯逻辑（loadConfig / injectParams / parseHistoryResult）与 fetch 客户端分离，
 * 便于 selftest.mjs 直接跑纯函数；index.ts 只负责注册工具。
 *
 * 接口约定（本机 ComfyUI）：
 *   POST /prompt            { prompt: <API 格式工作流>, client_id } → { prompt_id, node_errors }
 *   GET  /history/<id>      → { <id>: { outputs, status: { status_str, completed } } }
 *   GET  /view?filename=…   → 图片字节
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ── 配置 ────────────────────────────────────────────────────────────────────

export interface ComfyModels {
  unet?: string;
  clip1?: string;
  clip2?: string;
  vae?: string;
  checkpoint?: string;
}

export interface ComfyConfig {
  baseUrl: string;
  /** 空 = 用内置 Flux 模板；否则指向自定义 API 格式工作流文件 */
  workflowPath: string;
  timeoutMs: number;
  pollIntervalMs: number;
  /** 空 = <agentRoot>/comfyui-outputs */
  saveDir: string;
  /** 显式指定参数节点（prompt/seed/steps/width/height → 节点 id） */
  nodeMap: Record<string, string>;
  /** 覆盖内置模板里的模型文件名 */
  models: ComfyModels;
}

export const DEFAULT_CONFIG: ComfyConfig = {
  baseUrl: "http://127.0.0.1:8188",
  workflowPath: "",
  timeoutMs: 300_000,
  pollIntervalMs: 1_000,
  saveDir: "",
  nodeMap: {},
  models: {},
};

export function agentRoot(): string {
  const env = process.env.PI_CODING_AGENT_DIR;
  return env ? path.resolve(env) : path.join(os.homedir(), ".pi", "agent");
}

/** 合并顺序：默认值 < <agentRoot>/comfyui.json < 环境变量（便于临时测试）。 */
export function loadConfig(root: string = agentRoot()): ComfyConfig {
  const cfg: ComfyConfig = { ...DEFAULT_CONFIG, nodeMap: {}, models: {} };
  const file = path.join(root, "comfyui.json");
  if (fs.existsSync(file)) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ComfyConfig>;
      if (typeof raw.baseUrl === "string" && raw.baseUrl) cfg.baseUrl = raw.baseUrl;
      if (typeof raw.workflowPath === "string") cfg.workflowPath = raw.workflowPath;
      if (typeof raw.timeoutMs === "number" && raw.timeoutMs > 0) cfg.timeoutMs = raw.timeoutMs;
      if (typeof raw.pollIntervalMs === "number" && raw.pollIntervalMs >= 100) cfg.pollIntervalMs = raw.pollIntervalMs;
      if (typeof raw.saveDir === "string") cfg.saveDir = raw.saveDir;
      if (raw.nodeMap && typeof raw.nodeMap === "object") cfg.nodeMap = { ...raw.nodeMap };
      if (raw.models && typeof raw.models === "object") cfg.models = { ...raw.models };
    } catch {
      // 配置坏了不阻断：回落默认值
    }
  }
  if (process.env.COMFYUI_BASE_URL) cfg.baseUrl = process.env.COMFYUI_BASE_URL;
  if (process.env.COMFYUI_WORKFLOW_PATH) cfg.workflowPath = process.env.COMFYUI_WORKFLOW_PATH;
  if (process.env.COMFYUI_SAVE_DIR) cfg.saveDir = process.env.COMFYUI_SAVE_DIR;
  return cfg;
}

// ── 工作流注入 ──────────────────────────────────────────────────────────────

export interface WorkflowNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
}
export type Workflow = Record<string, WorkflowNode>;

export interface InjectParams {
  prompt: string;
  width?: number;
  height?: number;
  seed?: number;
  steps?: number;
}

/** 按节点 id 数值序找第一个满足条件的节点（工作流里 id 是字符串数字）。 */
export function findNode(wf: Workflow, pred: (node: WorkflowNode) => boolean): string | undefined {
  return Object.keys(wf)
    .sort((a, b) => Number(a) - Number(b))
    .find((id) => pred(wf[id]));
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

/**
 * 把参数注入工作流副本。查找顺序：config.nodeMap 显式指定 > 启发式：
 *  - prompt → 标题含 "Prompt"/positive 的 CLIPTextEncode*，否则第一个带字符串 text 的
 *  - width/height → 第一个带 width 与 height 数字输入的空潜空间节点（Empty*LatentImage）
 *  - seed → 第一个带 noise_seed 的节点，否则第一个带 seed 的节点
 *  - steps → 第一个带 steps 的节点
 *  - models.* → 按 loader 类型替换（UNETLoader / DualCLIPLoader / VAELoader / CheckpointLoaderSimple）
 */
export function injectParams(
  wf: Workflow,
  params: InjectParams,
  cfg: ComfyConfig,
): { workflow: Workflow; seed: number } {
  const out = structuredClone(wf) as Workflow;
  const isTextEncode = (n: WorkflowNode) => n.class_type.startsWith("CLIPTextEncode") && typeof n.inputs.text === "string";

  const promptId =
    cfg.nodeMap.prompt ??
    findNode(out, (n) => isTextEncode(n) && /prompt|positive|提示/i.test(n._meta?.title ?? "")) ??
    findNode(out, isTextEncode);
  if (promptId && out[promptId]) out[promptId].inputs.text = params.prompt;

  const whId =
    cfg.nodeMap.width ??
    cfg.nodeMap.height ??
    findNode(out, (n) => n.class_type.startsWith("Empty") && typeof n.inputs.width === "number" && typeof n.inputs.height === "number");
  if (whId && out[whId]) {
    if (params.width) out[whId].inputs.width = Math.round(params.width);
    if (params.height) out[whId].inputs.height = Math.round(params.height);
  }

  const seed =
    params.seed !== undefined && Number.isFinite(params.seed) && params.seed >= 0 ? Math.floor(params.seed) : randomSeed();
  const seedId =
    cfg.nodeMap.seed ??
    findNode(out, (n) => typeof n.inputs.noise_seed === "number") ??
    findNode(out, (n) => typeof n.inputs.seed === "number");
  if (seedId && out[seedId]) {
    if (typeof out[seedId].inputs.noise_seed === "number") out[seedId].inputs.noise_seed = seed;
    else if (typeof out[seedId].inputs.seed === "number") out[seedId].inputs.seed = seed;
  }

  if (params.steps !== undefined) {
    const stepsId = cfg.nodeMap.steps ?? findNode(out, (n) => typeof n.inputs.steps === "number");
    if (stepsId && out[stepsId]) out[stepsId].inputs.steps = Math.round(params.steps);
  }

  // 模型文件名覆盖（按 loader 类型；仅覆盖配置里给了的项）
  const m = cfg.models;
  for (const node of Object.values(out)) {
    if (node.class_type === "UNETLoader" && m.unet && "unet_name" in node.inputs) node.inputs.unet_name = m.unet;
    if (node.class_type === "DualCLIPLoader") {
      if (m.clip1 && "clip_name1" in node.inputs) node.inputs.clip_name1 = m.clip1;
      if (m.clip2 && "clip_name2" in node.inputs) node.inputs.clip_name2 = m.clip2;
    }
    if (node.class_type === "VAELoader" && m.vae && "vae_name" in node.inputs) node.inputs.vae_name = m.vae;
    if (node.class_type === "CheckpointLoaderSimple" && m.checkpoint && "ckpt_name" in node.inputs) node.inputs.ckpt_name = m.checkpoint;
  }

  return { workflow: out, seed };
}

// ── /history 解析 ───────────────────────────────────────────────────────────

export interface ComfyImageRef {
  filename: string;
  subfolder?: string;
  type?: string;
}
export interface HistoryEntry {
  outputs?: Record<string, { images?: ComfyImageRef[] } | undefined>;
  status?: { status_str?: string; completed?: boolean; messages?: unknown[] };
}

export type HistoryParse =
  | { state: "pending" }
  | { state: "error"; message: string }
  | { state: "done"; image: ComfyImageRef };

/**
 * 解析 /history/<id> 的单条记录。
 * 注意先查 status_str === "error" 再看 completed——失败的运行两者可能同时为真。
 */
export function parseHistoryResult(entry: HistoryEntry | undefined): HistoryParse {
  if (!entry) return { state: "pending" };
  const status = entry.status;
  if (status?.status_str === "error") {
    return { state: "error", message: extractExecutionError(status.messages) };
  }
  if (status?.completed) {
    const image = firstImage(entry.outputs);
    if (image) return { state: "done", image };
    return { state: "error", message: "工作流执行完成但没有图片输出（检查是否包含 SaveImage 节点）。" };
  }
  return { state: "pending" };
}

function firstImage(outputs: HistoryEntry["outputs"]): ComfyImageRef | undefined {
  if (!outputs) return undefined;
  for (const id of Object.keys(outputs).sort((a, b) => Number(a) - Number(b))) {
    const images = outputs[id]?.images;
    if (Array.isArray(images) && images.length > 0) return images[0];
  }
  return undefined;
}

function extractExecutionError(messages: unknown[] | undefined): string {
  if (Array.isArray(messages)) {
    for (const m of messages) {
      if (Array.isArray(m) && m[0] === "execution_error" && m[1] && typeof m[1] === "object") {
        const info = m[1] as { exception_message?: string; node_type?: string };
        const parts = [info.exception_message, info.node_type ? `（节点：${info.node_type}）` : ""].filter(Boolean);
        if (parts.length > 0) return parts.join(" ");
      }
    }
  }
  return "ComfyUI 执行出错（详情见 ComfyUI 控制台）。";
}

// ── 客户端（生成全流程）────────────────────────────────────────────────────

export interface GenerateOptions extends InjectParams {
  config: ComfyConfig;
  signal?: AbortSignal;
}

export interface GenerateResult {
  imageBase64: string;
  mimeType: string;
  filename: string;
  savedPath: string;
  promptId: string;
  seed: number;
  width: number;
  height: number;
  elapsedMs: number;
}

export function bundledWorkflowPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "workflows", "flux_txt2img.json");
}

export async function generateViaComfyUI(opts: GenerateOptions): Promise<GenerateResult> {
  const { config } = opts;
  const started = Date.now();
  const base = config.baseUrl.replace(/\/+$/, "");

  // 1) 读工作流（自定义路径优先，空则用内置模板）
  const wfPath = config.workflowPath || bundledWorkflowPath();
  let wf: Workflow;
  try {
    wf = JSON.parse(fs.readFileSync(wfPath, "utf8")) as Workflow;
  } catch (err) {
    throw new Error(`读不到工作流文件：${wfPath}（${err instanceof Error ? err.message : String(err)}）`);
  }
  const { workflow, seed } = injectParams(wf, opts, config);
  const width = Math.round(opts.width ?? numberInput(workflow, "width") ?? 1024);
  const height = Math.round(opts.height ?? numberInput(workflow, "height") ?? 1024);

  // 2) 提交
  const submit = await comfyFetch(`${base}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: randomClientId() }),
    signal: opts.signal,
  });
  const submitBody = (await submit.json()) as {
    prompt_id?: string;
    node_errors?: Record<string, { errors?: Array<{ message?: string }> }>;
  };
  const promptId = submitBody.prompt_id;
  if (!promptId) {
    const errs = submitBody.node_errors ?? {};
    const first = Object.values(errs)[0];
    const msg = first?.errors?.[0]?.message ?? JSON.stringify(errs).slice(0, 300);
    throw new Error(`ComfyUI 拒绝了工作流：${msg}`);
  }

  // 3) 轮询直到完成 / 出错 / 超时
  const deadline = started + config.timeoutMs;
  let imageRef: ComfyImageRef | undefined;
  for (;;) {
    if (opts.signal?.aborted) throw new Error("已取消。");
    if (Date.now() > deadline) {
      throw new Error(`等待超时（${Math.round(config.timeoutMs / 1000)}s，prompt_id=${promptId}）——可在 comfyui.json 调大 timeoutMs。`);
    }
    await sleep(config.pollIntervalMs);
    const hist = await comfyFetch(`${base}/history/${encodeURIComponent(promptId)}`, { signal: opts.signal });
    const body = (await hist.json()) as Record<string, HistoryEntry>;
    const parsed = parseHistoryResult(body[promptId]);
    if (parsed.state === "error") throw new Error(parsed.message);
    if (parsed.state === "done") {
      imageRef = parsed.image;
      break;
    }
  }

  // 4) 取图
  const qs = new URLSearchParams({
    filename: imageRef.filename,
    subfolder: imageRef.subfolder ?? "",
    type: imageRef.type ?? "output",
  });
  const view = await comfyFetch(`${base}/view?${qs.toString()}`, { signal: opts.signal });
  const bytes = Buffer.from(await view.arrayBuffer());
  const mimeType = view.headers.get("content-type")?.split(";")[0] || "image/png";

  // 5) 存副本（方便后续复用；ComfyUI 自己的输出目录里也有一份）
  const saveDir = config.saveDir || path.join(agentRoot(), "comfyui-outputs");
  fs.mkdirSync(saveDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const savedPath = path.join(saveDir, `comfyui-${stamp}-${promptId.slice(0, 8)}.png`);
  fs.writeFileSync(savedPath, bytes);

  return {
    imageBase64: bytes.toString("base64"),
    mimeType,
    filename: imageRef.filename,
    savedPath,
    promptId,
    seed,
    width,
    height,
    elapsedMs: Date.now() - started,
  };
}

async function comfyFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    const cause = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
    throw new Error(`连不上 ComfyUI（${url}）：${cause}。请确认 ComfyUI 已在本机运行（默认 127.0.0.1:8188）。`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomClientId(): string {
  return `elenva-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function numberInput(wf: Workflow, key: "width" | "height"): number | undefined {
  const id = findNode(wf, (n) => typeof n.inputs[key] === "number");
  const v = id ? wf[id]?.inputs[key] : undefined;
  return typeof v === "number" ? v : undefined;
}
