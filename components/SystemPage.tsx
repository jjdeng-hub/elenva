"use client";

import { Archive, Gauge, GitCommitHorizontal, Layers, RefreshCw, Server, ShieldCheck } from "lucide-react";
import { Card as UICard, CardHeader, CardTitle } from "@/components/ui/card";
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils";
import { PageHeader, Skeleton } from "@/components/ui/bits";
import { toast } from "@/components/ui/dialog";
import { formatSize, relTime, timeLabel } from "@/lib/format";
import type { SystemStatus } from "@/lib/system-status";

/* ---------------- 小组件 ---------------- */

function Card({
  icon,
  title,
  chip,
  hint,
  children,
}: {
  icon: ReactNode;
  title: string;
  chip?: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <UICard>
      <CardHeader>
        <span className="text-accent">{icon}</span>
        <CardTitle>{title}</CardTitle>
        {chip && <span className="ml-auto flex items-center gap-1 text-[11px]">{chip}</span>}
      </CardHeader>
      <div className="flex flex-col gap-1.5 px-4 py-3 text-[12px]">{children}</div>
      {hint && <div className="border-t border-line-soft px-4 py-2 text-[11px] leading-relaxed text-dim">{hint}</div>}
    </UICard>
  );
}

function Row({ label, mono, title, children }: { label: string; mono?: boolean; title?: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-dim">{label}</span>
      <span
        className={cn("min-w-0 truncate text-right tabular-nums text-fg", mono && "font-mono text-[11px]")}
        title={title}
      >
        {children}
      </span>
    </div>
  );
}

