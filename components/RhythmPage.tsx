"use client";

import {
  AlarmClock,
  AlertCircle,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  History,
  Loader2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DirPicker } from "@/components/DirPicker";
import { cn } from "@/components/lib/utils";
import { EmptyState, PageHeader } from "@/components/ui/bits";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { dialogConfirm, toast } from "@/components/ui/dialog";
import { basename, formatCost, formatDuration, formatTokens, relTime } from "@/lib/format";
import {
  cronExprError,
  describeSchedule,
  normalizeSafety,
  SAFETY_TIER_META,
  SAFETY_VALUES,
  WEEKDAY_NAMES,
  type Schedule,
  type ScheduleSafety,
} from "@/lib/schedule-format";

// ============================================================================
// 类型（与 /api/schedules 返回对齐）
// ============================================================================

type RunResult = "ok" | "failed" | "skipped" | "timeout";

type RunEntry = {
  at: string;
  sessionId: string;
  result: RunResult;
  note?: string;
  durationMs?: number;
};

type ScheduleDto = {
  id: string;
  name: string;
  enabled: boolean;
  schedule: Schedule;
  prompt: string;
  cwd: string;
  model?: { provider: string; modelId: string };
  safety: ScheduleSafety;
  catchUp: boolean;
  timeoutMinutes: number | null;
  lastFiredAt?: string;
  lastRun?: RunEntry;
  runHistory?: RunEntry[];
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  running: boolean;
  runningSessionId?: string | null;
};

/** /api/usage 里按会话 id → token / 费用（用于运行历史 join；取不到就不显示） */
type UsageSession = { tokens: { total: number }; cost: number; model?: string };

const RESULT_META: Record<RunResult, { label: string; cls: string }> = {
  ok: { label: "成功", cls: "chip-success" },
  failed: { label: "失败", cls: "chip-danger" },
  skipped: { label: "跳过", cls: "" },
  timeout: { label: "超时", cls: "chip-warn" },
};

// ============================================================================
// 小工具
// ============================================================================

/** 未来时间的人话（与 lib/format.relTime 对称，但方向朝前）。 */
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

function absTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { hour12: false });
}

function isAbsolutePath(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}

/** 列表行里的档位 chip：standard 不显示（占用最小）；只读中性、全权带警示。 */
function SafetyChip({ safety }: { safety: ScheduleSafety }) {
  if (safety === "readonly") {
    return <span className="chip">只读</span>;
  }
  if (safety === "full") {
    return (
      <span className="chip chip-warn" title={SAFETY_TIER_META.full.hint}>
        全权
      </span>
    );
  }
  return null;
}

function resultChip(run: RunEntry | undefined, running: boolean) {
  if (running) {
    return (
      <span className="chip chip-accent">
        <Loader2 size={12} className="anim-spin" />
        运行中
      </span>
    );
  }
  if (!run) return <span className="chip">未运行</span>;
  const meta = RESULT_META[run.result] ?? RESULT_META.skipped;
  return (
    <span className={cn("chip", meta.cls)} title={run.note || undefined}>
      {meta.label}
      <span className="text-dim">{relTime(run.at)}</span>
    </span>
  );
}

function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={on ? "暂停" : "启用"}
      title={on ? "暂停" : "启用"}
      onClick={() => onChange(!on)}
      disabled={disabled}
      className={cn("relative h-5 w-9 shrink-0 cursor-pointer rounded-full t-fast", on ? "bg-accent" : "bg-line")}
    >
      <span
        className={cn(
          "absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow-sm t-base",
          on ? "translate-x-4" : "translate-x-0",
        )}
      />
    </button>
  );
}

// ============================================================================
// 表单
// ============================================================================

type TriggerTab = "hourly" | "daily" | "weekly" | "cron";

type FormState = {
  id: string | null;
  name: string;
  tab: TriggerTab;
  minute: number;
  dailyAt: string;
  weekday: number;
  weeklyAt: string;
  cron: string;
  prompt: string;
  cwd: string;
  safety: ScheduleSafety;
};

