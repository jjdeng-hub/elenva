/**
 * 内联脚本（Next.js 官方方案，见 docs/app/guides/preventing-flash-before-hydration）。
 *
 * React 19 在客户端渲染出 `<script>` 时会报
 * "Encountered a script tag while rendering React component"。官方给的解法是让
 * 服务端与客户端渲染出不同的 `type`：
 *   · 服务端 `text/javascript` —— 浏览器解析 HTML 时同步执行（防闪烁的关键）
 *   · 客户端 `text/plain`     —— 不被当作可执行脚本，React 因此不再告警
 * 两者的差异由 `suppressHydrationWarning` 接受。
 *
 * 必须在客户端组件里使用，否则客户端分支永远不会走到（组件只会被服务端渲染）。
 */
export function InlineScript({ html }: { html: string }) {
  return (
    <script
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
