import type { Metadata, Viewport } from "next";
import { PwaRegistration } from "@/components/PwaRegistration";
import { ThemeInitScript } from "@/components/ThemeInitScript";
import { DialogHost, ToastHost } from "@/components/ui/dialog";
/* LaTeX 公式排版样式：lib/markdown 的 rehype-katex 会输出 .katex 结构，
   缺了这份样式表公式就是一堆错位的裸 span。 */
import "katex/dist/katex.min.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "ELENVA · 工作台",
  description: "ELENVA 工作站 —— pi coding agent 控制台",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f5f2" },
    { media: "(prefers-color-scheme: dark)", color: "#161614" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        {/* 首屏防闪烁：在水合前写入 data-theme，避免深色刷新时闪白。
            用 InlineScript 包一层是 Next 官方方案 —— 裸 <script> 会触发
            React 19 的 "Encountered a script tag" 告警（见 components/InlineScript.tsx）。 */}
        <ThemeInitScript />
      </head>
      <body suppressHydrationWarning>
        {children}
        <PwaRegistration />
        <DialogHost />
        <ToastHost />
      </body>
    </html>
  );
}
