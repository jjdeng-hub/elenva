"use client";

import { useEffect } from "react";
import { toast } from "@/components/ui/dialog";

/** 从 fetch 的第一个参数取出 pathname（相对路径 / 绝对 URL / Request 都兼容）。 */
function requestPath(input: unknown): string | null {
  let raw: string;
  if (typeof input === "string") raw = input;
  else if (input instanceof URL) raw = input.href;
  else if (typeof Request !== "undefined" && input instanceof Request) raw = input.url;
  else return null;
  try {
    return new URL(raw, window.location.href).pathname;
  } catch {
    return null;
  }
}

/** 当前站内相对路径（含 hash）；校验口径与 app/login/page.tsx 的 ?next= 一致。 */
function currentNext(): string {
  const { pathname, search, hash } = window.location;
  const path = pathname + search + hash;
  // 只接受站内相对路径，避免 ?next= 被用作开放重定向
  return path.startsWith("/") && !path.startsWith("//") ? path : "/";
}

/**
 * M12：全局 API 响应反馈。包装 window.fetch，只观察状态码，不读取/消费 response body，
 * 各页仍可正常 res.json()。挂载时安装、卸载时恢复原 fetch。
 */
export function ApiFeedbackGuard() {
  useEffect(() => {
    const original = window.fetch;
    // 401 只跳一次；403 只弹一条常驻提示，避免并发请求刷屏
    let redirecting = false;
    let forbiddenShown = false;

    const wrapped = async (...args: Parameters<typeof fetch>): Promise<Response> => {
      const res = await original(...args);
      const path = requestPath(args[0]);
      // 只处理 /api/*；登录接口本身与非 API 请求放行。
      // 全程不碰 response body：EventSource/SSE 不走 fetch，fetch 流式响应也因未读 body 不受影响。
      if (!path || !path.startsWith("/api/") || path.startsWith("/api/web-auth")) return res;
      if (res.status === 401) {
        // 已在登录页就不再跳，避免 401 与 /login 互相触发形成循环
        if (!redirecting && window.location.pathname !== "/login") {
          redirecting = true;
          window.location.assign(`/login?next=${encodeURIComponent(currentNext())}`);
        }
      } else if (res.status === 403) {
        if (!forbiddenShown) {
          forbiddenShown = true;
          // 复用 dialog.tsx 的 toast.error：错误默认常驻、带 aria-live / role=alert。
          // 文案给可执行的中文指引；不臆造设置页 / 目录选择器的具体接口，
          // 用「重新加载」作为换目录或检查允许根目录后的通用收尾动作。
          toast.error("没有访问该目录的权限 · 请更换目录或检查允许根目录", {
            label: "重新加载",
            onClick: () => window.location.reload(),
          });
        }
      }
      // 5xx 不额外制造 toast 噪音：各页已有处理，这里只放行原响应。
      return res;
    };

    window.fetch = wrapped;
    return () => {
      window.fetch = original;
    };
  }, []);

  return null;
}
