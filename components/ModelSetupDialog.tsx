"use client";

import { AlertTriangle, Check, ChevronLeft, ExternalLink, KeyRound, Loader2, Search, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/components/lib/utils";
import { toast } from "@/components/ui/dialog";

/**
 * 「接入模型」向导 —— 对应 pi CLI 的 `/login`，一个流程走完：
 *   1 选厂商 → 2 认证（API Key / OAuth 订阅）→ 3 选默认模型
 *
 * 为什么值得单独做：OAuth 授权本来就发生在浏览器里，此前 OAuth-only 厂商
 * （Claude Pro/Max、ChatGPT 等订阅制）却只在界面上给一句「请使用 pi CLI 的
 * /login」—— 等于把入口藏回终端。后端的 OAuth 流程（auth/providers ·
 * auth/login SSE · auth/logout）其实早就实现了，缺的只是入口。
 *
 * 无凭据时首页会主动唤起本向导，省掉「不知道该去哪配 Key」这一步。
 */

type ProviderAuthStatus = {
  id: string;
  label: string;
  modelCount: number;
  env?: string;
  oauthOnly?: boolean;
  note?: string;
  auth: { type: string; masked?: string } | null;
  envSet: boolean;
};

type ModelEntry = { id: string; name: string; provider: string };

type Step = "provider" | "auth" | "model";

type OauthOption = { id: string; label?: string; name?: string };

type OauthState = {
  running: boolean;
  url?: string;
  instructions?: string | null;
  userCode?: string;
  verificationUri?: string;
  progress?: string;
  pending?: {
    token: string;
    kind: "code" | "select" | "text";
    message?: string;
    options?: OauthOption[];
    placeholder?: string | null;
  };
  done?: boolean;
  error?: string;
};

const EMPTY_OAUTH: OauthState = { running: false };

export function ModelSetupDialog({
  open,
  onClose,
  onDone,
  initialProviderId,
  reason,
}: {
  open: boolean;
  onClose: () => void;
  /** 完成（或用户跳过第 3 步）后回调，供外层刷新模型列表 */
  onDone?: () => void;
  initialProviderId?: string;
  /** 顶部说明文案（首页引导与模型页复用时措辞不同） */
  reason?: string;
}) {
  const [step, setStep] = useState<Step>("provider");
  const [providers, setProviders] = useState<ProviderAuthStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ProviderAuthStatus | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [oauth, setOauth] = useState<OauthState>(EMPTY_OAUTH);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelDraft, setModelDraft] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  /** SSE 回调里需要最新选中的厂商，用 ref 避免把回调绑到过期的闭包 */
  const selectedRef = useRef<ProviderAuthStatus | null>(null);
  selectedRef.current = selected;

  const closeEs = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
  }, []);

  const loadProviders = useCallback(async () => {
    try {
      const d = (await fetch("/api/auth", { cache: "no-store" }).then((r) => r.json())) as {
        providers?: ProviderAuthStatus[];
      };
      const list = d.providers ?? [];
      setProviders(list);
      return list;
    } catch {
      setProviders([]);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  /* 打开时重置到第一步并拉取厂商目录 */
  useEffect(() => {
    if (!open) {
      closeEs();
      setOauth(EMPTY_OAUTH);
      return;
    }
    setStep("provider");
    setQuery("");
    setKeyDraft("");
    setModels([]);
    setModelDraft(null);
    setLoading(true);
    void loadProviders().then((list) => {
      if (!initialProviderId) return;
      const p = list.find((x) => x.id === initialProviderId);
      if (p) {
        setSelected(p);
        setStep("auth");
      }
    });
  }, [open, initialProviderId, loadProviders, closeEs]);

  /* 卸载时关闭 SSE，避免 EventSource 自动重连重新发起登录 */
  useEffect(() => () => closeEs(), [closeEs]);

  const sorted = useMemo(() => {
    const rank = (p: ProviderAuthStatus) => (p.auth ? 0 : p.envSet ? 1 : 2);
    return [...providers].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
  }, [providers]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((p) => `${p.id} ${p.label}`.toLowerCase().includes(q));
  }, [sorted, query]);
  const configuredCount = providers.filter((p) => p.auth || p.envSet).length;

  /* ---------------- 认证：API Key ---------------- */
  const saveKey = async () => {
    if (!selected || !keyDraft.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/auth", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: selected.id, key: keyDraft.trim() }),
      });
      const d = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(d.error || `保存失败（HTTP ${res.status}）`);
      toast(`${selected.label} 密钥已保存`);
      setKeyDraft("");
      void afterAuth();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  /* ---------------- 认证完成 → 拉该厂商模型 ---------------- */
  const afterAuth = useCallback(async () => {
    const providerId = selectedRef.current?.id;
    if (!providerId) return;
    setStep("model");
    setModelsLoading(true);
    setModelDraft(null);
    try {
      const d = (await fetch("/api/models", { cache: "no-store" }).then((r) => r.json())) as {
        modelList?: ModelEntry[];
        defaultModel?: { provider: string; modelId: string } | null;
      };
      setModels((d.modelList ?? []).filter((m) => m.provider === providerId));
    } catch {
      setModels([]);
    } finally {
      setModelsLoading(false);
    }
  }, []);

  /* ---------------- 认证：OAuth 订阅 ---------------- */
  const startOauth = useCallback(
    (providerId: string) => {
      closeEs();
      setOauth({ running: true });
      const es = new EventSource(`/api/auth/login/${encodeURIComponent(providerId)}`);
      esRef.current = es;
      es.onmessage = (ev) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(ev.data) as Record<string, unknown>;
        } catch {
          return;
        }
        const type = String(msg.type ?? "");
        if (type === "auth") {
          setOauth((s) => ({
            ...s,
            url: String(msg.url ?? ""),
            instructions: (msg.instructions as string | null) ?? null,
            pending: { token: String(msg.token ?? ""), kind: "code" },
          }));
        } else if (type === "device_code") {
          setOauth((s) => ({
            ...s,
            userCode: String(msg.userCode ?? ""),
            verificationUri: String(msg.verificationUri ?? ""),
            progress: "等待浏览器授权…",
          }));
        } else if (type === "select_request") {
          setOauth((s) => ({
            ...s,
            pending: {
              token: String(msg.token ?? ""),
              kind: "select",
              message: msg.message as string | undefined,
              options: (msg.options as OauthOption[] | undefined) ?? [],
            },
          }));
        } else if (type === "prompt_request") {
          setOauth((s) => ({
            ...s,
            pending: {
              token: String(msg.token ?? ""),
              kind: "text",
              message: msg.message as string | undefined,
              placeholder: (msg.placeholder as string | null) ?? null,
            },
          }));
        } else if (type === "progress") {
          setOauth((s) => ({ ...s, progress: String(msg.message ?? "") }));
        } else if (type === "success") {
          closeEs();
          setOauth((s) => ({ ...s, running: false, done: true, pending: undefined }));
          toast(`${selectedRef.current?.label ?? "订阅"} 登录成功`);
          void afterAuth();
        } else if (type === "error") {
          closeEs();
          setOauth((s) => ({ ...s, running: false, error: String(msg.message ?? "登录失败") }));
        } else if (type === "cancelled") {
          closeEs();
          setOauth({ running: false, error: "登录已取消" });
        }
      };
      es.onerror = () => {
        // 服务端正常收流也会触发 error；仅在流已不可用时提示
        if (es.readyState === EventSource.CLOSED) {
          setOauth((s) => (s.done ? s : { ...s, running: false, error: s.error ?? "连接中断，请重试" }));
          esRef.current = null;
        }
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [closeEs, afterAuth],
  );

  const submitOauthInput = async (value: string) => {
    const providerId = selectedRef.current?.id;
    if (!providerId || !oauth.pending) return;
    const { token } = oauth.pending;
    setOauth((s) => ({ ...s, pending: undefined, progress: "处理中…" }));
    try {
      const res = await fetch(`/api/auth/login/${encodeURIComponent(providerId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, code: value }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error || `提交失败（HTTP ${res.status}）`);
      }
    } catch (e) {
      setOauth((s) => ({ ...s, error: e instanceof Error ? e.message : String(e), running: false }));
    }
  };

  /* ---------------- 步骤 3：写入默认模型并收尾 ---------------- */
  const finish = async () => {
    setFinishing(true);
    try {
      if (modelDraft) {
        const [provider, ...rest] = modelDraft.split("/");
        const modelId = rest.join("/");
        const res = await fetch("/api/pi-settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ settings: { defaultProvider: provider, defaultModel: modelId } }),
        });
        if (!res.ok) {
          const d = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(d.error || `保存默认模型失败（HTTP ${res.status}）`);
        }
        toast("默认模型已设置");
      }
      onDone?.();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setFinishing(false);
    }
  };

  if (!open) return null;

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-[120] flex items-center justify-center bg-overlay p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          closeEs();
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="接入模型"
        data-testid="model-setup"
        className="flex max-h-[85vh] w-[600px] max-w-full flex-col overflow-hidden rounded-card border border-line bg-panel shadow-lg"
      >
        {/* 头部 */}
        <div className="flex items-center gap-2.5 border-b border-line-soft px-5 py-3.5">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-card bg-accent-soft text-accent">
            <KeyRound size={16} />
          </div>
          <div className="min-w-0">
            <div className="text-[14px] font-bold text-fg">接入模型</div>
            <div className="truncate text-[11px] text-dim">
              {reason ?? "选择厂商 → 填入凭据 → 挑选默认模型"}
            </div>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] text-dim">
            {(["provider", "auth", "model"] as Step[]).map((s, i) => (
              <span
                key={s}
                className={cn(
                  "flex items-center gap-1",
                  step === s && "font-semibold text-accent",
                )}
              >
                <span
                  className={cn(
                    "flex size-4 items-center justify-center rounded-full text-[10px]",
                    step === s ? "bg-accent text-accent-fg" : "bg-panel-2 text-dim",
                  )}
                >
                  {i + 1}
                </span>
                {s === "provider" ? "厂商" : s === "auth" ? "凭据" : "模型"}
                {i < 2 && <span className="text-dim/40">→</span>}
              </span>
            ))}
          </div>
        </div>

        {/* 步骤 1：选厂商 */}
        {step === "provider" && (
          <>
            <div className="px-5 pt-3.5">
              <div className="flex h-8 items-center gap-2 rounded-md border border-line bg-panel-2 px-2.5 text-dim">
                <Search size={12} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索厂商，如 deepseek、kimi、claude、openai…"
                  autoFocus
                  className="w-full bg-transparent text-[12px] text-fg outline-none placeholder:text-dim"
                />
              </div>
              <div className="mt-1.5 text-[11px] text-dim">
                内置 {providers.length} 个厂商 · 已配置 {configuredCount} 个
              </div>
            </div>
            <div className="mt-2 min-h-0 flex-1 overflow-y-auto px-5 pb-4">
              {loading && (
                <div className="flex items-center gap-2 py-6 text-[12px] text-dim">
                  <Loader2 size={14} className="anim-spin" /> 加载厂商目录…
                </div>
              )}
              {filtered.map((p) => (
                <button
                  key={p.id}
                  data-provider={p.id}
                  onClick={() => {
                    setSelected(p);
                    setKeyDraft("");
                    setOauth(EMPTY_OAUTH);
                    setStep("auth");
                  }}
                  className="flex w-full cursor-pointer items-center gap-2 border-t border-line-soft py-2.5 text-left t-fast first:border-t-0 hover:bg-hover"
                >
                  <span className="shrink-0 text-[12px] font-medium text-fg">{p.label}</span>
                  <span className="truncate font-mono text-[11px] text-dim">{p.id}</span>
                  <span className="chip shrink-0">{p.modelCount} 模型</span>
                  {p.oauthOnly && <span className="chip chip-accent shrink-0">订阅制</span>}
                  <span className="ml-auto shrink-0">
                    {p.auth ? (
                      <span className="chip chip-success">{p.auth.masked ? `已配置 ${p.auth.masked}` : "已配置"}</span>
                    ) : p.envSet ? (
                      <span className="chip chip-accent">环境变量</span>
                    ) : (
                      <span className="chip">未配置</span>
                    )}
                  </span>
                </button>
              ))}
              {!loading && filtered.length === 0 && (
                <div className="py-8 text-center text-[12px] text-dim">没有匹配的厂商</div>
              )}
            </div>
          </>
        )}

        {/* 步骤 2：认证 */}
        {step === "auth" && selected && (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    closeEs();
                    setOauth(EMPTY_OAUTH);
                    setStep("provider");
                  }}
                  className="btn btn-sm btn-subtle"
                >
                  <ChevronLeft size={12} /> 换厂商
                </button>
                <span className="text-[13px] font-semibold text-fg">{selected.label}</span>
                <span className="truncate font-mono text-[11px] text-dim">{selected.id}</span>
              </div>

              {/* OAuth 订阅登录 */}
              {selected.oauthOnly ? (
                <div className="mt-4">
                  <div className="flex items-start gap-2 rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-[12px] leading-relaxed text-muted">
                    <ShieldCheck size={14} className="mt-0.5 shrink-0 text-accent" />
                    <span>
                      该厂商使用<strong className="text-fg">订阅账号授权登录</strong>：点击下方按钮后会打开官方授权页，
                      授权完成后把浏览器地址栏的完整回调地址（或页面显示的验证码）贴回来即可。凭据写入本机{" "}
                      <code className="font-mono text-[11px]">~/.pi/agent/auth.json</code>，不会经过第三方。
                    </span>
                  </div>

                  {!oauth.running && !oauth.done && !oauth.error && (
                    <button
                      onClick={() => startOauth(selected.id)}
                      data-testid="oauth-start"
                      className="btn btn-primary mt-3"
                    >
                      <ExternalLink size={12} /> 使用订阅账号登录
                    </button>
                  )}

                  {oauth.done && (
                    <div className="mt-3 flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-[12px] text-success">
                      <Check size={12} /> 登录成功
                    </div>
                  )}
                  {oauth.error && (
                    <div className="mt-3 flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
                      <AlertTriangle size={12} /> {oauth.error}
                    </div>
                  )}

                  {oauth.running && (
                    <div className="mt-3 space-y-2.5">
                      {oauth.progress && (
                        <div className="flex items-center gap-2 text-[12px] text-muted">
                          <Loader2 size={12} className="anim-spin text-accent" /> {oauth.progress}
                        </div>
                      )}
                      {oauth.url && (
                        <div className="rounded-lg border border-line bg-panel-2 px-3 py-2.5">
                          <div className="text-[12px] font-medium text-fg">1. 打开授权页完成登录</div>
                          <a
                            href={oauth.url}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-1.5 flex items-center gap-1.5 break-all text-[11px] text-accent hover:underline"
                          >
                            <ExternalLink size={10} className="shrink-0" />
                            {oauth.url}
                          </a>
                          {oauth.instructions && (
                            <div className="mt-1.5 text-[11px] leading-relaxed text-dim">{oauth.instructions}</div>
                          )}
                        </div>
                      )}
                      {oauth.userCode && (
                        <div className="rounded-lg border border-line bg-panel-2 px-3 py-2.5">
                          <div className="text-[12px] font-medium text-fg">
                            在 {oauth.verificationUri} 输入验证码
                          </div>
                          <div className="mt-1 font-mono text-[20px] font-bold tracking-widest text-accent">
                            {oauth.userCode}
                          </div>
                        </div>
                      )}
                      {oauth.pending?.kind === "code" && (
                        <OauthInput
                          label="2. 把浏览器地址栏的完整地址（或页面给出的验证码）粘贴到这里"
                          placeholder="http://localhost:1455/auth/callback?code=… 或直接粘贴验证码"
                          submitText="完成登录"
                          onSubmit={(v) => void submitOauthInput(v)}
                        />
                      )}
                      {oauth.pending?.kind === "text" && (
                        <OauthInput
                          label={oauth.pending.message ?? "请输入"}
                          placeholder={oauth.pending.placeholder ?? ""}
                          submitText="提交"
                          onSubmit={(v) => void submitOauthInput(v)}
                        />
                      )}
                      {oauth.pending?.kind === "select" && (
                        <div className="rounded-lg border border-line bg-panel-2 px-3 py-2.5">
                          <div className="text-[12px] font-medium text-fg">
                            {oauth.pending.message ?? "请选择"}
                          </div>
                          <div className="mt-2 flex flex-col gap-1.5">
                            {(oauth.pending.options ?? []).map((o) => (
                              <button
                                key={o.id}
                                onClick={() => void submitOauthInput(o.id)}
                                className="btn btn-ghost justify-start"
                              >
                                {o.label ?? o.name ?? o.id}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                /* API Key 登录 */
                <div className="mt-4">
                  <div className="rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-[12px] leading-relaxed text-muted">
                    在 {selected.label} 控制台创建 API Key 后粘贴到这里。
                    {selected.env && (
                      <>
                        {" "}
                        也可改用环境变量 <code className="font-mono text-[11px]">{selected.env}</code>。
                      </>
                    )}
                    {selected.note && <div className="mt-1 text-[11px] text-dim">{selected.note}</div>}
                  </div>
                  <div className="mt-3 flex gap-2">
                    <input
                      type="password"
                      value={keyDraft}
                      onChange={(e) => setKeyDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void saveKey();
                      }}
                      placeholder="粘贴 API Key"
                      autoFocus
                      data-testid="api-key-input"
                      className="h-9 flex-1 rounded-md border border-line bg-panel px-2.5 font-mono text-[12px] text-fg outline-none focus:border-accent/60"
                    />
                    <button
                      onClick={() => void saveKey()}
                      disabled={saving || !keyDraft.trim()}
                      data-testid="api-key-save"
                      className="btn btn-primary h-9 px-3.5"
                    >
                      {saving ? <Loader2 size={12} className="anim-spin" /> : null} 保存并继续
                    </button>
                  </div>
                  {selected.auth && (
                    <div className="mt-2 text-[11px] text-dim">
                      该厂商已配置（{selected.auth.masked ?? selected.auth.type}），重新保存会覆盖原有凭据。
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}

        {/* 步骤 3：选默认模型 */}
        {step === "model" && selected && (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <div className="text-[13px] font-semibold text-fg">选择默认模型</div>
              <div className="mt-1 text-[11px] leading-relaxed text-dim">
                新会话默认使用它。之后随时可在「模型」页或输入框右侧切换。
              </div>
              {modelsLoading && (
                <div className="flex items-center gap-2 py-6 text-[12px] text-dim">
                  <Loader2 size={14} className="anim-spin" /> 读取模型列表…
                </div>
              )}
              {!modelsLoading && models.length === 0 && (
                <div className="mt-4 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2.5 text-[12px] text-warn">
                  没有读到 {selected.label} 的模型。凭据可能尚未生效，可先完成向导，再回「模型」页点「刷新模型库」。
                </div>
              )}
              {!modelsLoading && models.length > 0 && (
                <div className="mt-3 max-h-72 overflow-y-auto rounded-lg border border-line">
                  {models.map((m) => {
                    const ref = `${m.provider}/${m.id}`;
                    const active = modelDraft === ref;
                    return (
                      <button
                        key={ref}
                        onClick={() => setModelDraft(active ? null : ref)}
                        className={cn(
                          "flex w-full cursor-pointer items-center gap-2 border-b border-line-soft px-3 py-2 text-left t-fast last:border-b-0 hover:bg-hover",
                          active && "bg-active",
                        )}
                      >
                        <span
                          className={cn(
                            "flex size-4 shrink-0 items-center justify-center rounded-full border",
                            active ? "border-accent bg-accent text-accent-fg" : "border-line",
                          )}
                        >
                          {active && <Check size={10} />}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[12px] text-fg">{m.name || m.id}</span>
                        <span className="shrink-0 truncate font-mono text-[10px] text-dim">{m.id}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 border-t border-line-soft bg-panel-2/60 px-5 py-3">
              <button onClick={() => onClose()} className="btn btn-subtle">
                稍后再说
              </button>
              <button
                onClick={() => void finish()}
                disabled={finishing || !modelDraft}
                data-testid="setup-finish"
                className="btn btn-primary ml-auto"
              >
                {finishing ? <Loader2 size={12} className="anim-spin" /> : <Check size={12} />} 完成
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** OAuth 流程中的一次性输入（回调地址 / 自由文本） */
function OauthInput({
  label,
  placeholder,
  submitText,
  onSubmit,
}: {
  label: string;
  placeholder?: string;
  submitText: string;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <div className="rounded-lg border border-line bg-panel-2 px-3 py-2.5">
      <div className="text-[12px] font-medium text-fg">{label}</div>
      <div className="mt-2 flex gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && value.trim()) onSubmit(value.trim());
          }}
          placeholder={placeholder}
          autoFocus
          data-testid="oauth-input"
          className="h-9 min-w-0 flex-1 rounded-md border border-line bg-panel px-2.5 font-mono text-[12px] text-fg outline-none focus:border-accent/60"
        />
        <button
          onClick={() => value.trim() && onSubmit(value.trim())}
          disabled={!value.trim()}
          className="btn btn-primary h-9 shrink-0 px-3.5"
        >
          {submitText}
        </button>
      </div>
    </div>
  );
}
