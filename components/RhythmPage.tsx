"use client";

import {
  AlarmClock,
  AlertCircle,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  History,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "@/components/lib/utils";
import { EmptyState, PageHeader } from "@/components/ui/bits";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { dialogConfirm, toast } from "@/components/ui/dialog";
import { relTime } from "@/lib/format";

// ============================================================================
// 类型（与 Hermes /api/cron/* 返回对齐，经 /api/hermes 受控代理）
// ============================================================================

type HermesSchedule = {
  kind: "cron" | "interval" | "once" | string;
  display: string;
  expr?: string;
  minutes?: number;
  run_at?: string;
};

type HermesJob = {
  id: string;
  name: string;
  schedule: HermesSchedule;
  paused?: boolean | null;
  state?: string | null;
  last_run_at?: string | null;
  last_status?: string | null;
  last_error?: string | null;
  last_failure?: string | null;
  next_run_at?: string | null;
  deliver?: string | null;
  no_agent?: boolean | null;
  script?: string | null;
  prompt?: string | null;
  profile_name?: string | null;
  workdir?: string | null;
};

/** 运行记录：agent 型是 SessionDB 行，script 型是 cron_output 文档（字段都往这儿兼容）。 */
type HermesRun = {
  id: string;
  started_at?: number | null;
  ended_at?: number | null;
  title?: string | null;
  preview?: string | null;
  error?: string | null;
  last_activity_description?: string | null;
};

type DeliveryTarget = { id: string; name: string };

/** 代理层统一错误：{error:{code,message,detail?}}；Hermes 原始 4xx 是 {detail}。 */
function errorMessage(data: unknown, fallback: string): string {
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const err = obj.error;
    if (err && typeof err === "object") {
      const e = err as Record<string, unknown>;
      const parts = [e.message, e.detail].filter((p): p is string => typeof p === "string" && !!p);
      if (parts.length) return parts.join("：");
    }
    if (typeof err === "string") return err;
    if (typeof obj.detail === "string" && obj.detail) return obj.detail;
  }
  return fallback;
}

/**
 * profile：应用包 Agent 有自己的 profile（Tom=default、内容创作=content…），
 * cron 的读与写都必须落在**这个 profile 的 cron** 上，不能落到 serve 的跨 profile
 * 默认视角（?profile=all）或别的 profile 的 store。缺省（内置 Elen / 平台级）不带参数。
 */
async function hermesFetch<T>(
  path: string,
  init?: RequestInit & { confirm?: boolean },
  profile?: string,
): Promise<T> {
  const { confirm, ...rest } = init ?? {};
  const headers = new Headers(rest.headers);
  if (confirm) headers.set("X-Elenva-Confirm", "1");
  if (rest.body) headers.set("Content-Type", "application/json");
  const suffix = profile ? `${path.includes("?") ? "&" : "?"}profile=${encodeURIComponent(profile)}` : "";
  const res = await fetch(`/api/hermes/${path}${suffix}`, { ...rest, headers, cache: "no-store" });
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) throw new Error(errorMessage(data, `Hermes 返回 ${res.status}`));
  return data as T;
}

// ============================================================================
// 小工具
// ============================================================================

function relFuture(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(diff)) return "—";
  if (diff <= 0) return "即将";
  const min = Math.floor(diff / 60000);
  if (min < 1) return "不到 1 分钟";
  if (min < 60) return `${min} 分钟后`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时后`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天后`;
  return new Date(iso).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function epochTime(epoch: number): string {
  return new Date(epoch * 1000).toLocaleString("zh-CN", { hour12: false });
}

function isoTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { hour12: false });
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

/** 分钟数 → Hermes schedule 字符串（parse_schedule 接受 "every 30m" / "every 1h"）。 */
function intervalSchedule(minutes: number): string {
  return minutes % 60 === 0 ? `every ${minutes / 60}h` : `every ${minutes}m`;
}

// ============================================================================
// 表单
// ============================================================================

type JobType = "prompt" | "script";
type TabId = "interval" | "daily" | "cron";

type FormState = {
  id: string | null;
  name: string;
  tab: TabId;
  intervalMinutes: number;
  dailyAt: string;
  cron: string;
  type: JobType;
  content: string;
  deliver: string;
};

