"use client";

import { InlineScript } from "@/components/InlineScript";
import { THEME_INIT_SCRIPT } from "@/lib/theme";

/**
 * 首屏防闪烁脚本的挂载点。
 *
 * 必须是一个客户端组件：`InlineScript` 依赖 `typeof window` 在两端渲染出不同的
 * `type`，而服务端组件的客户端分支永远不会执行。实测水合后 DOM 上的
 * `type` 会从 `text/javascript` 变为 `text/plain`（见 README/AGENTS 的验证方式）。
 */
export function ThemeInitScript() {
  return <InlineScript html={THEME_INIT_SCRIPT} />;
}
