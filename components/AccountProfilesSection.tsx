"use client";

import { AlertTriangle, ArrowLeftRight, KeyRound, Loader2, PencilLine, Save, Trash2, UserRound } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/components/lib/utils";
import { dialogConfirm, dialogPrompt, toast } from "@/components/ui/dialog";

/**
 * 设置页「账号」小节。
 *
 * 「先看清，后切换」：上面只读列出当前各订阅 / API Key 厂商的登录状态（不显示任何凭据内容）；
 * 下面才是命名凭据档的存档 / 切换 / 备注。切换前自动把当前凭据备份为 auto-<时间>，可回退。
 *
 * 安全：此组件只消费档元数据与指纹，从不接收凭据明文。
 */

type ProviderAuthStatus = {
  id: string;
  label: string;
  auth: { type: string; masked?: string } | null;
  envSet: boolean;
};

type AuthProfile = {
  id: string;
  label: string;
  provider: string;
  type: string;
  createdAt: string;
  updatedAt: string;
  note?: string;
  kind: "named" | "auto";
};

type ProfilesListing = {
  profiles: AuthProfile[];
  active: Record<string, string | null>;
  current: Record<string, { type: string; fingerprint: string }>;
  authPath: string;
  backupDir: string;
};

function typeLabel(type: string): string {
  if (type === "oauth") return "订阅";
  if (type === "api_key") return "API Key";
  return type;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function AccountProfilesSection() {
  const [profiles, setProfiles] = useState<ProfilesListing | null>(null);
  const [providers, setProviders] = useState<ProviderAuthStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const [saveProvider, setSaveProvider] = useState("");
  const [saveLabel, setSaveLabel] = useState("");

  const load = useCallback(async () => {
    try {
      const [profileRes, authRes] = await Promise.all([
        fetch("/api/auth/profiles", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/auth", { cache: "no-store" }).then((r) => r.json()),
      ]);
      setProfiles(profileRes as ProfilesListing);
      setProviders((authRes.providers ?? []) as ProviderAuthStatus[]);
    } catch {
      setProfiles({ profiles: [], active: {}, current: {}, authPath: "", backupDir: "" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const configured = useMemo(
    () => providers.filter((p) => p.auth).sort((a, b) => a.label.localeCompare(b.label)),
    [providers],
  );

  useEffect(() => {
    if (!saveProvider && configured.length > 0) setSaveProvider(configured[0].id);
  }, [configured, saveProvider]);

  const providerLabel = useCallback(
    (id: string) => providers.find((p) => p.id === id)?.label ?? id,
    [providers],
  );

  const saveCurrent = async () => {
    if (!saveProvider || !saveLabel.trim()) return;
    setBusy("save");
    try {
      const res = await fetch("/api/auth/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: saveProvider, label: saveLabel.trim() }),
      });
      const d = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(d.error || `存档失败（HTTP ${res.status}）`);
      toast("已把当前凭据存为档");
      setSaveLabel("");
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const switchTo = async (profile: AuthProfile) => {
    const ok = await dialogConfirm({
      title: "切换到该档",
      message: `将把「${providerLabel(profile.provider)}」的凭据替换为「${profile.label}」。切换前会自动备份当前凭据，可随时切回。运行中的会话会在下次请求时用新账号。`,
      confirmText: "切换",
    });
    if (!ok) return;
    setBusy(profile.id);
    try {
      const res = await fetch("/api/auth/profiles/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: profile.id }),
      });
      const d = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(d.error || `切换失败（HTTP ${res.status}）`);
      toast("已切换凭据档");
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const editNote = async (profile: AuthProfile) => {
    const note = await dialogPrompt({
      title: "档备注",
      message: `给「${profile.label}」写一句备注（可留空清除）`,
      defaultValue: profile.note ?? "",
      allowEmpty: true,
      placeholder: "例：公司号 / 个人号",
    });
    if (note === null) return;
    setBusy(profile.id);
    try {
      const res = await fetch("/api/auth/profiles", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: profile.id, note }),
      });
      const d = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(d.error || "保存备注失败");
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (profile: AuthProfile) => {
    const ok = await dialogConfirm({
      title: "删除凭据档",
      message: `确定删除「${profile.label}」？只删除保存的副本，不影响当前已生效的登录。`,
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    setBusy(profile.id);
    try {
      const res = await fetch(`/api/auth/profiles?id=${encodeURIComponent(profile.id)}`, { method: "DELETE" });
      const d = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(d.error || "删除失败");
      toast("已删除凭据档");
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const activeIdFor = (provider: string) => profiles?.active[provider] ?? null;
  const namedProfiles = profiles?.profiles.filter((p) => p.kind === "named") ?? [];
  const autoProfiles = profiles?.profiles.filter((p) => p.kind === "auto") ?? [];

  return (
    <Card testId="account-profiles">
      <CardHeader>
        <UserRound size={14} className="text-accent" />
        <CardTitle>账号</CardTitle>
        <span className="ml-auto text-[11px] text-dim">先看清，后切换 · 本机 auth.json 只存一条/厂商</span>
      </CardHeader>

      <div className="flex flex-col gap-3 p-4">
        {/* 实验性提示：真机尚未出现第二个真实订阅账号，切换链已在隔离夹具上全链验证 */}
        <div className="flex items-start gap-2 rounded-lg border border-line-soft bg-panel-2 px-2.5 py-2">
          <AlertTriangle size={12} className="mt-0.5 shrink-0 text-warn" />
          <p className="text-[11px] leading-relaxed text-muted">
            <strong className="text-fg">实验性</strong>：pi 每个厂商在 auth.json 只保存一条凭据，切换 = 替换该条
            目。切换前自动备份当前凭据为「自动备份」，失败会回滚；OAuth 刷新令牌轮换已做回收。多会话并发时切换全局生效。
          </p>
        </div>

        {/* 只读：当前登录（不显示凭据内容） */}
        <div>
          <div className="mb-1.5 flex items-center gap-2">
            <span className="text-[12px] font-medium text-fg">当前登录</span>
            <span className="text-[11px] text-dim">{profiles?.authPath ?? ""}</span>
          </div>
          {configured.length === 0 ? (
            <div className="rounded-lg bg-panel-2 px-2.5 py-2 text-[12px] text-dim">
              尚未配置任何厂商凭据。换号请先在「模型」页配置，或走 pi CLI 的 <span className="font-mono">/login</span>。
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {configured.map((p) => (
                <span key={p.id} className="chip">
                  <span className="text-fg">{p.label}</span>
                  <span className={cn("ml-1", p.auth?.type === "oauth" ? "text-accent" : "text-dim")}>
                    {typeLabel(p.auth?.type ?? "")}
                  </span>
                  {p.auth?.masked && <span className="ml-1 font-mono text-dim">{p.auth.masked}</span>}
                  {activeIdFor(p.id) && <span className="ml-1 text-success">· 已存为档</span>}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* 存档表单 */}
        <div className="rounded-lg border border-line-soft bg-panel-2 p-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-[12px] text-muted">
            <Save size={12} /> 把当前凭据存为档（等于备份，可随时切回）
          </div>
          <div className="flex flex-wrap gap-2">
            <select
              value={saveProvider}
              onChange={(e) => setSaveProvider(e.target.value)}
              className="h-8 rounded-md border border-line bg-panel px-2 text-[12px] text-fg outline-none focus:border-accent/50"
            >
              {configured.length === 0 && <option value="">（无可用厂商）</option>}
              {configured.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <input
              value={saveLabel}
              onChange={(e) => setSaveLabel(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void saveCurrent()}
              placeholder="档名，如「账号A」「公司号」"
              className="h-8 min-w-[10rem] flex-1 rounded-md border border-line bg-panel px-2.5 text-[12px] text-fg outline-none focus:border-accent/50"
            />
            <button
              onClick={() => void saveCurrent()}
              disabled={busy === "save" || !saveProvider || !saveLabel.trim()}
              className="btn btn-sm btn-primary"
            >
              {busy === "save" ? <Loader2 size={10} className="anim-spin" /> : <Save size={10} />} 存档
            </button>
          </div>
        </div>

        {/* 档列表 */}
        {loading ? (
          <div className="flex items-center gap-2 text-[12px] text-dim">
            <Loader2 size={12} className="anim-spin" /> 加载凭据档…
          </div>
        ) : profiles && profiles.profiles.length === 0 ? (
          <div className="rounded-lg bg-panel-2 px-2.5 py-2 text-[12px] text-dim">
            还没有凭据档。先「把当前凭据存为档」，再到另一个账号 <span className="font-mono">/login</span> 后存第二档，
            即可一键切换。
          </div>
        ) : (
          <div className="flex flex-col">
            {[...namedProfiles, ...autoProfiles].map((profile) => {
              const active = activeIdFor(profile.provider) === profile.id;
              const isAuto = profile.kind === "auto";
              return (
                <div
                  key={profile.id}
                  className="flex flex-wrap items-center gap-2 border-t border-line-soft py-2 first:border-t-0"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-[12px] font-medium text-fg">{profile.label}</span>
                    <span className="chip shrink-0">{providerLabel(profile.provider)}</span>
                    <span className={cn("chip shrink-0", profile.type === "oauth" ? "chip-accent" : "")}>
                      {typeLabel(profile.type)}
                    </span>
                    {isAuto && <span className="chip shrink-0">自动备份</span>}
                    {active && <span className="chip chip-success shrink-0">当前生效</span>}
                  </span>
                  <span className="text-[11px] text-dim">{formatTime(profile.createdAt)}</span>
                  {profile.note && <span className="truncate text-[11px] text-dim">· {profile.note}</span>}
                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    {!active && (
                      <button
                        onClick={() => void switchTo(profile)}
                        disabled={busy === profile.id}
                        className="btn btn-sm btn-ghost"
                      >
                        {busy === profile.id ? (
                          <Loader2 size={10} className="anim-spin" />
                        ) : (
                          <ArrowLeftRight size={10} />
                        )}{" "}
                        切换
                      </button>
                    )}
                    <button
                      onClick={() => void editNote(profile)}
                      disabled={busy === profile.id}
                      className="btn btn-sm btn-ghost"
                      title="备注"
                    >
                      <PencilLine size={10} />
                    </button>
                    <button
                      onClick={() => void remove(profile)}
                      disabled={busy === profile.id}
                      className="btn btn-sm btn-ghost text-danger"
                      title="删除"
                    >
                      <Trash2 size={10} />
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        )}

        <div className="flex items-center gap-1.5 text-[11px] text-dim">
          <KeyRound size={10} />
          档本体存于 {profiles?.backupDir ?? "~/.pi/agent/elenva-auth-backups"}（0600）；界面与接口只读档元数据，不显示凭据内容。
        </div>
      </div>
    </Card>
  );
}
