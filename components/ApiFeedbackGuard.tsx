"use client";

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

const GUARD_FLAG = "__elenvaApiFeedbackGuardInstalled__";
type GuardWindow = Window & { [GUARD_FLAG]?: boolean };

/**
 * M12：全局 API 响应反馈。
 *
 * 安装必须是**模块加载**而不是 useEffect：AppShell 在挂载 effect 里就会发
 * /api/sessions，若 guard 作为后面的兄弟组件才包装 fetch，首屏 401/403 会全部漏掉
 * （2026-11-15 无头 Edge 实测确认）。只观察状态码、不读 body，SSE 不受影响。
 * 全局标记防 HMR / StrictMode 重复包装。
 */
function installApiFeedbackGuard() {
  if (typeof window === "undefined") return;
  const w = window as GuardWindow;
  if (w[GUARD_FLAG]) return;
  w[GUARD_FLAG] = true;

  const original = window.fetch.bind(window);
  // 401 只跳一次；403 只弹一条常驻提示，避免并发请求刷屏
  let redirecting = false;
  let forbiddenShown = false;

  window.fetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const res = await original(...args);
    const path = requestPath(args[0]);
    // 只处理 /api/*；登录接口本身与非 API 请求放行。
    // 全程不碰 response body：EventSource/SSE 不走 fetch，fetch 流式响应也因未读 body 不受影响。
    if (!path || !path.startsWith("/api/") || path.startsWith("/api/web-auth")) return res;
    if (res.status >= 200 && res.status < 300) {
      // 会话恢复（或登录成功后的第一个正常请求）后允许下次 401 再次跳登录。
      try { sessionStorage.removeItem("elenva:401-redirected"); } catch { /* 隐私模式下忽略 */ }
    }
    if (res.status === 401) {
      // 已在登录页就不再跳；同一标签页只跳一次，避免「密码未开启时 /login 被重定向回首页」形成循环。
      if (!redirecting && window.location.pathname !== "/login") {
        let alreadyRedirected = false;
        try { alreadyRedirected = sessionStorage.getItem("elenva:401-redirected") === "1"; } catch { /* 忽略 */ }
        if (!alreadyRedirected) {
          redirecting = true;
          try { sessionStorage.setItem("elenva:401-redirected", "1"); } catch { /* 忽略 */ }
          window.location.assign(`/login?next=${encodeURIComponent(currentNext())}`);
        }
      }
    } else if (res.status === 403 && !forbiddenShown) {
      forbiddenShown = true;
      // 「更换目录」是真实动作：AppShell 监听该事件打开已有的目录选择器。
      toast.error("请求被拒绝（403）· 目录可能不在允许范围，请更换目录或检查允许根目录", {
        label: "更换目录",
        onClick: () => window.dispatchEvent(new CustomEvent("elenva:open-dir-picker")),
      });
    }
    // 5xx 不额外制造 toast 噪音：各页已有处理，这里只放行原响应。
    return res;
  };
}

installApiFeedbackGuard();

/** 保留组件形态供 layout 挂载；实际安装在模块加载时已完成。 */
export function ApiFeedbackGuard() {
  return null;
}
