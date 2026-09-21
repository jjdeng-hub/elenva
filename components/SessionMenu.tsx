"use client";

import { Ellipsis, Copy, Share } from "lucide-react";
import { MenuItem, Popover } from "@/components/ui/popover";
import type { SessionActions } from "@/hooks/useSessionActions";

/**
 * 会话操作菜单（「…」）。
 *
 * 这里**刻意只留两项低频、无更合适归属的操作**：克隆会话、导出 HTML。
 * 其余曾经也在这里的动作已经搬到上下文更贴切的位置：
 *   · 重命名 / 删除 / AI 命名 → 会话标题旁（点标题即可内联重命名）
 *   · 压缩上下文 → 观测栏的上下文窗口区 + 输入框的上下文环
 *   · 会话统计 → 观测栏已覆盖其全部数据（面板本身已移除）
 *
 * 保留这两项也是为了让**窄屏**（观测栏被强制隐藏时）仍有入口。
 */
export function SessionMenu({
  actions,
  disabled,
}: {
  actions: SessionActions;
  disabled?: boolean;
}) {
  const busy = actions.busy || disabled;
  return (
    <Popover
      containerClassName={busy ? "pointer-events-none" : ""}
      panelClassName="w-40 py-1"
      trigger={({ toggle }) => (
        <button
          onClick={toggle}
          disabled={busy}
          data-testid="session-menu"
          className="flex size-8 cursor-pointer items-center justify-center rounded-lg border border-line bg-panel-2 text-muted t-fast hover:text-fg"
          title="更多会话操作"
        >
          <Ellipsis size={14} />
        </button>
      )}
    >
      {(close) => (
        <>
          <MenuItem
            icon={<Copy size={12} />}
            label="克隆会话"
            onClick={() => {
              close();
              void actions.clone();
            }}
          />
          <MenuItem
            icon={<Share size={12} />}
            label="导出 HTML"
            onClick={() => {
              close();
              actions.exportHtml();
            }}
          />
        </>
      )}
    </Popover>
  );
}
