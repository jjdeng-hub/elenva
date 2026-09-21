import type { MetadataRoute } from "next";

/**
 * PWA manifest：让界面可以被"安装"成独立窗口应用（开始菜单图标 + 无浏览器 UI）。
 *
 * `display: "standalone"` 是桌面化效果的关键 —— 安装后窗口不再有地址栏与标签页，
 * 视觉上与原生应用无异。图标由 tools/make-pwa-icons.py 从 LogoMark 生成。
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "ELENVA 工作台",
    short_name: "ELENVA",
    description: "本地运行的 AI 工作台 —— 基于 pi coding agent",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f6f5f2",
    theme_color: "#f6f5f2",
    categories: ["productivity", "developer"],
    lang: "zh-CN",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        // LogoMark 居中占 62%，落在 maskable 安全区内，Android 圆形裁剪后不会切到图形
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
