import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { getPiSettingsPath } from "./pi-user-settings";
import { backupSettingsFile } from "./settings-backup";

export interface ExplicitStartupPreferences {
  model?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
}

export interface EffectiveStartupPreferences {
  model?: { provider: string; modelId: string };
  thinkingLevel: ThinkingLevel;
  supportsThinking: boolean;
}

/**
 * Persist explicit browser selections without re-running AgentSession setters.
 *
 * The session constructor already records the effective model and thinking
 * level. Calling setModel()/setThinkingLevel() again would append duplicate
 * session entries and emit duplicate extension events.
 */
export async function persistExplicitStartupPreferences(
  settingsManager: SettingsManager,
  explicit: ExplicitStartupPreferences,
  effective: EffectiveStartupPreferences,
): Promise<{ modelDefaultChanged: boolean }> {
  if (!explicit.model && !explicit.thinkingLevel) {
    return { modelDefaultChanged: false };
  }

  const willWriteModel = Boolean(
    explicit.model
    && effective.model
    && explicit.model.provider === effective.model.provider
    && explicit.model.modelId === effective.model.modelId,
  );
  const willWriteThinking = Boolean(
    explicit.thinkingLevel
    && (effective.supportsThinking || effective.thinkingLevel !== "off"),
  );
  if (!willWriteModel && !willWriteThinking) return { modelDefaultChanged: false };

  // 写启动默认前留一份可回滚副本（B1）：手选模型会改变所有新会话的落选，回滚入口只有这一处文件。
  backupSettingsFile(getPiSettingsPath(), "handpick");

  let modelDefaultChanged = false;

  if (willWriteModel && effective.model) {
    settingsManager.setDefaultModelAndProvider(
      effective.model.provider,
      effective.model.modelId,
    );
    modelDefaultChanged = true;
  }

  if (willWriteThinking) {
    settingsManager.setDefaultThinkingLevel(effective.thinkingLevel);
  }

  await settingsManager.flush();
  return { modelDefaultChanged };
}
