"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Boxes,
  Loader2,
  Monitor,
  Moon,
  Palette,
  RefreshCw,
  Save,
  ScrollText,
  Settings as SettingsIcon,
  ShieldCheck,
  SunMedium,
  Wrench,
} from "lucide-react";
import { cn } from "@/components/lib/utils";
import { toast } from "@/components/ui/dialog";
import { PageHeader } from "@/components/ui/bits";
import { getToolNamesForPreset, TOOL_PRESET_VALUES, type ToolPreset } from "@/lib/tool-presets";
import type { ApprovalMode } from "@/lib/tool-risk";
import type { PiManagedSettings } from "@/lib/pi-user-settings";
import {
  applyThemePreference,
  readThemePreference,
  type ThemePreference,
  type ResolvedTheme,
} from "@/lib/theme";

/* ---------------- Pi 行为设置（settings.json 受管子集） ---------------- */
const TOOL_SELECT_OPTIONS: { value: ToolPreset | "pi-default"; label: string }[] = [
  { value: "pi-default", label: "跟随 Pi 默认" },
  { value: "full", label: "全部内置工具" },
  { value: "default", label: "默认（read/bash/edit/write）" },
  { value: "read-only", label: "只读" },
  { value: "none", label: "仅对话（禁用内置工具）" },
];

