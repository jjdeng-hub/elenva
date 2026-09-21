"use client";

import { AlertTriangle, RotateCcw } from "lucide-react";
import { useEffect } from "react";

/**
 * 全局错误边界。
 *
 * 此前没有它：任何一个组件抛错都会让整页白屏，用户只能刷新 —— 对一个「本地跑 agent
 * 的控制台」来说，白屏时连“现在 agent 跑到哪了”都看不到。这里至少保住外壳并给出恢复入口。
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("ELENVA 界面异常:", error);
  }, [error]);

  return (
    <div className="flex h-dvh w-full items-center justify-center bg-bg px-6 text-fg">
      <div className="w-full max-w-[520px] rounded-card border border-line bg-panel p-6">
        <div className="flex items-center gap-2.5">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-card bg-danger/10 text-danger">
            <AlertTriangle size={16} />
          </div>
          <div className="min-w-0">
            <div className="text-[14px] font-bold">界面出错了</div>
            <div className="text-[12px] text-dim">会话数据本身没有丢失，它们仍然在本机 ~/.pi/agent/sessions</div>
          </div>
        </div>

        <pre className="mt-4 max-h-40 overflow-auto rounded-lg border border-line bg-panel-2 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted">
          {error.message || "未知错误"}
          {error.digest ? `\n\ndigest: ${error.digest}` : ""}
        </pre>

        <div className="mt-4 flex items-center gap-2">
          <button onClick={reset} className="btn btn-primary" data-testid="error-retry">
            <RotateCcw size={12} /> 重新加载界面
          </button>
          <button onClick={() => window.location.assign("#home")} className="btn btn-ghost">
            回到工作台
          </button>
        </div>
      </div>
    </div>
  );
}
