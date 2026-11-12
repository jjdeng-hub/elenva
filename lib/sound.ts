"use client";

/**
 * UI 音效单例（规格：docs/specs/2026-11-12-ui-sound.md）。
 *
 * - uisfx@0.4.0，客户端 only：模块级惰性单例，SSR 下全部 no-op
 * - unlock：首次 pointerdown/keydown 解锁；解锁前丢弃播放（避免延迟炸出旧音）
 * - 音量：标签页不可见 ×1.0、可见 ×0.55（切走了才需要叫住人）
 * - 偏好存 localStorage `elenva:sound`：{ enabled, level, pack, loop }
 * - 响度与去重交给库的冷却参数，不自己写定时器
 */

import type { CueName, UISFXPlayer } from "uisfx";

export type SoundLevel = "muted" | "light" | "standard";
export type SoundPack = "minimal" | "studio" | "scifi" | "soft";

export const SOUND_STORAGE_KEY = "elenva:sound";
export const SOUND_LEVELS: Record<Exclude<SoundLevel, "muted">, number> = {
  light: 0.35,
  standard: 0.6,
};

export interface SoundPreferences {
  enabled: boolean;
  level: SoundLevel;
  pack: SoundPack;
  /** processing loop（>15s 长任务）默认关 */
  loop: boolean;
}

export const DEFAULT_PREFERENCES: SoundPreferences = {
  enabled: true,
  level: "standard",
  pack: "minimal",
  loop: false,
};

function loadPreferences(): SoundPreferences {
  if (typeof window === "undefined") return { ...DEFAULT_PREFERENCES };
  try {
    const raw = window.localStorage.getItem(SOUND_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFERENCES };
    const parsed = JSON.parse(raw) as Partial<SoundPreferences>;
    return {
      enabled: parsed.enabled ?? DEFAULT_PREFERENCES.enabled,
      level: parsed.level === "light" || parsed.level === "muted" ? parsed.level : "standard",
      pack: parsed.pack === "studio" || parsed.pack === "scifi" || parsed.pack === "soft" ? parsed.pack : "minimal",
      loop: parsed.loop ?? DEFAULT_PREFERENCES.loop,
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

function savePreferences(prefs: SoundPreferences): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SOUND_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // 存储满 / 隐私模式：静默忽略，本次会话内仍生效
  }
}

interface SoundState {
  prefs: SoundPreferences;
  /** getSnapshot 的稳定快照（useSyncExternalStore 约束），随偏好更新重建 */
  snapshot: SoundPreferences | null;
  player: UISFXPlayer | null;
  loading: Promise<UISFXPlayer | null> | null;
  unlocked: boolean;
  /** 页面可见性下的音量乘数（可见 0.55 / 隐藏 1.0） */
  visibilityFactor: number;
  listeners: Set<() => void>;
}

const state: SoundState = {
  prefs: { ...DEFAULT_PREFERENCES },
  snapshot: null,
  player: null,
  loading: null,
  unlocked: false,
  visibilityFactor: 0.55,
  listeners: new Set(),
};

function notify(): void {
  for (const listener of state.listeners) listener();
}

function effectiveVolume(): number {
  if (!state.prefs.enabled || state.prefs.level === "muted") return 0;
  return SOUND_LEVELS[state.prefs.level] * state.visibilityFactor;
}

async function ensurePlayer(): Promise<UISFXPlayer | null> {
  if (state.player) return state.player;
  if (state.loading) return state.loading;
  if (typeof window === "undefined") return null;
  state.loading = (async () => {
    try {
      const { createUISFX } = await import("uisfx");
      const player = createUISFX({ pack: state.prefs.pack, volume: effectiveVolume(), enabled: state.prefs.enabled });
      state.player = player;
      notify();
      return player;
    } catch (e) {
      console.warn("uisfx 加载失败，音效停用", e);
      return null;
    } finally {
      state.loading = null;
    }
  })();
  return state.loading;
}

function ensureUnlockListener(): void {
  if (typeof window === "undefined" || state.unlocked) return;
  const unlock = () => {
    state.unlocked = true;
    void ensurePlayer().then((player) => {
      if (player) void player.unlock();
    });
  };
  window.addEventListener("pointerdown", unlock, { capture: true, once: true });
  window.addEventListener("keydown", unlock, { capture: true, once: true });
}

if (typeof window !== "undefined") {
  state.prefs = loadPreferences();
  state.visibilityFactor = document.visibilityState === "hidden" ? 1.0 : 0.55;
  document.addEventListener("visibilitychange", () => {
    state.visibilityFactor = document.visibilityState === "hidden" ? 1.0 : 0.55;
    const player = state.player;
    if (player) player.setVolume(effectiveVolume());
    notify();
  });
  ensureUnlockListener();
}

export function getSoundPreferences(): SoundPreferences {
  // useSyncExternalStore 要求 getSnapshot 引用稳定：只在偏好变化时重建快照，
  // 每次返回新对象会让 React 判定「快照永远在变」→ 无限重渲（真机实测踩过）。
  if (!state.snapshot) state.snapshot = { ...state.prefs };
  return state.snapshot;
}

function refreshSnapshot(): void {
  state.snapshot = { ...state.prefs };
}

export function updateSoundPreferences(patch: Partial<SoundPreferences>): SoundPreferences {
  state.prefs = { ...state.prefs, ...patch };
  refreshSnapshot();
  savePreferences(state.prefs);
  const player = state.player;
  if (player) {
    player.setEnabled(state.prefs.enabled);
    player.setVolume(effectiveVolume());
    if (player.getPack() !== state.prefs.pack) player.setPack(state.prefs.pack);
  }
  notify();
  return { ...state.prefs };
}

export function isSoundUnlocked(): boolean {
  return state.unlocked;
}

/** 供 React 订阅偏好/解锁状态变化（notify 时回调） */
export function addSoundListener(listener: () => void): () => void {
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

/**
 * 播放一个 cue。解锁前、静音时、SSR 下全部 no-op（不排队，直接丢弃）。
 * 返回 PlayingSFX（调用方负责在结束时 `stop()`，仅 loop cue 需要）。
 */
export function playCue(
  cue: CueName,
  options?: { volume?: number; loop?: boolean; retrigger?: "restart" | "overlap" | "ignore" },
): ReturnType<UISFXPlayer["play"]> {
  if (!state.prefs.enabled || state.prefs.level === "muted") return null;
  if (!state.unlocked) return null;
  void ensurePlayer();
  const player = state.player;
  if (!player) return null;
  return player.play(cue, options ?? {});
}

// ---------------------------------------------------------------------------
// useSound()：React 侧入口。订阅偏好变化，暴露当前状态与动作。
// ---------------------------------------------------------------------------

export interface UseSoundResult {
  prefs: SoundPreferences;
  unlocked: boolean;
  setEnabled: (enabled: boolean) => void;
  setLevel: (level: SoundLevel) => void;
  setPack: (pack: SoundPack) => void;
  setLoop: (loop: boolean) => void;
  play: (cue: CueName) => void;
}

let useSoundImpl: (() => UseSoundResult) | null = null;

/**
 * useSound()：组件里唯一该用的入口。为保持 lib 无 React 依赖，
 * 真正的 hook 实现由 hooks/useSound.ts 注入（"use client" 模块）。
 */
export function useSound(): UseSoundResult {
  if (!useSoundImpl) throw new Error("useSound 实现未注册：请在客户端入口 import '@/hooks/useSound'");
  return useSoundImpl();
}

export function registerUseSound(impl: () => UseSoundResult): void {
  useSoundImpl = impl;
}

export type { CueName };
