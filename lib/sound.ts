"use client";

/**
 * UI 音效单例（规格：docs/specs/2026-11-12-ui-sound.md）。
 *
 * - uisfx@0.4.0，客户端 only：模块级惰性单例，SSR 下全部 no-op
 * - unlock：首次 pointerdown/keydown 解锁；解锁前丢弃播放（避免延迟炸出旧音）
 * - 音量：偏好里是 0~3 的倍率（设置页 0~300%），实际增益 = 倍率 × 可见性系数
 *   （标签页不可见 ×1.0、可见 ×0.55 —— 切走了才需要叫住人）
 * - **为什么自己再接一级 Gain**：uisfx 的 `setVolume` 在库内被钳到 0..1（实测源码
 *   `Math.max(0, Math.min(1, v))`），只靠它喊不大声；这里给库一个「destination 指向
 *   自家 GainNode」的 AudioContext 代理，放大才能超过 1.0。
 *   代理后面串一个限幅器（DynamicsCompressor 当 limiter），高倍率下不至于削顶失真
 * - **为什么还要把 per-voice 增益顶满**：uisfx 每条声还会再乘一次 `defaultVolume`（0.17~0.24，
 *   即 -13 dB），这是「几乎听不见」的主因；一次性 cue 一律传 volume=1，滑动倍率统一控制响度
 * - 偏好存 localStorage `elenva:sound`：{ enabled, volume, pack, loop }
 * - 响度与去重交给库的冷却参数，不自己写定时器
 */

import type { CueName, UISFXPlayer } from "uisfx";

export type SoundPack = "minimal" | "studio" | "scifi" | "soft";

export const SOUND_STORAGE_KEY = "elenva:sound";
/** 音量滑杆上限 300%：再高会给限幅器加压，听感变化已经很小 */
export const MAX_VOLUME = 3;
/** 旧版三档（level）→ 新倍率，读老 localStorage 时迁移一次（对齐新预设的响度） */
const LEGACY_LEVEL_VOLUME: Record<string, number> = { muted: 0, light: 0.8, standard: 1.5 };

export interface SoundPreferences {
  enabled: boolean;
  /** 音量倍率 0~MAX_VOLUME（1 = 100%） */
  volume: number;
  pack: SoundPack;
  /** processing loop（>15s 长任务）默认关 */
  loop: boolean;
}

export const DEFAULT_PREFERENCES: SoundPreferences = {
  enabled: true,
  // 150%：一次性 cue 已在 per-voice 顶到满，150% 大约是 -19 dBFS RMS，笔记本喇叭听得清
  volume: 1.5,
  pack: "minimal",
  loop: false,
};

function clampVolume(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(MAX_VOLUME, value));
}

