"use client";

import { AlertTriangle, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";

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

  const [navFailed, setNavFailed] = useState(false);
  /* M15：错误边界替换了整页，AppShell 已卸载、hashchange 无监听者 —— 同文档改 hash
     不会重新挂载 React 树。必须整页导航才能真正回到默认工作台（不带 #a/<id>/ 前缀）。
     若导航被拦截仍停留在本页，给一条可见的失败提示。 */
  const goHome = () => {
    window.location.assign("/");
    setTimeout(() => setNavFailed(true), 2500);
  };

  return (
    <div className="flex h-dvh w-full items-center justify-center bg-bg px-6 text-fg">
      <div className="w-full max-w-[520px] rounded-card border border-line bg-panel p-6">
        <div className="flex items-center gap-2.5">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-card bg-danger/10 text-danger">
            <AlertTriangle size={16} />
          </div>
          <div className="min-w-0">
            <h1 className="text-[14px] font-bold">界面出错了</h1>
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
          <button onClick={goHome} className="btn btn-ghost" title="整页重载并回到默认工作台">
            回到工作台并重载
          </button>
        </div>
        {navFailed && (
          <p role="alert" className="mt-2 text-[12px] text-danger">
            未能自动返回，请点「重新加载界面」或手动刷新页面。
          </p>
        )}
      </div>
    </div>
  );
}
