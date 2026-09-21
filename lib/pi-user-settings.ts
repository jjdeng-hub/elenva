import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { invalidateModelsCache } from "./models-cache";

/**
 * Pi 用户级 settings.json（~/.pi/agent/settings.json）的受管读写。
 * 只暴露 UI 需要管理的 curated 子集，其余键原样保留（合并写入）。
 * 键的含义见 SDK docs/settings.md。
 */

export const DELIVERY_MODES = ["all", "one-at-a-time"] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

export interface PiManagedSettings {
  /** 插话（steer）默认送达模式 */
  steeringMode?: DeliveryMode;
  /** 跟发（followUp）默认送达模式 */
  followUpMode?: DeliveryMode;
  compaction?: {
    enabled?: boolean;
    reserveTokens?: number;
    keepRecentTokens?: number;
  };
  retry?: {
    enabled?: boolean;
    maxRetries?: number;
  };
  /** 启动时启用的内置工具（undefined = 跟随 Pi 默认） */
  defaultTools?: string[];
  /** 模型范围（enabledModels）：glob 模式匹配 provider/modelId，可带 :thinkingLevel 后缀 */
  enabledModels?: string[];
  /** 启动默认模型（对应 CLI 模型选择器 Ctrl+S） */
  defaultProvider?: string;
  defaultModel?: string;
  /** 启动默认推理强度 */
  defaultThinkingLevel?: string;
}

export function getPiSettingsPath(agentDir = getAgentDir()): string {
  return join(agentDir, "settings.json");
}

export function readManagedSettings(settingsPath = getPiSettingsPath()): {
  path: string;
  exists: boolean;
  settings: PiManagedSettings;
} {
  let raw: Record<string, unknown> = {};
  let exists = false;
  if (existsSync(settingsPath)) {
    exists = true;
    try {
      const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>;
      }
    } catch {
      throw new Error(`settings.json 解析失败（${settingsPath}），请先修正文件内容`);
    }
  }

  const pick = <T,>(key: string): T | undefined => (raw[key] === undefined ? undefined : (raw[key] as T));
  return {
    path: settingsPath,
    exists,
    settings: {
      steeringMode: pick<DeliveryMode>("steeringMode"),
      followUpMode: pick<DeliveryMode>("followUpMode"),
      compaction: pick<PiManagedSettings["compaction"]>("compaction"),
      retry: pick<PiManagedSettings["retry"]>("retry"),
      defaultTools: pick<string[]>("defaultTools"),
      enabledModels: pick<string[]>("enabledModels"),
      defaultProvider: pick<string>("defaultProvider"),
      defaultModel: pick<string>("defaultModel"),
      defaultThinkingLevel: pick<string>("defaultThinkingLevel"),
    },
  };
}