function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      onClick={() => onChange(!on)}
      disabled={disabled}
      className={cn(
        "relative h-5 w-9 shrink-0 cursor-pointer rounded-full t-fast disabled:opacity-50",
        on ? "bg-accent" : "bg-line",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 size-4 rounded-full bg-white shadow-sm transition-all",
          on ? "left-[18px]" : "left-0.5",
        )}
      />
    </button>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-fg">{label}</div>
        {hint && <p className="text-[12px] text-dim">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

const selectCls =
  "h-8 cursor-pointer rounded-lg border border-line bg-panel-2 px-2 text-[12px] text-fg outline-none focus:border-accent/60";
const inputCls =
  "h-8 w-24 rounded-lg border border-line bg-panel-2 px-2 text-[12px] tabular-nums text-fg outline-none focus:border-accent/60";

function PiSettingsSection() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [path, setPath] = useState<string>("");
  const [form, setForm] = useState<{ steeringMode: "all" | "one-at-a-time"; followUpMode: "all" | "one-at-a-time" }>({
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
  });
  const [compactionEnabled, setCompactionEnabled] = useState(true);
  const [reserveTokens, setReserveTokens] = useState(16384);
  const [keepRecentTokens, setKeepRecentTokens] = useState(20000);
  const [retryEnabled, setRetryEnabled] = useState(true);
  const [maxRetries, setMaxRetries] = useState(3);
  const [cacheWarming, setCacheWarming] = useState<"off" | "streaming" | "idle">("streaming");
  const [toolSelect, setToolSelect] = useState<ToolPreset | "pi-default">("pi-default");

  useEffect(() => {
    fetch("/api/pi-settings", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { path?: string; settings?: PiManagedSettings }) => {
        if (!d.settings) return;
        setPath(d.path ?? "");
        setForm({
          steeringMode: d.settings.steeringMode ?? "one-at-a-time",
          followUpMode: d.settings.followUpMode ?? "one-at-a-time",
        });
        setCompactionEnabled(d.settings.compaction?.enabled ?? true);
        setReserveTokens(d.settings.compaction?.reserveTokens ?? 16384);
        setKeepRecentTokens(d.settings.compaction?.keepRecentTokens ?? 20000);
        setRetryEnabled(d.settings.retry?.enabled ?? true);
        setMaxRetries(d.settings.retry?.maxRetries ?? 3);
        setCacheWarming(d.settings.cacheWarming ?? "streaming");
        if (d.settings.defaultTools) {
          const names = [...d.settings.defaultTools].sort().join(",");
          const match = TOOL_PRESET_VALUES.find((p) => getToolNamesForPreset(p).sort().join(",") === names);
          setToolSelect(match ?? "pi-default");
        }
      })
      .catch(() => toast("读取 Pi 设置失败"))
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const body: PiManagedSettings = {
        steeringMode: form.steeringMode,
        followUpMode: form.followUpMode,
        compaction: {
          enabled: compactionEnabled,
          reserveTokens,
          keepRecentTokens,
        },
        retry: { enabled: retryEnabled, maxRetries },
        cacheWarming,
        ...(toolSelect === "pi-default" ? {} : { defaultTools: getToolNamesForPreset(toolSelect) }),
      };
      const res = await fetch("/api/pi-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = (await res.json()) as { error?: string };
      if (!res.ok) {
        toast(`保存失败：${d.error ?? res.status}`);
        return;
      }
      toast("已保存到 ~/.pi/agent/settings.json，新会话生效");
    } catch {
      toast("保存失败（网络原因）");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-card border border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line-soft px-4 py-3">
        <Boxes size={14} className="text-accent" />
        <span className="text-[13px] font-semibold text-fg">Pi 行为</span>
        <span className="truncate text-[11px] text-dim">{path || "~/.pi/agent/settings.json"}</span>
        <button
          onClick={() => void save()}
          disabled={loading || saving}
          data-testid="pi-settings-save"
          className="btn btn-primary ml-auto shrink-0"
        >
          {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} 保存
        </button>
      </div>
      {loading ? (
        <div className="flex justify-center py-5">
          <Loader2 size={14} className="animate-spin text-dim" />
        </div>
      ) : (
        <div className="divide-y divide-line-soft">
          <Field label="插话送达模式（steeringMode）" hint="all：当前回合工具结束后一次送达全部；one-at-a-time：每回合一条">
            <select
              value={form.steeringMode}
              onChange={(e) => setForm((f) => ({ ...f, steeringMode: e.target.value as "all" | "one-at-a-time" }))}
              className={selectCls}
            >
              <option value="one-at-a-time">逐条</option>
              <option value="all">全部</option>
            </select>
          </Field>
          <Field label="跟发送达模式（followUpMode）" hint="all：任务结束后一次送达全部；one-at-a-time：每次结束送达一条">
            <select
              value={form.followUpMode}
              onChange={(e) => setForm((f) => ({ ...f, followUpMode: e.target.value as "all" | "one-at-a-time" }))}
              className={selectCls}
            >
              <option value="one-at-a-time">逐条</option>
              <option value="all">全部</option>
            </select>
          </Field>
          <Field label="自动上下文压缩（compaction.enabled）" hint="接近上下文上限时自动压缩历史">
            <Toggle on={compactionEnabled} onChange={setCompactionEnabled} />
          </Field>
          <Field
            label="压缩保留 Token（keepRecentTokens）"
            hint="压缩时不总结的最近内容量。调小 = 压得更彻底、上下文丢得更多；调大 = 保留更多细节。"
          >
            <input
              type="number"
              min={0}
              max={1000000}
              value={keepRecentTokens}
              onChange={(e) => setKeepRecentTokens(Math.max(0, Math.min(1000000, Math.floor(Number(e.target.value) || 0))))}
              className={inputCls}
            />
          </Field>
          <Field
            label="响应预留 Token（reserveTokens）"
            hint={
              "自动压缩的触发点 = 上下文上限 − 该值（这是内核唯一的判定条件）。"
              + "所以：填得越大，压缩越早。默认 16384 在 1M 窗口上意味着 98% 才压缩；"
              + "想提到 80% 触发就填 200000。取值建议为窗口的 2%~10%。"
            }
          >
            <input
              type="number"
              min={0}
              max={1000000}
              value={reserveTokens}
              onChange={(e) => setReserveTokens(Math.max(0, Math.min(1000000, Math.floor(Number(e.target.value) || 0))))}
              className={inputCls}
            />
          </Field>
          <Field label="自动重试（retry.enabled）" hint="瞬时错误（限流/超时）自动重试">
            <Toggle on={retryEnabled} onChange={setRetryEnabled} />
          </Field>
          <Field label="最大重试次数（retry.maxRetries）" hint="指数退避：2s → 4s → 8s">
            <input
              type="number"
              min={0}
              max={10}
              value={maxRetries}
              onChange={(e) => setMaxRetries(Math.max(0, Math.min(10, Math.floor(Number(e.target.value) || 0))))}
              className={inputCls}
            />
          </Field>
          <Field
            label="提示词缓存保温（cacheWarming）"
            hint="长工具/空闲间隙用一次极小的请求续住提示词缓存，避免下次请求全价重算；off 关闭。需要模型声明缓存生命周期才完全生效。"
          >
            <select
              value={cacheWarming}
              onChange={(e) => setCacheWarming(e.target.value as "off" | "streaming" | "idle")}
              className={selectCls}
            >
              <option value="streaming">streaming（默认：长工具期间保温）</option>
              <option value="idle">idle（空闲时也保温）</option>
              <option value="off">off（关闭）</option>
            </select>
          </Field>
          <Field label="默认启用工具（defaultTools）" hint="新会话启动时启用的内置工具集">
            <select
              value={toolSelect}
              onChange={(e) => setToolSelect(e.target.value as ToolPreset | "pi-default")}
              className={selectCls}
            >
              {TOOL_SELECT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}
    </div>
  );
}

/* ---------------- 工具开关 ---------------- */
function ToolsSection() {
  const [psEnabled, setPsEnabled] = useState<boolean | null>(null);
  const [isWindows, setIsWindows] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/tools/settings", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { isWindows?: boolean; powerShellEnabled?: boolean }) => {
        setIsWindows(d.isWindows ?? true);
        setPsEnabled(d.powerShellEnabled ?? false);
      })
      .catch(() => setPsEnabled(false));
  }, []);

  const toggle = async () => {
    if (psEnabled === null) return;
    setSaving(true);
    try {
      const res = await fetch("/api/tools/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !psEnabled }),
      });
      if (res.ok) setPsEnabled(!psEnabled);
      else toast("保存失败（网络原因）");
    } catch {
      toast("保存失败（网络原因）");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-card border border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line-soft px-4 py-3">
        <Wrench size={14} className="text-accent" />
        <span className="text-[13px] font-semibold text-fg">工具</span>
        <span className="ml-auto text-[11px] text-dim">即时生效</span>
      </div>
      <div className="flex items-center gap-3 px-4 py-3.5">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-fg">PowerShell 工具</div>
          <p className="text-[12px] text-dim">允许 Agent 在 Windows 上执行 PowerShell 命令</p>
        </div>
        {psEnabled === null ? (
          <Loader2 size={14} className="animate-spin text-dim" />
        ) : !isWindows ? (
          <div className="flex shrink-0 items-center gap-2" title="当前系统不支持（仅 Windows 可用）">
            <span className="text-[11px] text-dim">仅 Windows 可用</span>
            <button
              disabled
              aria-disabled="true"
              className="relative h-5 w-9 shrink-0 cursor-not-allowed rounded-full bg-line opacity-50"
            >
              <span className="absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow-sm" />
            </button>
          </div>
        ) : (
          <button
            onClick={toggle}
            disabled={saving}
            className={cn(
              "relative h-5 w-9 shrink-0 cursor-pointer rounded-full t-fast",
              psEnabled ? "bg-accent" : "bg-line",
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 size-4 rounded-full bg-white shadow-sm transition-all",
                psEnabled ? "left-[18px]" : "left-0.5",
              )}
            />
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------------- 关于 ---------------- */
function AboutSection() {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const check = async () => {
    setChecking(true);
    setResult(null);
    try {
      const d = await fetch("/api/app-update", { cache: "no-store" }).then((r) => r.json());
      if (d.hasUpdate) {
        setResult(`发现新版本 ${d.latestVersion}（当前 ${d.currentVersion}）。本版本为自研 UI，暂不跟随原版升级。`);
      } else {
        setResult(`已是最新版本${d.currentVersion ? `（${d.currentVersion}）` : ""}`);
      }
    } catch {
      setResult("检查更新失败（网络原因）");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="rounded-card border border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line-soft px-4 py-3">
        <SettingsIcon size={14} className="text-accent" />
        <span className="text-[13px] font-semibold text-fg">关于</span>
      </div>
      <div className="px-4 py-4 text-[12px] text-muted">
        <div className="mb-1">
          ELENVA Web Workstation {process.env.NEXT_PUBLIC_APP_VERSION || "v0.1.0"} · 界面层独立实现，后端基于 pi-web
        </div>
        <div className="mb-3 text-[12px] text-dim">本地优先 · 会话数据保留在本机 ~/.pi/agent/sessions</div>
        <button
          onClick={check}
          disabled={checking}
          className="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-panel-2 px-3 text-[12px] text-muted t-fast hover:text-fg disabled:opacity-50"
        >
          {checking ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          检查更新
        </button>
        {result && <div className="mt-2 rounded-md bg-panel-2 px-3 py-1.5 text-[12px]">{result}</div>}
      </div>
    </div>
  );
}

/* ---------------- 外观 ---------------- */
const THEME_CHOICES: { id: ThemePreference; label: string; hint: string; icon: React.ReactNode }[] = [
  { id: "light", label: "浅色", hint: "红黑白 · 米白画布", icon: <SunMedium size={12} /> },
  { id: "dark", label: "深色", hint: "墨底 · 提亮红", icon: <Moon size={12} /> },
  { id: "auto", label: "跟随系统", hint: "随系统外观切换", icon: <Monitor size={12} /> },
];

function AppearanceSection() {
  const [pref, setPref] = useState<ThemePreference>("auto");
  const [resolved, setResolved] = useState<ResolvedTheme>("light");

  useEffect(() => {
    setPref(readThemePreference());
    setResolved(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  }, []);

  const choose = (next: ThemePreference) => {
    setPref(next);
    applyThemePreference(next);
    setResolved(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  };

  return (
    <div className="rounded-card border border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line-soft px-4 py-3">
        <Palette size={14} className="text-accent" />
        <span className="text-[13px] font-semibold text-fg">外观</span>
        <span className="ml-auto text-[11px] text-dim">
          {resolved === "dark" ? "深色生效中" : "浅色生效中"}
        </span>
      </div>
      <div className="px-4 py-4">
        <div className="grid grid-cols-3 gap-2" role="group" aria-label="主题外观">
          {THEME_CHOICES.map((c) => {
            const on = pref === c.id;
            return (
              <button
                key={c.id}
                onClick={() => choose(c.id)}
                aria-pressed={on}
                className={cn(
                  "t-fast flex cursor-pointer flex-col items-start gap-1.5 rounded-lg border px-3 py-2.5 text-left",
                  on
                    ? "border-accent bg-active text-accent"
                    : "border-line bg-panel-2 text-muted hover:border-accent/40 hover:text-fg",
                )}
              >
                <span className="flex items-center gap-1.5 text-[12px] font-semibold">
                  {c.icon}
                  {c.label}
                </span>
                {/* 11px 是功能性文字的下限（10px 留给纯角标）；选中态用不透明的 accent，
                    /80 会把对比度压到 AA 以下 */}
                <span className={cn("text-[11px]", on ? "text-accent" : "text-dim")}>{c.hint}</span>
              </button>
            );
          })}
        </div>
        <div className="mt-2.5 text-[11px] text-dim">
          {pref === "auto"
            ? "跟随系统外观自动切换，无需手动干预。"
            : `已固定为${pref === "dark" ? "深色" : "浅色"}，不随系统外观变化。`}
        </div>
      </div>
    </div>
  );
}

/**
 * 审批与计划模式。
 *
 * 默认档位是「只拦危险操作」，所以这个开关必须能关 —— 一个用户关不掉的
 * 拦截功能最后只会被人绕过去。免确认规则也列在这里，让人看得见自己答过哪些
 * 「总是允许」。
 */
function GuardrailsSection({ projects, defaultCwd }: {
  /** 可选项目（用于「本项目的验证命令」） */
  projects?: Array<{ name: string; path: string }>;
  defaultCwd?: string | null;
}) {
  const [mode, setMode] = useState<ApprovalMode | null>(null);
  const [allowByProject, setAllowByProject] = useState<Record<string, string[]>>({});
  const [planDefault, setPlanDefault] = useState(false);
  const [verificationGuard, setVerificationGuard] = useState(true);
  const [verifyCwd, setVerifyCwd] = useState<string>(defaultCwd ?? projects?.[0]?.path ?? "");
  const [declared, setDeclared] = useState<string[]>([]);
  const [verifyDraft, setVerifyDraft] = useState("");
  const [saving, setSaving] = useState(false);

  /*
   * 声明列表按当前选中项目单独拉：cwd 的写法在不同来源不一致
   * （界面是 `C:/x`，内核的 sessionManager 给的是 `C:\x`），规范化放服务端做，
   * 界面不猜 —— 直接用整张 map 查会出现「存进去了但查不到」。
   */
  const loadVerify = useCallback((cwd: string) => {
    if (!cwd) {
      setDeclared([]);
      return;
    }
    fetch(`/api/guardrails?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { verifyCommands?: string[] }) => setDeclared(d.verifyCommands ?? []))
      .catch(() => setDeclared([]));
  }, []);

  const load = () => {
    fetch("/api/guardrails", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: {
        approvalMode?: ApprovalMode;
        allowByProject?: Record<string, string[]>;
        planModeDefault?: boolean;
        verificationGuard?: boolean;
      }) => {
        setMode(d.approvalMode ?? "risky");
        setAllowByProject(d.allowByProject ?? {});
        setPlanDefault(d.planModeDefault === true);
        setVerificationGuard(d.verificationGuard !== false);
      })
      .catch(() => setMode("risky"));
  };
  useEffect(load, []);
  useEffect(() => {
    if (!verifyCwd && (defaultCwd || projects?.[0]?.path)) {
      setVerifyCwd(defaultCwd ?? projects?.[0]?.path ?? "");
    }
  }, [verifyCwd, defaultCwd, projects]);
  useEffect(() => {
    loadVerify(verifyCwd);
  }, [verifyCwd, loadVerify]);

  const post = async (body: Record<string, unknown>) => {
    setSaving(true);
    try {
      const res = await fetch("/api/guardrails", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json() as Record<string, unknown>;
    } catch (e) {
      toast("保存失败（网络原因）");
      throw e;
    } finally {
      setSaving(false);
    }
  };

  const CHOICES: { id: ApprovalMode; label: string; hint: string }[] = [
    { id: "off", label: "关闭", hint: "不拦截，行为同以前" },
    { id: "risky", label: "只拦危险操作", hint: "删除、强推、安装依赖、改凭据文件、越界写入" },
    { id: "writes", label: "每次写入都问", hint: "任何文件写入与命令执行都需确认" },
  ];

  const addVerify = async () => {
    const pattern = verifyDraft.trim();
    if (!pattern || !verifyCwd) return;
    await post({ action: "addVerifyCommand", cwd: verifyCwd, pattern });
    setVerifyDraft("");
    loadVerify(verifyCwd);
  };

  const removeVerify = async (pattern: string) => {
    if (!verifyCwd) return;
    await post({ action: "removeVerifyCommand", cwd: verifyCwd, pattern });
    loadVerify(verifyCwd);
  };

  const ruleEntries = Object.entries(allowByProject);

  return (
    <div className="rounded-card border border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line-soft px-4 py-3">
        <ShieldCheck size={14} className="text-accent" />
        <span className="text-[13px] font-semibold text-fg">安全确认</span>
        <span className="ml-auto text-[11px] text-dim">即时生效</span>
      </div>
      <div className="px-4 py-3.5">
        <div className="text-[13px] font-medium text-fg">危险操作审批</div>
        <p className="mt-0.5 text-[12px] text-dim">
          Agent 执行被判定为危险的操作前，在会话里弹确认卡；选择「总是允许」后不再打扰。
        </p>
        <div className="mt-2.5 flex flex-col gap-1.5 sm:flex-row">
          {mode === null ? (
            <Loader2 size={14} className="animate-spin text-dim" />
          ) : (
            CHOICES.map((choice) => {
              const on = mode === choice.id;
              return (
                <button
                  key={choice.id}
                  disabled={saving}
                  onClick={() => {
                    setMode(choice.id);
                    void post({ action: "setApprovalMode", mode: choice.id });
                  }}
                  aria-pressed={on}
                  className={cn(
                    "t-fast flex flex-1 cursor-pointer flex-col items-start gap-1 rounded-lg border px-3 py-2 text-left",
                    on
                      ? "border-accent bg-active text-accent"
                      : "border-line bg-panel-2 text-muted hover:border-accent/40 hover:text-fg",
                  )}
                >
                  <span className="text-[12px] font-semibold">{choice.label}</span>
                  <span className={cn("text-[10px] leading-relaxed", on ? "text-accent/80" : "text-dim")}>
                    {choice.hint}
                  </span>
                </button>
              );
            })
          )}
        </div>

        <div className="mt-4 flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-fg">新会话默认进入计划模式</div>
            <p className="text-[12px] text-dim">先只读勘察并提交计划，经你批准后才允许改动（单次会话里也可临时开关）</p>
          </div>
          <Toggle
            on={planDefault}
            disabled={saving}
            onChange={(next) => {
              setPlanDefault(next);
              void post({ action: "setPlanModeDefault", enabled: next });
            }}
          />
        </div>

        <div className="mt-4 flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-fg">收尾验证门禁</div>
            <p className="text-[12px] text-dim">
              改了代码却没有留下验证证据时，让 agent 在收尾前补一次检查；不替它跑命令，也不阻塞
            </p>
          </div>
          <Toggle
            on={verificationGuard}
            disabled={saving}
            onChange={(next) => {
              setVerificationGuard(next);
              void post({ action: "setVerificationGuard", enabled: next });
            }}
          />
        </div>

        <div className="mt-4 border-t border-line-soft pt-3">
          <div className="text-[13px] font-medium text-fg">本项目的验证命令</div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-dim">
            内建名单只认得住测试 / 类型检查 / 构建 / lint 这几类工具。项目自带的检查脚本
            （如 <span className="font-mono">python tools/style-converge.py</span>）请在这里声明：
            命令里<span className="text-fg">包含</span>这段文字就算验证，会以「项目检查」记进证据账本。
          </p>

          {(projects?.length ?? 0) > 0 && (
            <select
              value={verifyCwd}
              onChange={(e) => setVerifyCwd(e.target.value)}
              className="mt-2 h-7 max-w-full cursor-pointer rounded-md border border-line bg-panel-2 px-2 text-[12px] text-fg outline-none"
            >
              {!projects?.some((project) => project.path === verifyCwd) && verifyCwd && (
                <option value={verifyCwd}>{verifyCwd}</option>
              )}
              {projects?.map((project) => (
                <option key={project.path} value={project.path}>{project.name || project.path}</option>
              ))}
            </select>
          )}

          <div className="mt-2 flex items-center gap-1.5">
            <input
              value={verifyDraft}
              onChange={(e) => setVerifyDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) void addVerify();
              }}
              placeholder="命令里的一段文字，例如 style-converge"
              className="h-7 min-w-0 flex-1 rounded-md border border-line bg-panel-2 px-2 font-mono text-[11px] text-fg outline-none placeholder:text-dim focus:border-accent/60"
            />
            <button
              onClick={() => void addVerify()}
              disabled={saving || !verifyDraft.trim() || !verifyCwd}
              className="btn btn-sm shrink-0"
            >
              添加
            </button>
          </div>

          {declared.length > 0 && (
            <ul className="mt-1.5 flex flex-col gap-1">
              {declared.map((pattern) => (
                <li key={pattern} className="flex items-center gap-2 text-[11px]">
                  <span className="min-w-0 flex-1 truncate font-mono text-dim" title={pattern}>{pattern}</span>
                  <button
                    onClick={() => void removeVerify(pattern)}
                    className="shrink-0 cursor-pointer text-dim t-fast hover:text-danger"
                  >
                    移除
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {ruleEntries.length > 0 && (
          <div className="mt-4 border-t border-line-soft pt-3">
            <div className="text-[12px] text-muted">已记住的免确认规则</div>
            <ul className="mt-1.5 flex flex-col gap-1">
              {ruleEntries.map(([project, rules]) =>
                rules.map((rule) => (
                  <li key={`${project}-${rule}`} className="flex items-center gap-2 text-[11px]">
                    <span className="min-w-0 flex-1 truncate font-mono text-dim" title={`${project} · ${rule}`}>
                      {rule}
                    </span>
                    <button
                      onClick={() => {
                        void post({ action: "removeRule", cwd: project, ruleKey: rule }).then(load);
                      }}
                      className="shrink-0 cursor-pointer text-dim t-fast hover:text-danger"
                      title="移除这条规则"
                    >
                      移除
                    </button>
                  </li>
                )),
              )}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 宿主提示词只读视图。
 *
 * 这一层每轮都注入、每个会话都有，所以它得看得见：改了什么、为什么留、多长。
 * 不是编辑器——文本在 lib/host-prompt.ts，改代码就是改它（理由见 docs/host-prompt.md）。
 */
function HostPromptCard() {
  const [data, setData] = useState<{
    assembled: string;
    totalChars: number;
    sections: Array<{ id: string; rationale: string; relatedTo: string; text: string; chars: number }>;
    placement: Array<{ id: string; label: string; owner: string }>;
    fileSlots: Array<{ path: string; scope: string; trusted: boolean }>;
  } | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    fetch("/api/host-prompt", { cache: "no-store" })
      .then((r) => r.json())
      .then(setData)
      .catch(() => setData(null));
  }, []);

  return (
    <div className="rounded-card border border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line-soft px-4 py-3">
        <ScrollText size={14} className="text-accent" />
        <span className="text-[13px] font-semibold text-fg">宿主提示词</span>
        {data && (
          <span className="ml-auto text-[11px] tabular-nums text-dim">{data.totalChars} 字符 · {data.sections.length} 段</span>
        )}
      </div>
      <div className="px-4 py-3.5">
        <p className="text-[12px] leading-relaxed text-dim">
          每个会话都注入的一段系统提示，位于 pi 基座之后、项目 <span className="font-mono text-muted">AGENTS.md</span> 之前。
          分两层：<span className="text-muted">身份段</span>（它叫 ELENVA / Elen，能做什么、做不到时缺哪类能力、怎么成长），
          然后是「Web 工作台与 CLI 不同、且 agent 推断不出来」的事实（无终端交互、审批会被拦、改动有快照、收尾要有证据）。
        </p>

        {data && (
          <>
            <div className="mt-2.5 flex flex-col gap-1">
              {/* 列头（2026-09-21 增）：没有它时行尾的字符数看起来像个孤立数字 */}
              <div className="flex items-baseline gap-2 text-[10px] text-dim/80">
                <span className="shrink-0 font-mono">段</span>
                <span className="min-w-0 flex-1">说明</span>
                <span className="shrink-0">字符</span>
              </div>
              {data.sections.map((section) => (
                <div key={section.id} className="flex items-baseline gap-2 text-[11px]">
                  <span className="shrink-0 font-mono text-muted">{section.id}</span>
                  <span className="min-w-0 flex-1 truncate text-dim" title={section.rationale}>{section.rationale}</span>
                  <span className="shrink-0 tabular-nums text-dim">{section.chars}</span>
                </div>
              ))}
            </div>

            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <button onClick={() => setOpen((v) => !v)} className="btn btn-sm btn-ghost">
                {open ? "收起全文" : "查看全文与装配位置"}
              </button>
              {/* 这里给的是**静态层**；模型每轮实际看到的内容还包含记忆块、计划模式等
                  动态注入，那个只能在真实会话里看 —— 所以指路到「提示词」页。 */}
              <a href="#prompt" className="btn btn-sm btn-ghost" data-testid="open-prompt-page">
                看模型实际收到的完整提示词 →
              </a>
            </div>

            {open && (
              <div className="mt-2 flex flex-col gap-2.5">
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-panel-2 px-2.5 py-2 text-[11px] leading-relaxed text-muted">
                  {data.assembled}
                </pre>
                <div>
                  <div className="text-[11px] text-muted">系统提示的装配顺序</div>
                  <ol className="mt-1 flex flex-col gap-0.5">
                    {data.placement.map((slot) => (
                      <li key={slot.id} className="flex items-center gap-2 text-[11px]">
                        <span className={cn("min-w-0 flex-1 truncate", slot.id === "host" ? "text-accent" : "text-dim")}>
                          {slot.label}
                        </span>
                        <span className="shrink-0 text-[10px] text-dim/80">{slot.owner}</span>
                      </li>
                    ))}
                  </ol>
                </div>
                <div>
                  <div className="text-[11px] text-muted">不需要改代码的补充位置</div>
                  <ul className="mt-1 flex flex-col gap-0.5">
                    {data.fileSlots.map((slot) => (
                      <li key={slot.path} className="flex items-center gap-2 text-[11px]">
                        <span className="min-w-0 flex-1 truncate font-mono text-dim">{slot.path}</span>
                        <span className="shrink-0 text-[10px] text-dim/80">{slot.scope}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------- 设置页 ---------------- */
export function SettingsPage({
  projects,
  defaultCwd,
}: {
  projects?: Array<{ name: string; path: string }>;
  defaultCwd?: string | null;
} = {}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="page-col-form py-6">
        <PageHeader icon={<SettingsIcon size={16} />} title="设置" subtitle="工具开关、版本信息与其他偏好" />

        {/* 两列按高度均衡分组（而非按旧的「左=Agent 行为 / 右=应用层」硬切）：
            旧分法左列 1569px、右列 337px，底边差出一屏。现在按实测高度
            配平（约 976 : 970），两列底边基本齐平。 */}
        <div className="flex flex-col gap-5 xl:flex-row xl:items-start">
          <div className="flex min-w-0 flex-1 flex-col gap-5">
            <PiSettingsSection />
            <AppearanceSection />
            <AboutSection />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-5">
            <ToolsSection />
            <GuardrailsSection projects={projects} defaultCwd={defaultCwd} />
            <HostPromptCard />
          </div>
        </div>
      </div>
    </div>
  );
}