const TAB_LABELS: { id: TriggerTab; label: string }[] = [
  { id: "hourly", label: "每小时" },
  { id: "daily", label: "每天" },
  { id: "weekly", label: "每周" },
  { id: "cron", label: "cron" },
];

function emptyForm(defaultCwd: string | null): FormState {
  return {
    id: null,
    name: "",
    tab: "daily",
    minute: 0,
    dailyAt: "09:00",
    weekday: 1,
    weeklyAt: "09:00",
    cron: "0 9 * * *",
    prompt: "",
    cwd: defaultCwd ?? "",
    safety: "standard",
  };
}

function formFromTask(task: ScheduleDto): FormState {
  const base = emptyForm(null);
  base.id = task.id;
  base.name = task.name;
  base.prompt = task.prompt;
  base.cwd = task.cwd;
  base.safety = normalizeSafety(task.safety);
  const s = task.schedule;
  base.tab = s.kind;
  if (s.kind === "hourly") base.minute = s.minute;
  if (s.kind === "daily") base.dailyAt = s.at;
  if (s.kind === "weekly") {
    base.weekday = s.weekday;
    base.weeklyAt = s.at;
  }
  if (s.kind === "cron") base.cron = s.expr;
  return base;
}

function scheduleFromForm(form: FormState): Schedule {
  switch (form.tab) {
    case "hourly":
      return { kind: "hourly", minute: form.minute };
    case "daily":
      return { kind: "daily", at: form.dailyAt };
    case "weekly":
      return { kind: "weekly", weekday: form.weekday, at: form.weeklyAt };
    case "cron":
      return { kind: "cron", expr: form.cron.trim() };
  }
}

/** 客户端能判的先判（目录存在性只有服务端知道，留给提交后的报错）。 */
function formError(form: FormState): string | null {
  if (!form.name.trim()) return "任务名称不能为空";
  if (form.name.trim().length > 40) return "任务名称最长 40 字";
  if (!form.prompt.trim()) return "任务内容不能为空";
  if (!form.cwd.trim()) return "请选择工作目录";
  if (!isAbsolutePath(form.cwd.trim())) return "工作目录必须是绝对路径";
  if (form.tab === "daily" && !/^\d{1,2}:\d{2}$/.test(form.dailyAt)) return "时间格式应为 HH:MM";
  if (form.tab === "weekly" && !/^\d{1,2}:\d{2}$/.test(form.weeklyAt)) return "时间格式应为 HH:MM";
  if (form.tab === "cron") {
    const err = cronExprError(form.cron);
    if (err) return err;
  }
  return null;
}

const inputCls =
  "h-8 rounded-lg border border-line bg-panel-2 px-2.5 text-[12px] text-fg outline-none t-fast focus:border-accent/60";

