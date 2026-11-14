"use client";

import { useMemo, useSyncExternalStore } from "react";
import type { CueName } from "uisfx";
import {
  addSoundListener,
  getSoundPreferences,
  isSoundUnlocked,
  playCue,
  registerUseSound,
  updateSoundPreferences,
  type SoundLevel,
  type SoundPack,
  type SoundPreferences,
  type UseSoundResult,
} from "@/lib/sound";

const getSnapshot = () => getSoundPreferences();
const getServerSnapshot = () => getSoundPreferences();

/**
 * useSound() 的真实实现（lib/sound.ts 无 React 依赖，由这里 registerUseSound 注入）。
 * 订阅 lib 内偏好变化（含 visibilitychange、updateSoundPreferences 触发的 notify）。
 */
function useSound(): UseSoundResult {
  const subscribe = (cb: () => void) => addSoundListener(cb);
  const prefs = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const unlocked = useSyncExternalStore(
    subscribe,
    () => isSoundUnlocked(),
    () => false,
  );

  // 返回稳定引用：调用方会把 sound 放进依赖数组，每次新建对象会让依赖永远变（React #185）。
  return useMemo<UseSoundResult>(() => {
    const preferences: SoundPreferences = { ...prefs };
    return {
      prefs: preferences,
      unlocked,
      setEnabled: (enabled: boolean) => void updateSoundPreferences({ enabled }),
      setLevel: (level: SoundLevel) => void updateSoundPreferences({ level }),
      setPack: (pack: SoundPack) => void updateSoundPreferences({ pack }),
      setLoop: (loop: boolean) => void updateSoundPreferences({ loop }),
      play: (cue: CueName) => void playCue(cue),
    };
  }, [prefs, unlocked]);
}

registerUseSound(useSound);

export { useSound };
export default useSound;