function loadPreferences(): SoundPreferences {
  if (typeof window === "undefined") return { ...DEFAULT_PREFERENCES };
  try {
    const raw = window.localStorage.getItem(SOUND_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFERENCES };
    const parsed = JSON.parse(raw) as Partial<SoundPreferences> & { level?: string };
    // 旧档位（muted/light/standard）只在没有新字段时兜底，避免覆盖用户后来调过的滑杆
    const legacy = typeof parsed.level === "string" ? LEGACY_LEVEL_VOLUME[parsed.level] : undefined;
    const volume = clampVolume(parsed.volume ?? legacy, DEFAULT_PREFERENCES.volume);
    return {
      enabled: parsed.enabled ?? DEFAULT_PREFERENCES.enabled,
      volume,
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
  /** 接在库输出与真实 destination 之间的放大级（null = 退回库默认输出，最大 1.0） */
  boost: GainNode | null;
  loading: Promise<UISFXPlayer | null> | null;
  unlocked: boolean;
  /** 页面可见性下的增益乘数（可见 0.55 / 隐藏 1.0） */
  visibilityFactor: number;
  listeners: Set<() => void>;
}

const state: SoundState = {
  prefs: { ...DEFAULT_PREFERENCES },
  snapshot: null,
  player: null,
  boost: null,
  loading: null,
  unlocked: false,
  visibilityFactor: 0.55,
  listeners: new Set(),
};

function notify(): void {
  for (const listener of state.listeners) listener();
}

/** 最终增益：偏好倍率 × 可见性系数；关掉声音时为 0 */
function effectiveGain(): number {
  if (!state.prefs.enabled) return 0;
  return clampVolume(state.prefs.volume, 0) * state.visibilityFactor;
}

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/**
 * 建一个「destination 换成自家增益链」的 AudioContext 代理，交给 uisfx 使用。
 * 链：库 master gain → boost（设置里的倍率）→ limiter → 真实输出。
 * 限幅器只在接近 0 dBFS 时动作，高倍率下把峰值压住而不是硬削顶。
 * 库只碰 currentTime / state / resume / createGain / createBuffer / createBufferSource /
 * connect / close，代理把 destination 换成自家增益链、其余原样转发即可。
 */
function createBoostedContext(gain: number): { context: AudioContext; boost: GainNode } | null {
  const Ctor = audioContextCtor();
  if (!Ctor) return null;
  try {
    const ctx = new Ctor({ latencyHint: "interactive" });
    const boost = ctx.createGain();
    boost.gain.value = Math.max(0, gain);
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.12;
    boost.connect(limiter);
    limiter.connect(ctx.destination);
    const context = new Proxy(ctx, {
      get(target, prop) {
        if (prop === "destination") return boost;
        const value = Reflect.get(target, prop, target) as unknown;
        // AudioContext 的方法必须绑在真实实例上调用，否则 Illegal invocation
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as AudioContext;
    return { context, boost };
  } catch (e) {
    console.warn("音效增益节点创建失败，退回库默认输出（音量上限 100%）", e);
    return null;
  }
}

async function ensurePlayer(): Promise<UISFXPlayer | null> {
  if (state.player) return state.player;
  if (state.loading) return state.loading;
  if (typeof window === "undefined") return null;
  state.loading = (async () => {
    try {
      const { createUISFX } = await import("uisfx");
      const boosted = createBoostedContext(effectiveGain());
      state.boost = boosted?.boost ?? null;
      const player = createUISFX({
        pack: state.prefs.pack,
        // 有放大级时库内主音量钉在 1（缩放全在 boost 上）；没有时只能钳回 0..1
        volume: boosted ? 1 : Math.min(1, effectiveGain()),
        enabled: state.prefs.enabled,
        context: boosted?.context,
      });
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

function applyGain(): void {
  const player = state.player;
  if (player) player.setVolume(state.boost ? 1 : Math.min(1, effectiveGain()));
  const boost = state.boost;
  if (!boost) return;
  const gain = effectiveGain();
  const now = boost.context.currentTime;
  try {
    boost.gain.cancelScheduledValues(now);
    boost.gain.setTargetAtTime(gain, now, 0.015);
  } catch {
    boost.gain.value = gain;
  }
}

function ensureUnlockListener(): void {
  if (typeof window === "undefined" || state.unlocked) return;
  const unlock = () => {
    state.unlocked = true;
    void ensurePlayer().then((player) => {
      if (player) void player.unlock();
      notify();
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
    applyGain();
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
  const next: SoundPreferences = { ...state.prefs, ...patch };
  if (patch.volume !== undefined) next.volume = clampVolume(patch.volume, state.prefs.volume);
  // 调大音量本身就是「我要听到」：顺手解开总开关（与旧版三档音量按钮的行为一致）
  if (patch.volume !== undefined && next.volume > 0 && patch.enabled === undefined) next.enabled = true;
  state.prefs = next;
  refreshSnapshot();
  savePreferences(state.prefs);
  const player = state.player;
  if (player) {
    player.setEnabled(state.prefs.enabled);
    if (player.getPack() !== state.prefs.pack) player.setPack(state.prefs.pack);
  }
  applyGain();
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
  if (!state.prefs.enabled || state.prefs.volume <= 0) return null;
  if (!state.unlocked) return null;
  void ensurePlayer();
  const player = state.player;
  if (!player) return null;
  // 一次性 cue 把库内 per-voice 增益顶满（库默认 0.17~0.24 = 再降 13 dB）；
  // 显式传了 volume（如长任务 loop 的 0.35）则尊重调用方。
  return player.play(cue, { ...options, volume: options?.volume ?? 1 });
}

// ---------------------------------------------------------------------------
// useSound()：React 侧入口。订阅偏好变化，暴露当前状态与动作。
// ---------------------------------------------------------------------------

export interface UseSoundResult {
  prefs: SoundPreferences;
  unlocked: boolean;
  setEnabled: (enabled: boolean) => void;
  setVolume: (volume: number) => void;
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