function TriggerEditor({
  form,
  onChange,
}: {
  form: FormState;
  onChange: (patch: Partial<FormState>) => void;
}) {
  const cronError = form.tab === "cron" ? cronExprError(form.cron) : null;
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
        {form.tab === "hourly" && (
          <>
            <span>每小时的第</span>
            <select
              value={form.minute}
              onChange={(e) => onChange({ minute: Number(e.target.value) })}
              className={cn(inputCls, "cursor-pointer tabular-nums")}
            >
              {Array.from({ length: 60 }, (_, i) => (
                <option key={i} value={i}>
                  {i}
                </option>
              ))}
            </select>
            <span>分</span>
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

        {form.tab === "weekly" && (
          <>
            <span>每</span>
            <select
              value={form.weekday}
              onChange={(e) => onChange({ weekday: Number(e.target.value) })}
              className={cn(inputCls, "cursor-pointer")}
            >
              {WEEKDAY_NAMES.map((name, i) => (
                <option key={i} value={i}>
                  {name}
                </option>
              ))}
            </select>
            <input
              type="time"
              value={form.weeklyAt}
              onChange={(e) => onChange({ weeklyAt: e.target.value })}
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
            className={cn(inputCls, "w-full max-w-sm font-mono", cronError ? "border-danger/60" : "")}
          />
        )}
      </div>

      {form.tab === "cron" && (
        <div className={cn("flex items-center gap-1.5 text-[11px]", cronError ? "text-danger" : "text-success")}>
          {cronError ? <AlertCircle size={12} /> : <Check size={12} />}
          {cronError ?? "cron 表达式合法"}
        </div>
      )}

      <div className="text-[11px] text-dim">下次触发：{describeSchedule(scheduleFromForm(form))}</div>
    </div>
  );
}

// ============================================================================
// 页面
// ============================================================================

export function RhythmPage({ defaultCwd, onOpenSession }: { defaultCwd: string | null; onOpenSession: (sessionId: string) => void }) {
  const [tasks, setTasks] = useState<ScheduleDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FormState | null>(null);
  const [formErrorText, setFormErrorText] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dirPickerOpen, setDirPickerOpen] = useState(false);
  const [usage, setUsage] = useState<Record<string, UsageSession> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/schedules", { cache: "no-store" });
      const data = (await res.json()) as { tasks?: ScheduleDto[]; error?: string };
      if (!res.ok) throw new Error(data.error || "加载失败");
      setTasks(data.tasks ?? []);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  /** token / 费用 join 数据：只在第一次展开历史时拉一次（/api/usage 要扫全部会话，不便宜）。 */
  const loadUsage = useCallback(async () => {
    try {
      const res = await fetch("/api/usage", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { sessions?: Record<string, UsageSession> };
      setUsage(data.sessions ?? {});
    } catch {
      setUsage({});
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.hidden) return;
      void load();
    }, 15000);
    return () => clearInterval(timer);
  }, [load]);

  const sorted = useMemo(
    () => [...tasks].sort((a, b) => Number(b.running) - Number(a.running)),
    [tasks],
  );

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (usage === null) void loadUsage();
  };

  const patchTask = async (task: ScheduleDto, patch: Record<string, unknown>, successText?: string) => {
    setBusyId(task.id);
    try {
      const res = await fetch(`/api/schedules/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error || "保存失败");
      if (successText) toast(successText);
      await load();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId(null);
    }
  };

  const runNow = async (task: ScheduleDto) => {
    setBusyId(task.id);
    try {
      const res = await fetch(`/api/schedules/${task.id}/run`, { method: "POST" });
      const data = (await res.json()) as { started?: boolean; note?: string; error?: string };
      if (!res.ok) throw new Error(data.error || "立即运行失败");
      toast(data.started ? "已启动一次运行" : data.note || "未启动（上一轮还没结束）");
      await load();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId(null);
    }
  };

  const removeTask = async (task: ScheduleDto) => {
    const ok = await dialogConfirm({
      title: `删除节律任务「${task.name}」？`,
      message: "只删任务本身，它已经跑出来的会话会保留。",
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    setBusyId(task.id);
    try {
      const res = await fetch(`/api/schedules/${task.id}`, { method: "DELETE" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || "删除失败");
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
      const payload = {
        name: form.name.trim(),
        prompt: form.prompt.trim(),
        cwd: form.cwd.trim(),
        schedule: scheduleFromForm(form),
        safety: form.safety,
      };
      const res = await fetch(form.id ? `/api/schedules/${form.id}` : "/api/schedules", {
        method: form.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error || "保存失败");
      toast(form.id ? "已保存" : "已创建");
      setForm(null);
      await load();
    } catch (error) {
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
          subtitle="按规则自动跑的任务 · 无人值守，危险操作进「等你处理」"
          actions={
            <>
              <button onClick={() => void load()} className="btn btn-sm btn-ghost" title="刷新">
                <RefreshCw size={12} />
                刷新
              </button>
              <button
                onClick={() => {
                  setFormErrorText(null);
                  setForm(emptyForm(defaultCwd));
                }}
                className="btn btn-sm btn-primary"
              >
                <Plus size={12} />
                新建节律
              </button>
            </>
          }
        />

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
                <TriggerEditor form={form} onChange={(patch) => setForm({ ...form, ...patch })} />
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-[12px] text-dim">安全档</span>
                <div className="flex w-fit items-center rounded-lg border border-line bg-panel-2 p-0.5">
                  {SAFETY_VALUES.map((tier) => (
                    <button
                      key={tier}
                      type="button"
                      aria-pressed={form.safety === tier}
                      onClick={() => setForm({ ...form, safety: tier })}
                      className={cn(
                        "h-7 cursor-pointer rounded-md px-2.5 text-[12px] t-fast",
                        form.safety === tier
                          ? tier === "full"
                            ? "bg-warn/10 font-medium text-warn"
                            : "bg-active font-medium text-accent"
                          : "text-muted hover:text-fg",
                      )}
                    >
                      {SAFETY_TIER_META[tier].label}
                    </button>
                  ))}
                </div>
                <div className="text-[11px] text-dim">{SAFETY_TIER_META[form.safety].hint}</div>
              </div>

              <label className="flex flex-col gap-1.5">
                <span className="text-[12px] text-dim">任务内容（每轮发给 agent 的 prompt）</span>
                <textarea
                  value={form.prompt}
                  onChange={(e) => setForm({ ...form, prompt: e.target.value })}
                  rows={4}
                  placeholder="如：汇总今天在仓库里的改动，写进 worklog。"
                  className="w-full resize-y rounded-lg border border-line bg-panel-2 px-2.5 py-2 text-[12px] leading-relaxed text-fg outline-none t-fast placeholder:text-dim focus:border-accent/60"
                />
              </label>

              <div className="flex flex-col gap-1.5">
                <span className="text-[12px] text-dim">工作目录</span>
                <div className="flex items-center gap-2">
                  <input
                    value={form.cwd}
                    onChange={(e) => setForm({ ...form, cwd: e.target.value })}
                    placeholder="/path/to/workspace"
                    spellCheck={false}
                    className={cn(inputCls, "min-w-0 flex-1 font-mono")}
                  />
                  <button type="button" onClick={() => setDirPickerOpen(true)} className="btn btn-sm btn-ghost shrink-0">
                    <FolderOpen size={12} />
                    浏览
                  </button>
                </div>
              </div>

              <div className="text-[11px] text-dim">
                模型：沿用系统默认（ModelPicker 需要会话上下文，暂不能嵌入本表单）。
              </div>

              {formErrorText && (
                <div className="flex items-center gap-1.5 text-[12px] text-danger">
                  <AlertCircle size={12} />
                  {formErrorText}
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
        ) : sorted.length === 0 ? (
          <Card>
            <EmptyState
              icon={<CalendarClock size={20} />}
              title="还没有节律任务"
              hint="建一条：选好触发规则与要跑的内容，到点工作台会自己开一条无头会话来跑。"
              action={
                <button
                  onClick={() => setForm(emptyForm(defaultCwd))}
                  className="btn btn-primary"
                >
                  <Plus size={12} />
                  新建第一条
                </button>
              }
            />
          </Card>
        ) : (
          <div className="flex flex-col gap-3">
            {sorted.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                busy={busyId === task.id}
                expanded={expanded.has(task.id)}
                usage={usage}
                onToggleExpand={() => toggleExpand(task.id)}
                onToggleEnabled={(next) => void patchTask(task, { enabled: next }, next ? "已启用" : "已暂停")}
                onRun={() => void runNow(task)}
                onEdit={() => {
                  setFormErrorText(null);
                  setForm(formFromTask(task));
                }}
                onDelete={() => void removeTask(task)}
                onOpenSession={onOpenSession}
              />
            ))}
          </div>
        )}
      </div>

      <DirPicker
        open={dirPickerOpen}
        onClose={() => setDirPickerOpen(false)}
        onPick={(path) => {
          setForm((prev) => (prev ? { ...prev, cwd: path } : prev));
          setDirPickerOpen(false);
        }}
        defaultCwd={form?.cwd || defaultCwd}
      />
    </div>
  );
}

// ============================================================================
// 单条任务
// ============================================================================

function TaskCard({
  task,
  busy,
  expanded,
  usage,
  onToggleExpand,
  onToggleEnabled,
  onRun,
  onEdit,
  onDelete,
  onOpenSession,
}: {
  task: ScheduleDto;
  busy: boolean;
  expanded: boolean;
  usage: Record<string, UsageSession> | null;
  onToggleExpand: () => void;
  onToggleEnabled: (next: boolean) => void;
  onRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const history = task.runHistory ?? [];
  return (
    <Card className={cn(task.running && "border-accent/40")}>
      <div className="flex items-start gap-3 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={onToggleExpand}
              aria-label={expanded ? "收起运行历史" : "展开运行历史"}
              className="flex cursor-pointer items-center gap-1 text-left"
            >
              {expanded ? (
                <ChevronDown size={14} className="shrink-0 text-dim" />
              ) : (
                <ChevronRight size={14} className="shrink-0 text-dim" />
              )}
              <span className="text-[13px] font-semibold text-fg">{task.name}</span>
            </button>
            {!task.enabled && <span className="chip">已暂停</span>}
            <SafetyChip safety={task.safety} />
            {resultChip(task.lastRun, task.running)}
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-5 text-[12px] text-muted">
            <span className="flex items-center gap-1">
              <CalendarClock size={12} className="text-dim" />
              {describeSchedule(task.schedule)}
            </span>
            {task.enabled && task.nextRunAt && (
              <span title={absTime(task.nextRunAt)}>下次 {relFuture(task.nextRunAt)}</span>
            )}
            <span className="truncate" title={task.cwd}>
              {basename(task.cwd) || task.cwd}
            </span>
            {task.lastRun?.note && <span className="truncate text-dim">· {task.lastRun.note}</span>}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {task.running && task.runningSessionId && (
            <button onClick={() => onOpenSession(task.runningSessionId!)} className="btn btn-sm btn-ghost">
              <Play size={12} />
              打开会话
            </button>
          )}
          <Toggle on={task.enabled} onChange={onToggleEnabled} disabled={busy} />
          <button onClick={onRun} disabled={busy || task.running} className="btn btn-sm btn-ghost">
            {busy ? <Loader2 size={12} className="anim-spin" /> : <Play size={12} />}
            立即运行
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

      {expanded && <RunHistory history={history} usage={usage} onOpenSession={onOpenSession} />}
    </Card>
  );
}

function RunHistory({
  history,
  usage,
  onOpenSession,
}: {
  history: RunEntry[];
  usage: Record<string, UsageSession> | null;
  onOpenSession: (sessionId: string) => void;
}) {
  return (
    <div className="border-t border-line-soft bg-panel-2/40 px-4 py-3">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] text-dim">
        <History size={12} />
        运行历史（最近 ≤20 条）
      </div>
      {history.length === 0 ? (
        <div className="text-[12px] text-dim">还没有运行记录。</div>
      ) : (
        <div className="flex flex-col">
          {history.map((run, i) => {
            const u = run.sessionId ? usage?.[run.sessionId] : undefined;
            const meta = RESULT_META[run.result] ?? RESULT_META.skipped;
            return (
              <div
                key={`${run.at}-${i}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line-soft py-1.5 text-[12px] last:border-b-0"
              >
                <span className="w-36 shrink-0 tabular-nums text-muted" title={absTime(run.at)}>
                  {absTime(run.at)}
                </span>
                <span className={cn("chip", meta.cls)}>{meta.label}</span>
                {run.durationMs !== undefined && (
                  <span className="tabular-nums text-dim" title="本轮运行时长">
                    {formatDuration(run.durationMs)}
                  </span>
                )}
                {run.note && <span className="min-w-0 flex-1 truncate text-dim">{run.note}</span>}
                {u && (
                  <span className="tabular-nums text-dim">
                    {formatTokens(u.tokens.total)} tok · {formatCost(u.cost)}
                  </span>
                )}
                {run.sessionId ? (
                  <button onClick={() => onOpenSession(run.sessionId)} className="btn btn-sm btn-subtle ml-auto">
                    打开会话
                  </button>
                ) : (
                  <span className="ml-auto text-dim">无会话</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