/** 校验待写入的子集；非法内容直接抛错，不产生半写状态 */
export function validateManagedPatch(patch: unknown): Partial<PiManagedSettings> {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("Invalid settings payload: expected object");
  }
  const p = patch as Record<string, unknown>;
  const out: Partial<PiManagedSettings> = {};

  for (const key of ["steeringMode", "followUpMode"] as const) {
    const v = p[key];
    if (v === undefined) continue;
    if (typeof v !== "string" || !(DELIVERY_MODES as readonly string[]).includes(v)) {
      throw new Error(`${key} 必须是 "all" 或 "one-at-a-time"`);
    }
    out[key] = v as DeliveryMode;
  }

  if (p.compaction !== undefined) {
    const c = p.compaction as Record<string, unknown>;
    if (c === null || typeof c !== "object" || Array.isArray(c)) throw new Error("compaction 必须是对象");
    const comp: PiManagedSettings["compaction"] = {};
    if (c.enabled !== undefined) {
      if (typeof c.enabled !== "boolean") throw new Error("compaction.enabled 必须是布尔值");
      comp.enabled = c.enabled;
    }
    for (const k of ["reserveTokens", "keepRecentTokens"] as const) {
      if (c[k] === undefined) continue;
      if (typeof c[k] !== "number" || !Number.isInteger(c[k]) || (c[k] as number) < 0 || (c[k] as number) > 1_000_000) {
        throw new Error(`compaction.${k} 必须是 0~1000000 的整数`);
      }
      comp[k] = c[k] as number;
    }
    out.compaction = comp;
  }

  if (p.retry !== undefined) {
    const r = p.retry as Record<string, unknown>;
    if (r === null || typeof r !== "object" || Array.isArray(r)) throw new Error("retry 必须是对象");
    const retry: PiManagedSettings["retry"] = {};
    if (r.enabled !== undefined) {
      if (typeof r.enabled !== "boolean") throw new Error("retry.enabled 必须是布尔值");
      retry.enabled = r.enabled;
    }
    if (r.maxRetries !== undefined) {
      if (typeof r.maxRetries !== "number" || !Number.isInteger(r.maxRetries) || r.maxRetries < 0 || r.maxRetries > 10) {
        throw new Error("retry.maxRetries 必须是 0~10 的整数");
      }
      retry.maxRetries = r.maxRetries;
    }
    out.retry = retry;
  }

  if (p.defaultTools !== undefined) {
    const BUILTINS = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
    if (!Array.isArray(p.defaultTools)) throw new Error("defaultTools 必须是字符串数组");
    if (!p.defaultTools.every((t) => typeof t === "string" && BUILTINS.has(t))) {
      throw new Error("defaultTools 含未知工具名");
    }
    out.defaultTools = p.defaultTools as string[];
  }

  if (p.enabledModels !== undefined) {
    if (p.enabledModels === null) {
      out.enabledModels = undefined;
    } else if (Array.isArray(p.enabledModels)) {
      const patterns = p.enabledModels as unknown[];
      if (patterns.length > 100) throw new Error("enabledModels 最多 100 条模式");
      if (!patterns.every((t) => typeof t === "string" && t.trim().length > 0 && t.length <= 300)) {
        throw new Error("enabledModels 必须是 1~300 字符的非空字符串数组");
      }
      out.enabledModels = (patterns as string[]).map((t) => t.trim());
    } else {
      throw new Error("enabledModels 必须是字符串数组");
    }
  }

  const THINKING_LEVELS = new Set(["auto", "off", "minimal", "low", "medium", "high"]);
  for (const key of ["defaultProvider", "defaultModel"] as const) {
    const v = p[key];
    if (v === undefined) continue;
    if (v === null) {
      out[key] = undefined;
    } else if (typeof v === "string" && v.length > 0 && v.length <= 200 && !/[\s/\\]/.test(v)) {
      out[key] = v;
    } else {
      throw new Error(`${key} 必须是不含空白与路径分隔符的字符串`);
    }
  }
  if (p.defaultThinkingLevel !== undefined) {
    if (p.defaultThinkingLevel === null) {
      out.defaultThinkingLevel = undefined;
    } else if (typeof p.defaultThinkingLevel === "string" && THINKING_LEVELS.has(p.defaultThinkingLevel)) {
      out.defaultThinkingLevel = p.defaultThinkingLevel;
    } else {
      throw new Error("defaultThinkingLevel 不合法");
    }
  }

  return out;
}

/** 这些键会改变 /api/models 的结果，写入后必须让 60s 的模型缓存立即失效。 */
const MODEL_AFFECTING_KEYS = new Set([
  "enabledModels",
  "defaultProvider",
  "defaultModel",
  "defaultThinkingLevel",
]);

/** 将受管子集合并写入 settings.json（其余键保留） */
export function writeManagedSettings(patch: Partial<PiManagedSettings>, settingsPath = getPiSettingsPath()): void {
  let raw: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>;
    }
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) {
      delete raw[k];
      continue;
    }
    if (typeof v === "object" && !Array.isArray(v) && v !== null && typeof raw[k] === "object" && raw[k] !== null && !Array.isArray(raw[k])) {
      raw[k] = { ...(raw[k] as Record<string, unknown>), ...(v as Record<string, unknown>) };
    } else {
      raw[k] = v;
    }
  }
  writePrivateFileAtomicSync(settingsPath, JSON.stringify(raw, null, 2) + "\n");
  if (Object.keys(patch).some((key) => MODEL_AFFECTING_KEYS.has(key))) invalidateModelsCache();
}