function Meter({ percent, danger }: { percent: number; danger: boolean }) {
  const pct = Math.min(100, Math.max(0, percent));
  return (
    <div className="mt-1 h-1 overflow-hidden rounded-full bg-panel-2">
      <div
        className={cn("h-full rounded-full", danger ? "bg-danger" : pct >= 80 ? "bg-warn" : "bg-viz-4")}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function pct(used: number, total: number): number {
  return total > 0 ? Math.round((used / total) * 100) : 0;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分钟`;
}

const okDot = <span className="inline-block size-1.5 rounded-full bg-success align-middle" />;

/* ---------------- 页面 ---------------- */

/**
 * 系统页：本机「发动机舱」的只读快照 —— 服务 / 门禁 / 备份 / 版本 / 部署 / 资源。
 * 同时服务两个视角：作者 一眼看系统健康；维护者不再只靠终端。
 * 只读设计：不触发任何维护动作（跑门禁/备份/更新都走 cron 或终端，避免页面变成万能开关）。
 */
export function SystemPage() {
  const [data, setData] = useState<SystemStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [port, setPort] = useState("");

  useEffect(() => {
    setPort(window.location.port);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/system", { cache: "no-store" });
      const payload = (await res.json()) as SystemStatus & { error?: string };
      if (!res.ok) throw new Error(payload.error || `读取失败（HTTP ${res.status}）`);
      setData(payload);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      toast(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const v = data?.versions;
  const versionChip = v
    ? v.aligned === true
      ? <span className="text-success">{okDot} 三处一致</span>
      : v.aligned === false
        ? <span className="text-warn">存在差异</span>
        : <span className="text-dim">信息不全</span>
    : null;

  const gates = data?.gates;
  const gatesChip = gates
    ? gates.lastResult === "ok"
      ? <span className="text-success">{okDot} 通过</span>
      : gates.lastResult === "fail"
        ? <span className="text-danger">失败</span>
        : <span className="text-dim">未记录</span>
    : <span className="text-dim">未跑过</span>;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="page-col py-6">
        <PageHeader
          icon={<Server size={16} />}
          title="系统"
          subtitle="服务 / 门禁 / 备份 / 版本 / 部署 / 资源 —— 本机只读快照"
          actions={
            <button onClick={() => void load()} disabled={loading} className="btn btn-ghost">
              <RefreshCw size={12} className={loading ? "anim-spin" : undefined} /> 刷新
            </button>
          }
        />

        {!data && !error && (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-40 rounded-card" />
            ))}
          </div>
        )}

        {!data && error && (
          <UICard className="px-4 py-10 text-center text-[12px] text-warn">
            读取失败：{error}
          </UICard>
        )}

        {data && (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {/* 服务 */}
            <Card icon={<Server size={14} />} title="服务" chip={<span className="text-success">{okDot} 运行中</span>}>
              <Row label="版本">{data.service.appVersion ?? "—"}</Row>
              <Row label="运行时长">{formatUptime(data.service.uptimeSeconds)}</Row>
              <Row label="Node" mono>{data.service.node}</Row>
              <Row label="端口" mono>{port || "—"}</Row>
            </Card>

            {/* 版本对齐 */}
            <Card
              icon={<Layers size={14} />}
              title="版本对齐"
              chip={versionChip}
              hint="网页内核 = 本仓库 node_modules 里的 SDK；全局 CLI = npm -g 的 pi 命令；手册记录 = docs/pi-upgrade.md。"
            >
              <Row label="网页内核" mono>{v?.webKernel ?? "—"}</Row>
              <Row label="全局 CLI" mono>{v?.globalCli ?? "—"}</Row>
              <Row label="手册记录" mono>
                {v?.docWebKernel || v?.docCli ? `网页 ${v?.docWebKernel ?? "—"} · CLI ${v?.docCli ?? "—"}` : "—"}
              </Row>
            </Card>

            {/* 门禁 */}
            <Card
              icon={<ShieldCheck size={14} />}
              title="门禁（三道门）"
              chip={gatesChip}
              hint="tsc / 用法面探针 / 样式收敛 —— Hermes cron 每天 09:15 在 main 有变更时自动跑；失败才告警。"
            >
              <Row label="最近检查" title={gates?.when ?? undefined}>
                {gates?.when ? `${relTime(gates.when)} · ${timeLabel(gates.when)}` : "—"}
              </Row>
              <Row label="main 提交" mono>{gates?.lastChecked ? gates.lastChecked.slice(0, 7) : "—"}</Row>
            </Card>

            {/* 备份 */}
            <Card icon={<Archive size={14} />} title="备份" hint="每周日 18:00 自动快照 · 轮转保留 4 份（含凭证，仅存本机）。">
              <Row label="最近快照" title={data.backup.latest?.name ?? undefined}>
                {data.backup.latest
                  ? `${relTime(data.backup.latest.mtime)} · ${formatSize(data.backup.latest.size)}`
                  : "—"}
              </Row>
              <Row label="保留">
                {data.backup.count > 0 ? `${data.backup.count} 份 · 共 ${formatSize(data.backup.totalBytes)}` : "—"}
              </Row>
            </Card>

            {/* 部署 */}
            <Card icon={<GitCommitHorizontal size={14} />} title="部署" hint="生产 = main 最新构建；更新走 部署脚本。">
              <Row label="提交" mono title={data.deploy.commitSubject ?? undefined}>{data.deploy.commit ?? "—"}</Row>
              <Row label="提交时间">{data.deploy.commitTime ? relTime(data.deploy.commitTime) : "—"}</Row>
              <Row label="最近构建">{data.deploy.buildTime ? relTime(data.deploy.buildTime) : "—"}</Row>
              <Row label="仓库" mono title={data.deploy.repo}>{data.deploy.repo}</Row>
            </Card>

            {/* 资源 */}
            <Card icon={<Gauge size={14} />} title="资源">
              <div>
                <Row label="磁盘" title={`剩余 ${formatSize(data.resources.disk.avail)}`}>
                  {`${formatSize(data.resources.disk.used)} / ${formatSize(data.resources.disk.total)} · ${pct(data.resources.disk.used, data.resources.disk.total)}%`}
                </Row>
                <Meter
                  percent={pct(data.resources.disk.used, data.resources.disk.total)}
                  danger={pct(data.resources.disk.used, data.resources.disk.total) >= 90}
                />
              </div>
              <div>
                <Row label="内存">
                  {`${formatSize(data.resources.mem.total - data.resources.mem.free)} / ${formatSize(data.resources.mem.total)} · ${pct(data.resources.mem.total - data.resources.mem.free, data.resources.mem.total)}%`}
                </Row>
                <Meter
                  percent={pct(data.resources.mem.total - data.resources.mem.free, data.resources.mem.total)}
                  danger={pct(data.resources.mem.total - data.resources.mem.free, data.resources.mem.total) >= 90}
                />
              </div>
              <Row label="负载（1/5/15 分）" mono>{data.resources.load.join(" / ")}</Row>
              <Row label="CPU" mono>{data.resources.cpuCount} 核</Row>
            </Card>
          </div>
        )}

        <div className="mt-3 text-[11px] text-dim">
          本页只读：每次打开 / 点「刷新」时从本机服务端读取；不会触发任何维护动作。
        </div>
      </div>
    </div>
  );
}
