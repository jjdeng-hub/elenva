"use client";

import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "@/components/lib/utils";

/**
 * 卡片三件套（2026-09-21 一致性收编）：
 * 页面里所有「圆角 + 边框 + 面板底」的信息卡、卡片头、卡片标题统一从这里取，
 * 不再手写类名 —— 此前同一套壳/头在 9 个文件里各写了一份。
 * 注：对话框 / 浮层容器（dialog、popover、下拉面板）是另一类表面，不并入 Card。
 */

/** 卡片外壳。额外布局类（mb、flex-col、order 等）用 className 传入；其余属性（id / onMouseDown 等）原样透传。 */
export function Card({
  children,
  className,
  testId,
  ...rest
}: ComponentPropsWithoutRef<"section"> & { testId?: string }) {
  return (
    <section data-testid={testId} className={cn("rounded-card border border-line bg-panel", className)} {...rest}>
      {children}
    </section>
  );
}

/** 卡片头部：图标 / 标题 / 元信息 / 右侧动作 的统一容器。 */
export function CardHeader({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex items-center gap-2 border-b border-line-soft px-4 py-3", className)}>{children}</div>;
}

/** 卡片标题：13px / 600 / 前景色，防各页自定字号。 */
export function CardTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("text-[13px] font-semibold text-fg", className)}>{children}</span>;
}
