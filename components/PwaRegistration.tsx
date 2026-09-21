"use client";

import { useEffect } from "react";

/**
 * 注册 service worker（仅生产环境，避免开发时缓存干扰热更新）。
 *
 * 它承担两件事：
 *   1. 离线兜底 —— 本地后端没起来时展示 /offline.html，而不是浏览器的错误页
 *   2. 浏览器通知 —— lib/push-client.ts 依赖 sw 接收推送
 */
export function PwaRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) {
      return;
    }

    const register = () => {
      const appVersion = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";
      const scriptUrl = `/sw.js?v=${encodeURIComponent(appVersion)}`;

      void navigator.serviceWorker
        .register(scriptUrl, { scope: "/", updateViaCache: "none" })
        .catch((error: unknown) => {
          console.error("ELENVA service worker 注册失败:", error);
        });
    };

    if (document.readyState === "complete") {
      register();
      return;
    }

    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
