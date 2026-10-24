import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { invalidateModelsCache } from "./models-cache";

const MODEL_COST_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeModelCost(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const providedKeys = MODEL_COST_KEYS.filter((key) => value[key] !== undefined);
  if (providedKeys.length === 0) return undefined;
  if (providedKeys.some((key) => (
    typeof value[key] !== "number" || !Number.isFinite(value[key])
  ))) return undefined;

  return Object.fromEntries([
    ...Object.entries(value),
    ...MODEL_COST_KEYS.map((key) => [key, value[key] ?? 0]),
  ]);
}

/** Complete partial cost groups with zero; omit a cost group only when it is empty. */
export function normalizeModelsConfigCosts(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = structuredClone(data);
  if (!isRecord(normalized.providers)) return normalized;

  for (const provider of Object.values(normalized.providers)) {
    if (!isRecord(provider) || !Array.isArray(provider.models)) continue;
    for (const model of provider.models) {
      if (!isRecord(model) || !("cost" in model)) continue;
      const cost = normalizeModelCost(model.cost);
      if (cost) model.cost = cost;
      else delete model.cost;
    }
  }
  return normalized;
}

const PROVIDER_TEXT_KEYS = ["name", "baseUrl", "api", "apiKey"] as const;
const MODEL_TEXT_KEYS = ["name", "api", "baseUrl"] as const;

function dropEmptyTextFields(
  record: Record<string, unknown>,
  keys: readonly string[],
): void {
  for (const key of keys) {
    // 纯空白也当空串：界面上手滑敲进空格保存，比真的填了更常见
    const value = record[key];
    if (typeof value === "string" && value.trim() === "") delete record[key];
  }
}

/**
 * 清掉会被 SDK schema 判为非法的空值（例如界面上把 baseUrl 清空后保存）。
 * `models.json` 是「整份文件要么全通过校验，要么整个文件全部加载失败」——
 * 一个空串就会让所有自定义厂商在模型选择器里消失，所以在写入端兜住。
 */
function sanitizeModelsConfig(data: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(data.providers)) return data;

  const providers = Object.fromEntries(Object.entries(data.providers).map(([providerId, provider]) => {
    if (!isRecord(provider) || !Array.isArray(provider.models)) return [providerId, provider];
    dropEmptyTextFields(provider, PROVIDER_TEXT_KEYS);
    const models = provider.models.filter((model) => (
      !isRecord(model) || typeof model.id !== "string" || model.id.trim().length > 0
    )).map((model) => {
      if (isRecord(model)) dropEmptyTextFields(model, MODEL_TEXT_KEYS);
      return model;
    });
    return [providerId, { ...provider, models }];
  }));

  return { ...data, providers };
}

export function getModelsConfigPath(): string {
  return join(getAgentDir(), "models.json");
}

export function readModelsConfig(
  modelsPath = getModelsConfigPath(),
): Record<string, unknown> {
  if (!existsSync(modelsPath)) return { providers: {} };
  try {
    return JSON.parse(readFileSync(modelsPath, "utf8")) as Record<string, unknown>;
  } catch {
    return { providers: {} };
  }
}

export function writeModelsConfig(
  data: Record<string, unknown>,
  modelsPath = getModelsConfigPath(),
): void {
  const dir = dirname(modelsPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const normalized = normalizeModelsConfigCosts(sanitizeModelsConfig(data));
  writePrivateFileAtomicSync(modelsPath, JSON.stringify(normalized, null, 2));
  invalidateModelsCache();
}

/**
 * 用内核自己的加载器验一遍待写入的配置。
 *
 * 为什么需要：`models.json` 是「整份文件要么全通过校验，要么整个文件全部加载失败」
 * —— 一条 provider/model 缺 `api`（或 `baseUrl`），整个模型库都加载不出来，界面上
 * 常驻一条「模型库加载失败」红条，而写入端原先只清空串、不做语义校验。
 * 2026-10-24 实测：测试数据（provider `bad` / model `ok-model`）就这样写进了真实
 * `~/.pi/agent/models.json`，红条挂了一整天，用户没有就地修复的入口。
 *
 * 借内核的加载器校验的好处：继承规则（provider 级 `api`、内置厂商的默认值）跟着
 * 内核走，不会比内核严、也不会比内核松。返回第一条错误文案；`null` = 通过。
 */
export async function validateModelsConfig(
  data: Record<string, unknown>,
): Promise<string | null> {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), "elenva-models-validate-"));
    const modelsPath = join(dir, "models.json");
    writeFileSync(
      modelsPath,
      JSON.stringify(normalizeModelsConfigCosts(sanitizeModelsConfig(data))),
      "utf8",
    );
    const runtime = await ModelRuntime.create({ modelsPath });
    return runtime.getError() ?? null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}
