"use client";

import { Loader2, Plug, Plus, RefreshCw, Trash2, Unplug, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { dialogConfirm, dialogPrompt, toast } from "@/components/ui/dialog";

/**
 * 设置页「Agent 与 Profile」小节（P3a 发现 + 接入/断开；P3b 创建 + 删除 + 回收站）。
 *
 * 数据来自 /api/profiles（Hermes profile 只读发现层）。
 * 创建是异步任务：POST 拿 jobId，轮询 /api/profiles/jobs/<jobId> 显示进度与失败原因。
 * 删除 = 「归档并删除」：弹窗显示归档路径 + 会话数，必须输入 profile id 才能确认。
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

interface ArchiveEntry {
  path: string;
  name: string;
  sizeBytes: number;
  modifiedAt: string;
}

interface ProfileJob {
  jobId: string;
  status: "running" | "done" | "error";
  step: string;
  error?: string;
}

function formatActive(seconds: number | null): string {
  if (seconds == null) return "—";
  const d = new Date(seconds * 1000);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 轮询上限：60 次 × 1s，超过就停，不再无限等待 running */
const CREATE_POLL_MAX = 60;
const CREATE_POLL_INTERVAL_MS = 1000;

/* ---------------- 创建抽屉 ---------------- */

function CreateDrawer(props: {
  profiles: ProfileEntry[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [id, setId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [soul, setSoul] = useState("");
  const [cloneFrom, setCloneFrom] = useState("");
  const [model, setModel] = useState("");
  const [connect, setConnect] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [job, setJob] = useState<ProfileJob | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [waited, setWaited] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  // 卸载（关闭抽屉）时中止在途轮询，组件销毁后不再发请求
  useEffect(() => () => abortRef.current?.abort(), []);

  const idTaken = props.profiles.some((p) => p.id === id.trim());
  const idValid = /^[a-z][a-z0-9-]{1,30}$/.test(id.trim());

  // 提交 → 轮询任务直到 done / error / 超时 / 异常；任何失败都保留表单与草稿
  const submit = useCallback(async () => {
    setFormError(null);
    setJob(null);
    setWaited(0);
    setSubmitting(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch("/api/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          id: id.trim(),
          displayName: displayName.trim() || id.trim(),
          soul,
          cloneFrom: cloneFrom || undefined,
          model: model.trim() || undefined,
          connect,
        }),
        signal: controller.signal,
      });
      const data = (await res.json()) as { jobId?: string; error?: string };
      if (!res.ok || !data.jobId) {
        setFormError(data.error ?? "创建请求被拒");
        return;
      }
      for (let i = 1; i <= CREATE_POLL_MAX; i++) {
        await new Promise((r) => setTimeout(r, CREATE_POLL_INTERVAL_MS));
        if (controller.signal.aborted) return;
        setWaited(i);
        const jobRes = await fetch(`/api/profiles/jobs/${data.jobId}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (jobRes.status === 404) {
          setFormError("任务不存在（可能服务重启过）");
          setJob(null);
          return;
        }
        if (!jobRes.ok) throw new Error(`任务查询失败（HTTP ${jobRes.status}）`);
        const jobData = (await jobRes.json()) as ProfileJob & { error?: string };
        setJob(jobData);
        if (jobData.status === "done") {
          toast(`已创建：${displayName.trim() || id.trim()}`);
          window.dispatchEvent(new Event("elenva-agents-changed"));
          props.onCreated();
          return;
        }
        if (jobData.status === "error") {
          // 清掉 running，避免遮罩/X 卡死；草稿仍在下方表单里
          setJob(null);
          setFormError(jobData.error ?? "创建失败");
          return;
        }
      }
      setJob(null);
      setFormError(`等待超过 ${CREATE_POLL_MAX} 秒任务仍未结束；可稍后在名册确认，或用下方表单重试。`);
    } catch (e) {
      if (controller.signal.aborted) return;
      setJob(null);
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setSubmitting(false);
    }
  }, [id, displayName, soul, cloneFrom, model, connect, props]);

  const running = job?.status === "running";
  const canSubmit = !submitting && idValid && !idTaken;

  /** X / 遮罩始终可用：running 时先确认再离开，中止本地轮询（不取消服务端任务） */
  const handleClose = async () => {
    if (running) {
      const ok = await dialogConfirm({
        title: "任务仍在后台运行",
        message: "创建任务还在进行，确定离开？任务会继续在后台执行，可稍后在名册里确认。",
        confirmText: "离开",
      });
      if (!ok) return;
      abortRef.current?.abort();
    }
    props.onClose();
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/40 t-fast" onClick={() => void handleClose()}>
      <div
        className="h-full w-[380px] overflow-y-auto bg-panel p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <div className="text-[14px] font-medium">新建 Agent</div>
          <button
            type="button"
            onClick={() => void handleClose()}
            className="ml-auto rounded-md p-1 text-dim t-fast hover:bg-panel-2 hover:text-fg"
            aria-label="关闭"
          >
            <X size={16} />
          </button>
        </div>

        {running && (
          <div className="mt-3 flex items-center gap-2 text-[12px] text-dim">
            <Loader2 size={12} className="animate-spin" />
            <span>{job?.step ?? "处理中"}</span>
            <span className="ml-auto tabular-nums">已等待 {waited}s / {CREATE_POLL_MAX}s</span>
          </div>
        )}

        {formError && (
          <div className="mt-3 flex flex-col gap-2 rounded-md bg-danger/10 p-2.5 text-[12px] leading-relaxed text-danger">
            <span>{formError}</span>
            <span className="text-[11px] text-muted">草稿仍在下方，可修改后重新创建。</span>
            <div className="flex items-center gap-2">
              <button onClick={() => void submit()} disabled={submitting} className="btn btn-sm btn-ghost">重试</button>
              <button onClick={() => { setFormError(null); setJob(null); }} className="btn btn-sm btn-ghost">关闭提示</button>
            </div>
          </div>
        )}

        <div className="mt-3 flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-dim">profile id（小写字母开头，字母/数字/连字符）</span>
              <input
                value={id}
                onChange={(e) => setId(e.target.value)}
                disabled={submitting}
                className="rounded-md bg-panel-2 px-2 py-1.5 font-mono text-[12px] outline-none"
                placeholder="例如 test-01"
              />
              {id && !idValid && <span className="text-[10px] text-danger">id 不合法</span>}
              {id && idValid && idTaken && <span className="text-[10px] text-danger">磁盘上已存在该 id</span>}
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-dim">显示名（写进 SOUL 标题）</span>
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                disabled={submitting}
                className="rounded-md bg-panel-2 px-2 py-1.5 text-[12px] outline-none"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-dim">SOUL 正文</span>
              <textarea
                value={soul}
                onChange={(e) => setSoul(e.target.value)}
                disabled={submitting}
                rows={5}
                className="resize-y rounded-md bg-panel-2 px-2 py-1.5 text-[12px] outline-none"
                placeholder="空白模板；或选「从现有 profile 复制」后覆盖"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-dim">从现有 profile 复制（SOUL/config/skills）</span>
              <select
                value={cloneFrom}
                onChange={(e) => setCloneFrom(e.target.value)}
                disabled={submitting}
                className="rounded-md bg-panel-2 px-2 py-1.5 text-[12px] outline-none"
              >
                <option value="">空白模板</option>
                {props.profiles
                  .filter((p) => p.id !== "default" && p.available)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      复制 {p.displayName}（{p.id}）
                    </option>
                  ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-dim">模型（config.yaml 的 model.default，可留空用默认）</span>
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={submitting}
                className="rounded-md bg-panel-2 px-2 py-1.5 font-mono text-[12px] outline-none"
              />
            </label>
            <label className="flex items-center gap-2 text-[12px]">
              <input type="checkbox" checked={connect} onChange={(e) => setConnect(e.target.checked)} disabled={submitting} />
              创建后立即接入 ELENVA
            </label>
            <div className="text-[10px] text-dim">
              本地可用；要接消息平台需在 Hermes 侧配通道。不会创建 systemd 服务。
            </div>
            <button
              type="button"
              disabled={!canSubmit}
              onClick={submit}
              className="btn btn-md btn-primary disabled:opacity-40"
            >
              {submitting ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
              创建（约 5~20 秒）
            </button>
          </div>
      </div>
    </div>
  );
}

/* ---------------- 删除弹窗 ---------------- */

function DeleteDialog(props: {
  entry: ProfileEntry;
  onClose: () => void;
  onDone: () => void;
}) {
  const [confirm, setConfirm] = useState("");
  const [archiveOnly, setArchiveOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canConfirm = confirm === props.entry.id && !busy;

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/profiles/${props.entry.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm, archiveOnly }),
      });
      const data = (await res.json()) as { error?: string; archive?: string; deleted?: boolean };
      if (!res.ok) {
        setError(data.error ?? "删除失败");
        return;
      }
      toast(
        data.deleted
          ? `已归档并删除：${props.entry.displayName}（归档 ${data.archive}）`
          : `已归档：${props.entry.displayName}（${data.archive}）`,
      );
      window.dispatchEvent(new Event("elenva-agents-changed"));
      props.onDone();
    } finally {
      setBusy(false);
    }
  }, [confirm, archiveOnly, props]);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 t-fast" onClick={props.onClose}>
      <div className="w-[440px] rounded-lg bg-panel p-4 shadow-lg" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <Trash2 size={16} className="text-danger" />
          <div className="text-[14px] font-medium">{archiveOnly ? "归档 profile" : "归档并删除"}</div>
          <button
            type="button"
            onClick={props.onClose}
            className="ml-auto rounded-md p-1 text-dim t-fast hover:bg-panel-2 hover:text-fg"
          >
            <X size={16} />
          </button>
        </div>

        <div className="mt-3 flex flex-col gap-1 rounded-md bg-panel-2 p-2 text-[12px]">
          <div className="flex justify-between">
            <span className="text-dim">profile</span>
            <span className="font-mono">{props.entry.id}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-dim">会话数</span>
            <span>{props.entry.sessionCount ?? "?"}（会话随 profile 一并归档）</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="shrink-0 text-dim">归档路径</span>
            <span className="break-all text-right font-mono text-[10px]">
              ~/.hermes/backups/profiles/{props.entry.id}-&lt;时间戳&gt;.tar.gz
            </span>
          </div>
        </div>

        <label className="mt-2 flex items-center gap-2 text-[12px]">
          <input type="checkbox" checked={archiveOnly} onChange={(e) => setArchiveOnly(e.target.checked)} disabled={busy} />
          只归档，不删除（之后可从回收站恢复）
        </label>

        <p className="mt-2 text-[11px] text-dim">
          {archiveOnly
            ? "仅生成归档文件，profile 与会话一条不动。"
            : "删除 = 归档并删除：先备份为 tar.gz，再删 profile。文件留在回收站，可随时恢复。"}
        </p>

        <label className="mt-3 flex flex-col gap-1">
          <span className="text-[11px] text-dim">
            输入 profile id「{props.entry.id}」以确认
          </span>
          <input
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={busy}
            className="rounded-md bg-panel-2 px-2 py-1.5 font-mono text-[12px] outline-none"
          />
        </label>

        {error && <div className="mt-2 rounded-md bg-panel-2 p-2 text-[12px] text-danger">{error}</div>}

        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={props.onClose} disabled={busy} className="btn btn-md btn-ghost">
            取消
          </button>
          <button type="button" disabled={!canConfirm} onClick={submit} className="btn btn-md btn-primary disabled:opacity-40 text-danger">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            {archiveOnly ? "归档" : "归档并删除"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- 主组件 ---------------- */

export function ProfilesSection() {
  const [profiles, setProfiles] = useState<ProfileEntry[] | null>(null);
  const [archives, setArchives] = useState<ArchiveEntry[] | null>(null);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const [archivesError, setArchivesError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** 二次确认中的 profile id（断开用） */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<ProfileEntry | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/profiles", { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: { profiles?: ProfileEntry[] }) => {
        setProfiles(Array.isArray(data.profiles) ? data.profiles : []);
        setProfilesError(null);
      })
      .catch((e) => {
        // 失败不置空：profiles 保持已有数据，由内联错误块 + 重试承载，不再恒显示「正在扫描」
        setProfilesError(e instanceof Error ? e.message : String(e));
      });
    fetch("/api/profiles/archives", { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: { archives?: ArchiveEntry[] }) => {
        setArchives(Array.isArray(data.archives) ? data.archives : []);
        setArchivesError(null);
      })
      .catch((e) => {
        setArchivesError(e instanceof Error ? e.message : String(e));
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

  const restore = useCallback(
    async (archive: ArchiveEntry) => {
      // 默认恢复名：去掉 -<时间戳> 后缀
      const base = archive.name.replace(/\.tar\.gz$/, "").replace(/-\d{8}-\d{6}$/, "");
      const name = await dialogPrompt({
        title: "恢复为什么 profile id？",
        message: `留空则用默认名 ${base}-restored`,
        defaultValue: `${base}-restored`,
        placeholder: "profile id",
        allowEmpty: true,
      });
      if (name === null) return;
      const target = name.trim();
      if (target && !/^[a-z][a-z0-9-]{1,30}$/.test(target)) {
        toast("id 不合法（小写字母开头，字母/数字/连字符）");
        return;
      }
      setRestoring(archive.path);
      try {
        const res = await fetch("/api/profiles/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ archive: archive.path, name: target || undefined, connect: false }),
        });
        const data = (await res.json()) as { error?: string; profile?: string };
        if (!res.ok) {
          toast(data.error ?? "恢复失败");
          return;
        }
        toast(`已恢复为 ${data.profile}（未接入；在名册里点「接入」）`);
        load();
      } finally {
        setRestoring(null);
      }
    },
    [load],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Agent 与 Profile</CardTitle>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="btn btn-sm btn-ghost"
            title="新建 Agent"
          >
            <Plus size={12} />
            新建 Agent
          </button>
          <button
            type="button"
            onClick={load}
            className="rounded-md p-1.5 text-dim t-fast hover:bg-panel-2 hover:text-fg"
            title="重新扫描"
          >
            <RefreshCw size={12} />
          </button>
        </div>
      </CardHeader>
      <div className="flex flex-col gap-1">
        {profilesError && (
          <div className="flex flex-wrap items-center gap-2 px-2 py-3 text-[12px] text-danger">
            <span>
              {profiles === null
                ? `Profile 名册读取失败：${profilesError}`
                : `名册更新失败，显示的是上次读取的结果：${profilesError}`}
            </span>
            <button onClick={load} className="btn btn-sm btn-ghost">重新读取</button>
          </div>
        )}
        {profiles === null && !profilesError && (
          <div className="flex items-center gap-2 px-2 py-3 text-[12px] text-dim">
            <Loader2 size={12} className="animate-spin" /> 正在扫描 Hermes profile…
          </div>
        )}
        {profiles?.map((entry) => {
          const busyNow = busy !== null;
          return (
            <div key={entry.id} className="group flex items-center gap-3 rounded-md px-2 py-2 hover:bg-panel-2 t-fast">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium">{entry.displayName}</span>
                  <span className="shrink-0 font-mono text-[10px] text-dim">{entry.id}</span>
                  <span className={entry.connected ? "chip chip-accent shrink-0" : "chip shrink-0 text-dim"}>
                    {entry.connected ? "已接入" : "未接入"}
                  </span>
                </div>
                <div className="mt-0.5 truncate text-[11px] text-dim">
                  {entry.model ?? "模型未知"} · {entry.sessionCount ?? "?"} 会话 · 最后活动 {formatActive(entry.lastActiveAt)}
                </div>
              </div>
              {confirming === entry.id ? (
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
                <div className="flex shrink-0 items-center gap-1">
                  {entry.connected ? (
                    <button
                      type="button"
                      disabled={busyNow}
                      onClick={() => setConfirming(entry.id)}
                      className="btn btn-sm btn-ghost"
                    >
                      <Unplug size={12} />
                      移出 ELENVA
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busyNow || !entry.available}
                      onClick={() => act(entry, "connect")}
                      className="btn btn-sm btn-ghost"
                      title={entry.available ? undefined : "profile 不可用（缺 config.yaml）"}
                    >
                      {busy === `connect:${entry.id}` ? <Loader2 size={12} className="animate-spin" /> : <Plug size={12} />}
                      接入
                    </button>
                  )}
                  {entry.id !== "default" && (
                    <button
                      type="button"
                      disabled={busyNow || !entry.available}
                      onClick={() => setDeleting(entry)}
                      className="btn btn-sm btn-ghost text-danger"
                      title="归档并删除"
                    >
                      <Trash2 size={12} />
                      删除…
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* 回收站（归档列表） */}
        <div className="mt-1 border-t border-panel-2 pt-2">
          <button
            type="button"
            onClick={() => setTrashOpen((v) => !v)}
            className="flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] text-dim t-fast hover:text-fg"
          >
            <Undo2 size={12} />
            回收站（归档）
            <span className="chip shrink-0">{archives === null ? (archivesError ? "!" : "…") : archives.length}</span>
            <span className="ml-auto font-mono text-[10px]">~/.hermes/backups/profiles/</span>
          </button>
          {trashOpen &&
            (archives?.length ? (
              <div className="flex flex-col gap-0.5">
                {archivesError && (
                  <div className="flex flex-wrap items-center gap-2 px-2 py-1 text-[11px] text-warn">
                    <span>归档列表可能不是最新：{archivesError}</span>
                    <button onClick={load} className="btn btn-sm btn-ghost">重试</button>
                  </div>
                )}
                {archives.map((a) => (
                  <div key={a.path} className="flex items-center gap-3 rounded-md px-2 py-1 text-[11px] hover:bg-panel-2">
                    <span className="min-w-0 flex-1 truncate font-mono">{a.name}</span>
                    <span className="shrink-0 text-dim">{formatSize(a.sizeBytes)}</span>
                    <span className="shrink-0 text-dim">
                      {new Date(a.modifiedAt).toLocaleString("zh-CN", {
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                    <button
                      type="button"
                      disabled={restoring !== null}
                      onClick={() => restore(a)}
                      className="btn btn-sm btn-ghost shrink-0"
                    >
                      {restoring === a.path ? <Loader2 size={12} className="animate-spin" /> : <Undo2 size={12} />}
                      恢复
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2 px-2 py-1 text-[11px] text-dim">
                {archivesError && archives === null ? (
                  <>
                    <span className="text-danger">归档读取失败：{archivesError}</span>
                    <button onClick={load} className="btn btn-sm btn-ghost">重试</button>
                  </>
                ) : archives === null ? (
                  "读取中…"
                ) : (
                  "暂无归档"
                )}
              </div>
            ))}
        </div>
      </div>

      {creating && (
        <CreateDrawer profiles={profiles ?? []} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); load(); }} />
      )}
      {deleting && (
        <DeleteDialog
          entry={deleting}
          onClose={() => setDeleting(null)}
          onDone={() => {
            setDeleting(null);
            load();
          }}
        />
      )}
    </Card>
  );
}
