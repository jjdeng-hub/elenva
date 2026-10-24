"use client";

import { useEffect, useState } from "react";
import { cn } from "@/components/lib/utils";

/** 通用空状态 */
export function EmptyState({
  icon,
  title,
  hint,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  hint?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center py-14 text-center", className)}>
      {icon && (
        <div className="flex size-12 items-center justify-center rounded-card bg-accent-soft text-accent">{icon}</div>
      )}
      <div className="mt-3 text-[14px] font-medium text-fg">{title}</div>
      {hint && <div className="mt-1 max-w-sm text-[12px] leading-relaxed text-dim">{hint}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** 骨架屏块 */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("anim-pulse rounded-md bg-panel-2", className)} />;
}

/**
 * 慢加载提示：骨架屏超过 afterMs 仍未结束时补一句说明。
 * 没有它，几秒以上的加载看起来就像卡死 —— 用户只能猜是不是坏了。
 */
export function SlowHint({
  afterMs = 1500,
  hint,
  className,
}: {
  afterMs?: number;
  hint?: string;
  className?: string;
}) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), afterMs);
    return () => clearTimeout(timer);
  }, [afterMs]);
  if (!slow) return null;
  return (
    <div role="status" className={cn("text-[11px] leading-relaxed text-dim", className)}>
      仍在加载…{hint ? ` · ${hint}` : ""}
    </div>
  );
}

/** 消息加载骨架屏：右侧用户气泡 + 左侧回复块 */
export function ChatSkeleton() {
  return (
    <div className="flex flex-col gap-5 py-2">
      <div className="flex justify-end">
        <Skeleton className="h-8 w-56 rounded-card" />
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3.5 w-3/4" />
        <Skeleton className="h-3.5 w-2/3" />
        <Skeleton className="h-3.5 w-1/2" />
      </div>
      <div className="flex justify-end">
        <Skeleton className="h-8 w-40 rounded-card" />
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3.5 w-5/6" />
        <Skeleton className="h-3.5 w-1/2" />
      </div>
    </div>
  );
}

/** 列表加载骨架屏 */
export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-3 p-4">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="size-7 shrink-0 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className="h-3 w-2/5" />
            <Skeleton className="h-2.5 w-4/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** 资源页统一页头（模型/技能/插件/设置等窄列表单页使用） */
export function PageHeader({
  icon,
  title,
  subtitle,
  actions,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex items-center gap-2.5">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-card bg-accent-soft text-accent">{icon}</div>
      <div className="min-w-0">
        <h2 className="text-[16px] font-bold leading-tight text-fg">{title}</h2>
        {subtitle && <p className="mt-0.5 text-[12px] text-dim">{subtitle}</p>}
      </div>
      {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
