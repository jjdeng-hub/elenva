/**
 * 品牌 logo：外方框（确定性）内嵌 C 形缺口 + 红色出口块。
 * 口号：在确定性中寻找出口。
 * 黑色部分用 currentColor（跟随主题前景色），红色块用 var(--accent)。
 */
export function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      {/* 外方框 */}
      <rect x="7.5" y="7.5" width="49" height="49" stroke="currentColor" strokeWidth="7" fill="none" />
      {/* 内嵌 C（开口朝右） */}
      <path d="M42 22 H22 V42 H42" stroke="currentColor" strokeWidth="6.5" fill="none" />
      {/* 出口红块 */}
      <rect x="31" y="28.75" width="13" height="6.5" fill="var(--accent)" />
    </svg>
  );
}

export function Logo({ action }: { action?: React.ReactNode }) {
  return (
    <div className="px-2 pb-3 pt-1">
      <div className="flex items-center gap-2.5">
        <LogoMark size={20} />
        <span className="text-[16px] font-bold tracking-[0.12em]">ELENVA</span>
        {/* 版本号是要核对的信息（报告 bug 时要报的），不是装饰角标 —— 抬到 11px 底线
            （impeccable 的 undersized-ui-text：功能性文字 10px 在高 DPI 与窄视口上会读不清） */}
        <span className="ml-auto rounded-sm bg-panel-2 px-1.5 py-0.5 text-[11px] text-dim">
          {process.env.NEXT_PUBLIC_APP_VERSION || "v0.1"}
        </span>
        {action}
      </div>
      <div className="mt-1.5 pl-0.5 text-[11px] tracking-[0.22em] text-dim">在确定性中寻找出口</div>
    </div>
  );
}
