/**
 * 外观主题：浅色 / 深色 / 跟随系统 —— 只此三项。
 *
 * 颜色的唯一来源是 globals.css 的语义变量：浅色写在 `:root`，
 * 深色写在 `[data-theme="dark"]`。组件层不感知主题，只消费变量。
 * 因此切换主题 = 改 `<html data-theme>` 一个属性，无重渲染成本。
 */

export const THEME_STORAGE_KEY = "pi-theme";

export const THEME_OPTIONS = ["light", "dark", "auto"] as const;

export type ThemePreference = (typeof THEME_OPTIONS)[number];
/** 落到 DOM 上的实际主题（auto 会被解析成 light / dark）。 */
export type ResolvedTheme = Exclude<ThemePreference, "auto">;

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && (THEME_OPTIONS as readonly string[]).includes(value);
}

/** 读取用户偏好；无有效存储值时返回 auto。 */
export function readThemePreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemePreference(saved)) return saved;
  } catch {
    /* localStorage 被禁用时静默降级 */
  }
  return "auto";
}

/** 把偏好解析成实际主题。 */
export function resolveTheme(pref: ThemePreference): ResolvedTheme {
  if (pref !== "auto") return pref;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** 应用主题到 `<html data-theme>` 并持久化偏好。 */
export function applyThemePreference(pref: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    /* 忽略写入失败，本次会话仍然生效 */
  }
  document.documentElement.dataset.theme = resolveTheme(pref);
}

/**
 * 首屏防闪烁脚本：在 React 水合之前就把 data-theme 写上，
 * 否则刷新深色页面会先闪一帧白底。注入位置见 app/layout.tsx。
 */
export const THEME_INIT_SCRIPT = `(function(){var d=document.documentElement;var p="auto";try{var s=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(${JSON.stringify(THEME_OPTIONS)}.includes(s))p=s}catch(e){}d.dataset.theme=p==="auto"?(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):p})();`;
