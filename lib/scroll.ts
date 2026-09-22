/**
 * 把元素居中滚进容器 —— 只动这一个容器，不碰任何祖先。
 *
 * 教训（2026-09-22，页脚「检查更新」落点 bug）：`el.scrollIntoView()` 会连外层
 * `overflow-hidden` 的包裹层一起程序化滚动（幽灵滚动），把整个应用顶出可视区；
 * 且 `behavior:"smooth"` 在隐藏标签页里被 Chrome 静默挂起，自动化验证时看起来
 * 「点了没反应」。这里改为直接设置容器 scrollTop（瞬时、确定），目标位置用两个
 * rect 的差值计算，不依赖 offsetParent 链。
 */
export function centerElementInContainer(container: HTMLElement, element: HTMLElement): void {
  const containerRect = container.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  const offset = elementRect.top - containerRect.top - (container.clientHeight - elementRect.height) / 2;
  container.scrollTop = Math.max(0, container.scrollTop + offset);
}
