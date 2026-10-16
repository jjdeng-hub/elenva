import { readFileSync } from "fs";
import { join } from "path";
import { createAgentSessionServices, getAgentDir, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { withModelRuntimeError, type ModelsData } from "./models-cache";
import { resolveVisibleModels, selectInitialModelScope } from "./model-scope";
import { projectTrustReloadOptions } from "./project-trust";

/**
 * 模型清单加载（从 `app/api/models/route.ts` 原样搬到 lib）。
 *
 * 为什么搬：M6R1 的「换模型复核」要**校验请求的模型确实来自已配置可选集**
 * （`enabledModels` 白名单解析后的可见集），与 `/api/models` 界面用的是同一份口径。
 * 路由里就地写一份必然与界面漂移，所以提成共享函数，两处调用同一实现。
 *
 * 注意：这里会 `createAgentSessionServices`，即会加载并运行项目级扩展 ——
 * 因此**不可信项目必须走 projectTrustReloadOptions 闸门**（见 lib/project-trust.ts）。
 */

const modelNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareModelEntries(
  a: { id: string; name: string; provider: string },
  b: { id: string; name: string; provider: string }
): number {
  return modelNameCollator.compare(a.name || a.id, b.name || b.id)
    || modelNameCollator.compare(a.provider, b.provider)
    || modelNameCollator.compare(a.id, b.id);
}

/**
 * 读取 models-store.json 中最新的目录校验时间，让界面能如实显示"模型库多久没更新"。
 * 该文件由内核的 FileModelsStore 维护，只读不改。
 */
function readCatalogCheckedAt(agentDir: string): number | undefined {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(join(agentDir, "models-store.json"), "utf8"),
    );
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    let newest: number | undefined;
    for (const entry of Object.values(raw as Record<string, unknown>)) {
      if (entry === null || typeof entry !== "object") continue;
      const checkedAt = (entry as { checkedAt?: unknown }).checkedAt;
      if (typeof checkedAt !== "number" || !Number.isFinite(checkedAt)) continue;
      if (newest === undefined || checkedAt > newest) newest = checkedAt;
    }
    return newest;
  } catch {
    return undefined;
  }
}

export async function loadModelsForCwd(cwd: string): Promise<ModelsData> {
  const nameMap = new Map<string, string>();
  let modelList: { id: string; name: string; provider: string }[] = [];
  let allModelList: { id: string; name: string; provider: string }[] = [];
  let defaultModel: { provider: string; modelId: string } | null = null;
  const thinkingLevels: Record<string, string[]> = {};
  const thinkingLevelMaps: Record<string, Record<string, string | null>> = {};

  const agentDir = getAgentDir();
  // Gate untrusted project extensions: enumerating models still imports and
  // runs a repository's .pi/extensions factories, so honor project trust here
  // too (see lib/project-trust.ts, #236).
  const trustReloadOptions = projectTrustReloadOptions(cwd, agentDir);
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
  });
  const modelError = services.modelRuntime.getError();
  const settings: SettingsManager = services.settingsManager;
  // `enabledModels` supports globs and fuzzy patterns, so resolve it the same
  // way the CLI does instead of comparing pattern strings literally (#307).
  const scope = await resolveVisibleModels(
    services.modelRuntime,
    settings.getEnabledModels(),
  );
  const { visible, thinkingLevelPins, warnings } = scope;
  modelList = visible.map((m) => ({
    id: m.id,
    name: m.name,
    provider: m.provider,
    input: m.input,
  })).sort(compareModelEntries);
  // 全量清单：模型列表编辑器要让白名单外的模型也可见可勾选（否则一旦收窄
  // 白名单，被移出的模型就再也勾不回来了 —— 2026-09-28 反馈）。
  allModelList = scope.available.map((m) => ({
    id: m.id,
    name: m.name,
    provider: m.provider,
    input: m.input,
  })).sort(compareModelEntries);
  for (const m of visible) {
    const key = `${m.provider}:${m.id}`;
    nameMap.set(key, m.name);
    thinkingLevels[key] = getSupportedThinkingLevels(m);
    if (m.thinkingLevelMap) thinkingLevelMaps[key] = m.thinkingLevelMap;
  }

  const defaultProvider = settings.getDefaultProvider();
  const defaultModelId = settings.getDefaultModel();
  const initial = selectInitialModelScope(scope, {
    ...(defaultProvider && defaultModelId
      ? { defaultModel: { provider: defaultProvider, modelId: defaultModelId } }
      : {}),
  });
  if (initial.model) {
    defaultModel = { provider: initial.model.provider, modelId: initial.model.id };
  }

  const catalogCheckedAt = readCatalogCheckedAt(agentDir);

  return withModelRuntimeError(
    {
      models: Object.fromEntries(nameMap),
      modelList,
      allModelList,
      defaultModel,
      thinkingLevels,
      thinkingLevelMaps,
      thinkingLevelPins,
      ...(catalogCheckedAt !== undefined ? { catalogCheckedAt } : {}),
      ...(warnings.length > 0 ? { modelScopeWarnings: warnings } : {}),
    },
    modelError,
  );
}

export const EMPTY_MODELS: ModelsData = {
  models: {},
  modelList: [],
  allModelList: [],
  defaultModel: null,
  thinkingLevels: {},
  thinkingLevelMaps: {},
  thinkingLevelPins: {},
};

/** 某个 `provider/modelId` 是否在界面可选集内（复核请求的校验口径）。 */
export function isVisibleModel(
  data: Pick<ModelsData, "modelList">,
  provider: string,
  modelId: string,
): boolean {
  return data.modelList.some((m) => m.provider === provider && m.id === modelId);
}