const TAB_LABELS: { id: TabId; label: string }[] = [
  { id: "interval", label: "每 N 小时" },
  { id: "daily", label: "每天" },
  { id: "cron", label: "cron 表达式" },
];

const INTERVAL_CHOICES = [30, 60, 120, 180, 360, 720, 1440];

const inputCls =
  "h-8 rounded-lg border border-line bg-panel-2 px-2.5 text-[12px] text-fg outline-none t-fast focus:border-accent/60";

function emptyForm(): FormState {
  return {
    id: null,
    name: "",
    tab: "interval",
    intervalMinutes: 60,
    dailyAt: "08:00",
    cron: "0 8 * * *",
    type: "prompt",
    content: "",
    deliver: "local",
  };
}

function formFromJob(job: HermesJob): FormState {
  const base = emptyForm();
  base.id = job.id;
  base.name = job.name;
  base.deliver = job.deliver || "local";
  base.type = job.no_agent ? "script" : "prompt";
  base.content = job.no_agent ? (job.script ?? "") : (job.prompt ?? "");
  const s = job.schedule;
  if (s.kind === "interval" && typeof s.minutes === "number") {
    base.tab = "interval";
    base.intervalMinutes = INTERVAL_CHOICES.includes(s.minutes) ? s.minutes : 60;
    if (!INTERVAL_CHOICES.includes(s.minutes)) base.tab = "cron";
  } else {
    base.tab = "cron";
  }
  if (s.kind === "cron" && s.expr) {
    // 每天 HH:MM 的 cron 反推回预设；识别不了就留在 cron 表达式
    const m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(s.expr.trim());
    if (m) {
      const [, min, hour] = m;
      base.tab = "daily";
      base.dailyAt = `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
    } else {
      base.cron = s.expr;
    }
  } else if (s.kind === "interval" && s.expr) {
    base.cron = s.expr;
  }
  return base;
}

function scheduleFromForm(form: FormState): string {
  switch (form.tab) {
    case "interval":
      return intervalSchedule(form.intervalMinutes);
    case "daily": {
      const [h, m] = form.dailyAt.split(":");
      return `${Number(m)} ${Number(h)} * * *`;
    }
    case "cron":
      return form.cron.trim();
  }
}

/** 客户端能判的先判（schedule 合法性只有 Hermes 知道，留给提交后的报错展示）。 */
function formError(form: FormState): string | null {
  if (!form.name.trim()) return "任务名称不能为空";
  if (form.name.trim().length > 60) return "任务名称最长 60 字";
  if (!form.content.trim()) return form.type === "script" ? "脚本路径不能为空" : "任务内容不能为空";
  if (form.tab === "daily" && !/^\d{1,2}:\d{2}$/.test(form.dailyAt)) return "时间格式应为 HH:MM";
  if (form.tab === "cron" && form.cron.trim().split(/\s+/).length < 5) return "cron 表达式至少 5 段";
  return null;
}

/** 提交体：P4b 写请求统一带 confirm（代理层校验，转发前剥掉）。 */
function payloadFromForm(form: FormState): Record<string, unknown> {
  const base: Record<string, unknown> = {
    name: form.name.trim(),
    schedule: scheduleFromForm(form),
    deliver: form.deliver,
    confirm: true,
  };
  if (form.type === "script") {
    base.script = form.content.trim();
    base.no_agent = true;
    base.prompt = "";
  } else {
    base.script = null;
    base.no_agent = false;
    base.prompt = form.content.trim();
  }
  return base;
}

// ============================================================================
// 页面
// ============================================================================

export function RhythmPage({ profile }: { profile?: string } = {}) {
  const [jobs, setJobs] = useState<HermesJob[]>([]);
  const [targets, setTargets] = useState<DeliveryTarget[]>([]);
  const [backendDown, setBackendDown] = useState(false);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FormState | null>(null);
  const [formErrorText, setFormErrorText] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [runs, setRuns] = useState<Record<string, HermesRun[]>>({});

  const load = useCallback(async () => {
    try {
      const data = await hermesFetch<HermesJob[]>("cron/jobs", undefined, profile);
      setJobs(data ?? []);
      setBackendDown(false);
    } catch (error) {
      setBackendDown(true);
      setJobs([]);
      if (loading) toast(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [loading, profile]);

  const loadTargets = useCallback(async () => {
    try {
      const data = await hermesFetch<{ targets?: DeliveryTarget[] }>("cron/delivery-targets", undefined, profile);
      setTargets(data.targets ?? []);
    } catch {
      setTargets([]);
    }
  }, [profile]);

  useEffect(() => {
    void load();
    void loadTargets();
    const timer = setInterval(() => {
      if (document.hidden || form) return;
      void load();
    }, 15000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sorted = useMemo(
    () => [...jobs].sort((a, b) => a.name.localeCompare(b.name, "zh-CN")),
    [jobs],
  );

  const toggleExpand = async (job: HermesJob) => {
    const next = new Set(expanded);
    if (next.has(job.id)) {
      next.delete(job.id);
      setExpanded(next);
      return;
    }
    next.add(job.id);
    setExpanded(next);
    await loadRuns(job.id);
  };

  const loadRuns = useCallback(async (jobId: string) => {
    try {
      const data = await hermesFetch<{ runs?: HermesRun[] }>(`cron/jobs/${jobId}/runs?limit=5`, undefined, profile);
      setRuns((prev) => ({ ...prev, [jobId]: data.runs ?? [] }));
    } catch (error) {
      setRuns((prev) => ({ ...prev, [jobId]: [] }));
      toast(error instanceof Error ? error.message : String(error));
    }
  }, [profile]);

  const targetName = useCallback(
    (id: string | null | undefined) => targets.find((t) => t.id === id)?.name ?? id ?? "—",
    [targets],
  );

  const pauseResume = async (job: HermesJob) => {
    // Hermes 列表里 paused 恒为 None，暂停态在 state 字段（paused / scheduled）
    const paused = job.state === "paused" || !!job.paused;
    setBusyId(job.id);
    try {
      await hermesFetch(
        `cron/jobs/${job.id}/${paused ? "resume" : "pause"}`,
        { method: "POST", confirm: true, body: JSON.stringify({ confirm: true }) },
        profile,
      );
      toast(paused ? "已恢复" : "已暂停");
      await load();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId(null);
    }
  };

  const trigger = async (job: HermesJob) => {
    setRunningId(job.id);
    try {
      await hermesFetch(
        `cron/jobs/${job.id}/trigger`,
        { method: "POST", confirm: true, body: JSON.stringify({ confirm: true }) },
        profile,
      );
      toast("运行结束");
      await load();
      if (expanded.has(job.id)) await loadRuns(job.id);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    } finally {
      setRunningId(null);
    }
  };

  const removeJob = async (job: HermesJob) => {
    const ok = await dialogConfirm({
      title: `删除节律任务「${job.name}」？`,
      message: "删除后 Hermes 不再按此计划执行，任务定义不可恢复。",
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    setBusyId(job.id);
    try {
      await hermesFetch(`cron/jobs/${job.id}`, { method: "DELETE", confirm: true }, profile);
      toast("已删除");
      await load();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId(null);
    }
  };

  const submitForm = async () => {
    if (!form) return;
    const err = formError(form);
    if (err) {
      setFormErrorText(err);
      return;
    }
    setSaving(true);
    setFormErrorText(null);
    try {
      if (form.id) {
        const { confirm, ...updates } = payloadFromForm(form);
        await hermesFetch(
          `cron/jobs/${form.id}`,
          { method: "PUT", confirm: true, body: JSON.stringify({ updates, confirm }) },
          profile,
        );
        toast("已保存");
      } else {
        await hermesFetch(
          "cron/jobs",
          { method: "POST", confirm: true, body: JSON.stringify(payloadFromForm(form)) },
          profile,
        );
        toast("已创建");
      }
      setForm(null);
      await load();
    } catch (error) {
      // 失败态：把 Hermes 的原始报错（如 schedule 非法）显示在表单上，不吞掉
      setFormErrorText(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="page-col-form py-6">
        <PageHeader
          icon={<AlarmClock size={16} />}
          title="节律"
          subtitle="Hermes 定时任务 · 按计划自动执行，投递结果到指定目标"
          actions={
            <>
              <button onClick={() => void load()} className="btn btn-sm btn-ghost" title="刷新">
                <RefreshCw size={12} />
                刷新
              </button>
              <button
                onClick={() => {
                  setFormErrorText(null);
                  setForm(emptyForm());
                }}
                className="btn btn-sm btn-primary"
              >
                <Plus size={12} />
                新建节律
              </button>
            </>
          }
        />

        {backendDown && !loading && (
          <Card className="mb-4 px-6 py-8">
            <EmptyState
              icon={<AlertCircle size={20} />}
              title="Hermes 后端未就绪"
              hint="读不到定时任务。到「系统」页确认 Hermes serve 状态，或点上面的刷新重试。"
              action={
                <button onClick={() => void load()} className="btn btn-sm btn-primary">
                  <RefreshCw size={12} />
                  重试
                </button>
              }
            />
          </Card>
        )}

        {form && (
          <Card className="mb-4">
            <CardHeader>
              <CardTitle>{form.id ? "编辑节律" : "新建节律"}</CardTitle>
              <button
                onClick={() => setForm(null)}
                className="btn btn-sm btn-subtle ml-auto"
                aria-label="关闭表单"
              >
                <X size={12} />
              </button>
            </CardHeader>
            <div className="flex flex-col gap-3 p-4">
              <label className="flex flex-col gap-1.5">
                <span className="text-[12px] text-dim">名称</span>
                <input
                  value={form.name}
                  maxLength={60}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="如：每日进展汇总"
                  className={cn(inputCls, "w-full max-w-md")}
                />
              </label>

              <div className="flex flex-col gap-1.5">
                <span className="text-[12px] text-dim">触发规则</span>
                <ScheduleEditor form={form} onChange={(patch) => setForm({ ...form, ...patch })} />
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-[12px] text-dim">类型</span>
                <div className="flex w-fit items-center rounded-lg border border-line bg-panel-2 p-0.5">
                  {(
                    [
                      { id: "prompt", label: "Prompt（跑 Agent 会话）" },
                      { id: "script", label: "脚本（只跑脚本，不进 Agent）" },
                    ] as const
                  ).map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      aria-pressed={form.type === t.id}
                      onClick={() => setForm({ ...form, type: t.id })}
                      className={cn(
                        "h-7 cursor-pointer rounded-md px-2.5 text-[12px] t-fast",
                        form.type === t.id ? "bg-active font-medium text-accent" : "text-muted hover:text-fg",
                      )}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              <label className="flex flex-col gap-1.5">
                <span className="text-[12px] text-dim">
                  {form.type === "script" ? "脚本（~/.hermes/scripts/ 下的路径，如 probe.sh）" : "任务内容（每轮发给 Agent 的 prompt）"}
                </span>
                <textarea
                  value={form.content}
                  onChange={(e) => setForm({ ...form, content: e.target.value })}
                  rows={form.type === "script" ? 2 : 4}
                  spellCheck={false}
                  placeholder={form.type === "script" ? "elenva-probe.sh" : "如：汇总今天在仓库里的改动，写进 worklog。"}
                  className={cn(
                    "w-full rounded-lg border border-line bg-panel-2 px-2.5 py-2 text-[12px] leading-relaxed text-fg outline-none t-fast placeholder:text-dim focus:border-accent/60",
                    form.type === "script" && "font-mono resize-none",
                  )}
                />
              </label>

              <label className="flex flex-col gap-1.5">
                <span className="text-[12px] text-dim">投递目标（结果发到哪）</span>
                {targets.length > 0 ? (
                  <select
                    value={form.deliver}
                    onChange={(e) => setForm({ ...form, deliver: e.target.value })}
                    className={cn(inputCls, "w-fit cursor-pointer")}
                  >
                    {targets.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={form.deliver}
                    onChange={(e) => setForm({ ...form, deliver: e.target.value })}
                    spellCheck={false}
                    placeholder="local"
                    className={cn(inputCls, "w-48 font-mono")}
                  />
                )}
              </label>

              {formErrorText && (
                <div className="flex items-start gap-1.5 text-[12px] text-danger">
                  <AlertCircle size={12} className="mt-0.5 shrink-0" />
                  <span className="break-all">{formErrorText}</span>
                </div>
              )}

              <div className="flex items-center justify-end gap-2">
                <button onClick={() => setForm(null)} className="btn btn-sm btn-ghost">
                  取消
                </button>
                <button onClick={() => void submitForm()} disabled={saving} className="btn btn-sm btn-primary">
                  {saving ? <Loader2 size={12} className="anim-spin" /> : <Check size={12} />}
                  {form.id ? "保存" : "创建"}
                </button>
              </div>
            </div>
          </Card>
        )}

        {loading ? (
          <Card className="px-6 py-10">
            <div className="flex items-center justify-center gap-2 text-[12px] text-dim">
              <Loader2 size={14} className="anim-spin" />
              正在读取节律…
            </div>
          </Card>
        ) : !backendDown && sorted.length === 0 ? (
          <Card>
            <EmptyState
              icon={<CalendarClock size={20} />}
              title="还没有节律任务"
              hint="建一条：选好触发规则与要跑的内容，到点 Hermes 会自动执行。"
              action={
                <button onClick={() => setForm(emptyForm())} className="btn btn-primary">
                  <Plus size={12} />
                  新建第一条
                </button>
              }
            />
          </Card>
        ) : (
          <div className="flex flex-col gap-3">
            {sorted.map((job) => (
              <JobCard
                key={job.id}
                job={job}
                busy={busyId === job.id}
                running={runningId === job.id}
                expanded={expanded.has(job.id)}
                jobRuns={runs[job.id] ?? null}
                targetName={targetName(job.deliver)}
                onToggleExpand={() => void toggleExpand(job)}
                onPauseResume={() => void pauseResume(job)}
                onRun={() => void trigger(job)}
                onEdit={() => {
                  setFormErrorText(null);
                  setForm(formFromJob(job));
                }}
                onDelete={() => void removeJob(job)}
                onReloadRuns={() => void loadRuns(job.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ScheduleEditor({ form, onChange }: { form: FormState; onChange: (patch: Partial<FormState>) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex w-fit items-center rounded-lg border border-line bg-panel-2 p-0.5">
        {TAB_LABELS.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-pressed={form.tab === t.id}
            onClick={() => onChange({ tab: t.id })}
            className={cn(
              "h-7 cursor-pointer rounded-md px-2.5 text-[12px] t-fast",
              form.tab === t.id ? "bg-active font-medium text-accent" : "text-muted hover:text-fg",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
        {form.tab === "interval" && (
          <>
            <span>每</span>
            <select
              value={form.intervalMinutes}
              onChange={(e) => onChange({ intervalMinutes: Number(e.target.value) })}
              className={cn(inputCls, "cursor-pointer tabular-nums")}
            >
              {INTERVAL_CHOICES.map((m) => (
                <option key={m} value={m}>
                  {m % 60 === 0 ? `${m / 60} 小时` : `${m} 分钟`}
                </option>
              ))}
            </select>
            <span>执行一次</span>
          </>
        )}

        {form.tab === "daily" && (
          <>
            <span>每天</span>
            <input
              type="time"
              value={form.dailyAt}
              onChange={(e) => onChange({ dailyAt: e.target.value })}
              className={cn(inputCls, "w-28 tabular-nums")}
            />
          </>
        )}

        {form.tab === "cron" && (
          <input
            value={form.cron}
            onChange={(e) => onChange({ cron: e.target.value })}
            placeholder="分 时 日 月 周，如 0 8 * * 1"
            spellCheck={false}
            className={cn(inputCls, "w-full max-w-sm font-mono")}
          />
        )}
      </div>

      <div className="text-[11px] text-dim">提交后 Hermes 会校验规则；非法值会把原始报错显示在这里。</div>
    </div>
  );
}

// ============================================================================
// 单条任务
// ============================================================================

function JobCard({
  job,
  busy,
  running,
  expanded,
  jobRuns,
  targetName,
  onToggleExpand,
  onPauseResume,
  onRun,
  onEdit,
  onDelete,
}: {
  job: HermesJob;
  busy: boolean;
  running: boolean;
  expanded: boolean;
  jobRuns: HermesRun[] | null;
  targetName: string;
  onToggleExpand: () => void;
  onPauseResume: () => void;
  onRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onReloadRuns: () => void;
}) {
  // Hermes 列表里 paused 恒为 None，暂停态在 state 字段（paused / scheduled）
  const paused = job.state === "paused" || !!job.paused;
  return (
    <Card>
      <div className="flex items-start gap-3 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={onToggleExpand}
              aria-label={expanded ? "收起最近运行" : "展开最近运行"}
              className="flex cursor-pointer items-center gap-1 text-left"
            >
              {expanded ? (
                <ChevronDown size={14} className="shrink-0 text-dim" />
              ) : (
                <ChevronRight size={14} className="shrink-0 text-dim" />
              )}
              <span className="text-[13px] font-semibold text-fg">{job.name}</span>
            </button>
            <span className={cn("chip", paused ? "" : "chip-accent")}>{paused ? "已暂停" : "active"}</span>
            {job.no_agent && <span className="chip">脚本</span>}
            {running ? (
              <span className="chip chip-accent">
                <Loader2 size={12} className="anim-spin" />
                运行中
              </span>
            ) : job.last_status ? (
              <span
                className={cn("chip", job.last_status === "ok" ? "" : "chip-danger")}
                title={[job.last_error, job.last_failure].filter(Boolean).join(" · ") || undefined}
              >
                {job.last_status === "ok" ? "ok" : job.last_status === "error" ? "error" : job.last_status}
                {job.last_run_at && <span className="text-dim">{relTime(job.last_run_at)}</span>}
              </span>
            ) : (
              <span className="chip">未运行</span>
            )}
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-5 text-[12px] text-muted">
            <span className="flex items-center gap-1">
              <CalendarClock size={12} className="text-dim" />
              {job.schedule?.display ?? "—"}
            </span>
            {!paused && job.next_run_at && (
              <span title={isoTime(job.next_run_at)}>下次 {relFuture(job.next_run_at)}</span>
            )}
            <span>投递：{targetName}</span>
            {(job.last_error || job.last_failure) && (
              <span className="min-w-0 flex-1 truncate text-danger">
                {[job.last_error, job.last_failure].filter(Boolean).join(" · ")}
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            onClick={onPauseResume}
            disabled={busy}
            className="btn btn-sm btn-ghost"
            title={paused ? "恢复" : "暂停"}
          >
            {paused ? <Play size={12} /> : <Pause size={12} />}
            {paused ? "恢复" : "暂停"}
          </button>
          <button onClick={onRun} disabled={busy || running} className="btn btn-sm btn-ghost">
            {running ? <Loader2 size={12} className="anim-spin" /> : <Play size={12} />}
            立即执行
          </button>
          <button onClick={onEdit} disabled={busy} className="btn btn-sm btn-subtle">
            <Pencil size={12} />
            编辑
          </button>
          <button onClick={onDelete} disabled={busy} className="btn btn-icon btn-subtle" title="删除" aria-label="删除">
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {expanded && <RunList runs={jobRuns} />}
    </Card>
  );
}

function RunList({ runs }: { runs: HermesRun[] | null }) {
  return (
    <div className="border-t border-line-soft bg-panel-2/40 px-4 py-3">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] text-dim">
        <History size={12} />
        最近 5 次运行
      </div>
      {runs === null ? (
        <div className="flex items-center gap-2 text-[12px] text-dim">
          <Loader2 size={12} className="anim-spin" />
          正在读取…
        </div>
      ) : runs.length === 0 ? (
        <div className="text-[12px] text-dim">还没有运行记录。</div>
      ) : (
        <div className="flex flex-col">
          {runs.map((run, i) => {
            const failed = !!run.error;
            const done = run.ended_at != null;
            const start = run.started_at ? run.started_at * 1000 : null;
            const end = run.ended_at ? run.ended_at * 1000 : null;
            const summary = run.preview || run.last_activity_description || run.title || "";
            return (
              <div
                key={run.id || `${run.started_at}-${i}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line-soft py-1.5 text-[12px] last:border-b-0"
              >
                <span className="w-36 shrink-0 tabular-nums text-muted" title={start ? epochTime(run.started_at!) : ""}>
                  {start ? epochTime(start / 1000) : "—"}
                </span>
                {failed ? (
                  <span className="chip chip-danger">error</span>
                ) : done ? (
                  <span className="chip">ok</span>
                ) : (
                  <span className="chip chip-accent">运行中</span>
                )}
                {start && end && (
                  <span className="tabular-nums text-dim" title="本轮运行时长">
                    {fmtDuration(end - start)}
                  </span>
                )}
                {summary && (
                  <span className="min-w-0 flex-1 truncate text-dim" title={summary}>
                    {summary}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
