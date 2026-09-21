"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useLayoutEffect, useState } from "react";
import { applyThemePreference, isThemePreference, readThemePreference, THEME_OPTIONS, type ThemePreference } from "@/lib/theme";

const META: Record<ThemePreference, { label: string; Icon: typeof Sun }> = {
  light: { label: "浅色（点击切换到深色）", Icon: Sun },
  dark: { label: "深色（点击切换到跟随系统）", Icon: Moon },
  auto: { label: "跟随系统（点击切换到浅色）", Icon: Monitor },
};

/** 顶栏主题切换：单击在 浅色 → 深色 → 跟随系统 之间循环。 */
export function ThemeToggle() {
  const [pref, setPref] = useState<ThemePreference>("auto");

  useEffect(() => {
    const current = readThemePreference();
    if (isThemePreference(current)) setPref(current);
  }, []);

  // React 开发态 Strict Mode 会重挂载组件并把 <html> 的 attributes 重置回 JSX 所写的值，
  // 防闪烁脚本写入的 data-theme 会被清掉 —— 按官方指南（preventing-flash-before-hydration）
  // 在此重放；生产构建没有这次重挂载，此处的执行是幂等 no-op。
  useLayoutEffect(() => {
    applyThemePreference(readThemePreference());
  }, []);

  const cycle = () => {
    const next = THEME_OPTIONS[(THEME_OPTIONS.indexOf(pref) + 1) % THEME_OPTIONS.length];
    setPref(next);
    applyThemePreference(next);
  };

  const { label, Icon } = META[pref];

  return (
    <button
      onClick={cycle}
      className="flex size-8 cursor-pointer items-center justify-center rounded-full text-dim t-fast hover:bg-hover hover:text-fg"
      title={label}
      aria-label={`主题：${label}`}
    >
      <Icon size={14} />
    </button>
  );
}
