"use client";

import { KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { LogoMark } from "@/components/Logo";

/**
 * 局域网访问的登录页。
 *
 * 为什么必须存在：`proxy.ts` 在设置 `PI_WEB_PASSWORD` 后会把未认证的页面请求
 * 重定向到 `/login`，而此前**这个路由并不存在** —— 一旦开启密码保护，
 * 访问者只会看到 404，局域网模式实际上不可用（README 却把它列为可用能力）。
 *
 * 认证走 /api/web-auth POST：校验密码后写入 httpOnly 会话 cookie（30 天）。
 */
export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [next, setNext] = useState("/");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    // 只接受站内相对路径，避免 ?next= 被用作开放重定向
    const raw = new URLSearchParams(window.location.search).get("next");
    if (raw && raw.startsWith("/") && !raw.startsWith("//")) setNext(raw);
    inputRef.current?.focus();
    // 若服务端并未开启密码（例如直接访问 /login），给出明确说明而不是让人反复试错
    fetch("/api/web-auth", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { enabled?: boolean; authenticated?: boolean } | null) => {
        if (d && d.enabled === false) setDisabled(true);
        else if (d?.authenticated) window.location.replace(next);
      })
      .catch(() => {});
  }, [next]);

  const submit = async () => {
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/web-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error === "Invalid password" ? "密码不正确" : d.error || `登录失败（HTTP ${res.status}）`);
      }
      window.location.replace(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPassword("");
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-dvh w-full items-center justify-center bg-bg px-6 text-fg">
      <div className="w-full max-w-[380px]">
        <div className="mb-5 flex flex-col items-center">
          <LogoMark size={40} />
          <div className="mt-3 text-[16px] font-bold tracking-[0.12em]">ELENVA</div>
          <div className="mt-1 text-[11px] tracking-[0.22em] text-dim">在确定性中寻找出口</div>
        </div>

        <div className="rounded-card border border-line bg-panel p-5">
          <div className="flex items-center gap-2">
            <ShieldCheck size={14} className="shrink-0 text-accent" />
            <span className="text-[13px] font-semibold">需要密码</span>
          </div>
          <p className="mt-1.5 text-[12px] leading-relaxed text-dim">
            {disabled
              ? "服务端未设置 PI_WEB_PASSWORD，无需登录。"
              : "该实例开启了局域网访问保护，请输入启动时设置的访问密码。"}
          </p>

          {!disabled && (
            <>
              <div className="mt-3 flex gap-2">
                <input
                  ref={inputRef}
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submit();
                  }}
                  placeholder="访问密码"
                  autoComplete="current-password"
                  data-testid="web-password"
                  className="h-9 min-w-0 flex-1 rounded-md border border-line bg-panel-2 px-2.5 text-[13px] text-fg outline-none focus:border-accent/60"
                />
                <button
                  onClick={() => void submit()}
                  disabled={busy || !password}
                  data-testid="web-login"
                  className="btn btn-primary h-9 shrink-0 px-3.5"
                >
                  {busy ? <Loader2 size={12} className="anim-spin" /> : <KeyRound size={12} />} 进入
                </button>
              </div>
              {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
              <div className="mt-3 border-t border-line-soft pt-2.5 text-[11px] leading-relaxed text-dim">
                登录状态保存在本机 cookie，有效期 30 天。密码由服务启动时的
                <code className="mx-1 font-mono">PI_WEB_PASSWORD</code>环境变量决定。
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
