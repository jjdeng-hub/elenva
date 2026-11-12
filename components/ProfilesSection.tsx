"use client";

import { Loader2, Plug, RefreshCw, Unplug } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/components/ui/dialog";

/**
 * 设置页「Agent 与 Profile」小节（P3a：发现 + 接入 / 断开；不做创建/删除）。
 *
 * 数据来自 /api/profiles（Hermes profile 只读发现层）：
 * 未接入的显示「未接入」+ 会话数 + 接入按钮；已接入的显示「移出 ELENVA」。
 * 接入/断开成功后广播 `elenva-agents-changed`，侧栏 Agent 列表立即重取 /api/agents。
 */

interface ProfileEntry {
  id: string;
  available: boolean;
  displayName: string;
  model: string | null;
  sessionCount: number | null;
  lastActiveAt: number | null;
  connected: boolean;
}

function formatActive(seconds: number | null): string {
  if (seconds == null) return "—";
  const ms = seconds * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function ProfilesSection() {
  const [profiles, setProfiles] = useState<ProfileEntry[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** 二次确认中的 profile id（断开用） */
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/profiles", { cache: "no-store" })
      .then((res) => res.json())
      .then((data: { profiles?: ProfileEntry[] }) => {
        if (Array.isArray(data.profiles)) setProfiles(data.profiles);
      })
      .catch(() => {
        toast("Profile 名册读取失败");
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const act = useCallback(
    async (entry: ProfileEntry, action: "connect" | "disconnect") => {
      setBusy(`${action}:${entry.id}`);
      try {
        const res = await fetch("/api/profiles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, id: entry.id }),
        });
        const data = (await res.json()) as { error?: string };
        if (!res.ok) {
          toast(data.error ?? "操作失败");
          return;
        }
        toast(action === "connect" ? `已接入：${entry.displayName}` : `已移出 ELENVA：${entry.displayName}（Hermes 数据未动）`);
        window.dispatchEvent(new Event("elenva-agents-changed"));
        setConfirming(null);
        load();
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Agent 与 Profile</CardTitle>
        <button
          type="button"
          onClick={load}
          className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-dim t-fast hover:bg-panel-2 hover:text-fg t-fast"
          title="重新扫描"
        >
          <RefreshCw size={12} />
        </button>
      </CardHeader>
      <div className="flex flex-col gap-1">
        {profiles === null && (
          <div className="flex items-center gap-2 px-2 py-3 text-[12px] text-dim">
            <Loader2 size={12} className="animate-spin" /> 正在扫描 Hermes profile…
          </div>
        )}
        {profiles?.map((entry) => {
          const busyNow = busy !== null;
          return (
            <div key={entry.id} className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-panel-2 t-fast">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium">{entry.displayName}</span>
                  <span className="shrink-0 font-mono text-[10px] text-dim">{entry.id}</span>
                  <span
                    className={entry.connected ? "chip chip-accent shrink-0" : "chip shrink-0 text-dim"}
                  >
                    {entry.connected ? "已接入" : "未接入"}
                  </span>
                </div>
                <div className="mt-0.5 truncate text-[11px] text-dim">
                  {entry.model ?? "模型未知"} · {entry.sessionCount ?? "?"} 会话 · 最后活动 {formatActive(entry.lastActiveAt)}
                </div>
              </div>
              {entry.connected ? (
                confirming === entry.id ? (
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-[11px] text-dim">只移出 ELENVA，Hermes 数据不删</span>
                    <button
                      type="button"
                      disabled={busyNow}
                      onClick={() => act(entry, "disconnect")}
                      className="btn btn-sm btn-ghost text-danger"
                    >
                      {busy === `disconnect:${entry.id}` ? <Loader2 size={12} className="animate-spin" /> : <Unplug size={12} />}
                      确认移出
                    </button>
                    <button type="button" onClick={() => setConfirming(null)} className="btn btn-sm btn-ghost">
                      取消
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={busyNow}
                    onClick={() => setConfirming(entry.id)}
                    className="btn btn-sm btn-ghost shrink-0"
                  >
                    <Unplug size={12} />
                    移出 ELENVA
                  </button>
                )
              ) : (
                <button
                  type="button"
                  disabled={busyNow || !entry.available}
                  onClick={() => act(entry, "connect")}
                  className="btn btn-sm btn-ghost shrink-0"
                  title={entry.available ? undefined : "profile 不可用（缺 config.yaml）"}
                >
                  {busy === `connect:${entry.id}` ? <Loader2 size={12} className="animate-spin" /> : <Plug size={12} />}
                  接入
                </button>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
