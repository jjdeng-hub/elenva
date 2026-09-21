"use client";

import { AlertTriangle, Loader2, RefreshCw, Shrink, Square, Terminal, X } from "lucide-react";
import { useState } from "react";
import { cn } from "@/components/lib/utils";
import { formatTokens } from "@/lib/format";

/**
 * Agent 过程态状态条 —— 常驻输入框上方，承载「正在发生但看不见」的内核事件。
 *
 * 为什么需要它：这些状态早已由内核经 SSE 推给 hook，但此前没有任何组件渲染，
 * 于是模型重试、上下文压缩、shell 执行全部静默——用户只看到「等待模型…」卡住。
 * 产品定位是「看清 agent 在干什么」，这些恰恰是最该被看见的。
 *
 * 语义：info=进行中 · warn=可自愈的异常 · danger=需用户处理 · success=刚完成
 */

type Tone = "info" | "warn" | "danger" | "success";

const TONE_CLS: Record<Tone, string> = {
  info: "border-line bg-panel-2 text-muted",
  warn: "border-warn/30 bg-warn/10 text-warn",
  danger: "border-danger/30 bg-danger/10 text-danger",
  success: "border-success/30 bg-success/10 text-success",
};

const COMPACT_REASON: Record<string, string> = {
  manual: "手动压缩",
  threshold: "接近上限",
  overflow: "超出上限",
  auto: "自动压缩",
};

export type AgentRetryInfo = {
  attempt: number;
  maxAttempts: number;
  errorMessage?: string;
};

export type AgentCompactResult = {
  reason: string;
  tokensBefore: number;
  estimatedTokensAfter: number;
};

function Row({
  tone,
  icon,
  children,
  onClose,
  closeLabel,
}: {
  tone: Tone;
  icon: React.ReactNode;
  children: React.ReactNode;
  onClose?: () => void;
  closeLabel?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[12px] t-fast",
        TONE_CLS[tone],
      )}
    >
      <span className="flex shrink-0 items-center">{icon}</span>
      <span className="min-w-0 flex-1 break-words">{children}</span>
      {onClose && (
        <button
          onClick={onClose}
          title={closeLabel ?? "忽略"}
          aria-label={closeLabel ?? "忽略"}
          className="shrink-0 cursor-pointer opacity-70 t-fast hover:opacity-100"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}

export function AgentStatusBar({
  retry,
  bashCommand,
  compacting,
  compactResult,
  compactError,
  modelError,
  modelScopeWarnings,
  onAbort,
}: {
  /** 自动重试进行中（内核瞬时错误自愈） */
  retry: AgentRetryInfo | null;
  /** 正在执行的 shell 命令（`!命令`，非 agent 内部的 bash 工具） */
  bashCommand: string | null;
  /** 上下文压缩进行中 */
  compacting: boolean;
  /** 上一次压缩的结果（自动/手动） */
  compactResult: AgentCompactResult | null;
  /** 上次压缩失败原因 */
  compactError: string | null;
  /** 模型库加载失败 */
  modelError: string | null;
  /** enabledModels 范围告警 */
  modelScopeWarnings: string[];
  /** 中止当前进行中的动作（压缩 / shell 命令） */
  onAbort?: () => void;
}) {
  /* 这三类是「一次性事件」，给出后由用户决定何时收起；
     以内容本身为键，新事件到来时自动重新出现。 */
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const hide = (key: string) => setHidden((prev) => new Set(prev).add(key));
  const seen = (key: string) => hidden.has(key);

  const resultKey = compactResult ? JSON.stringify(compactResult) : "";
  const scopeKey = modelScopeWarnings.join("\u0000");

  const rows: React.ReactNode[] = [];

  if (retry) {
    rows.push(
      <Row
        key="retry"
        tone="warn"
        icon={<RefreshCw size={12} className="anim-spin" />}
      >
        <b className="font-semibold">自动重试 {retry.attempt}/{retry.maxAttempts}</b>
        <span className="text-warn/80"> · 内核遇到瞬时错误，正在重试</span>
        {retry.errorMessage && (
          <span className="ml-1 font-mono text-[11px] opacity-80">（{retry.errorMessage}）</span>
        )}
      </Row>,
    );
  }

  if (bashCommand) {
    rows.push(
      <Row
        key="bash"
        tone="info"
        icon={<Terminal size={12} className="anim-pulse-dot" />}
      >
        <span>正在执行 </span>
        <code className="font-mono text-fg">{bashCommand}</code>
        {onAbort && (
          <button onClick={onAbort} className="ml-2 inline-flex cursor-pointer items-center gap-1 text-danger t-fast hover:underline">
            <Square size={10} /> 中止
          </button>
        )}
      </Row>,
    );
  }

  if (compacting) {
    rows.push(
      <Row key="compacting" tone="info" icon={<Loader2 size={12} className="anim-spin" />}>
        <span>正在压缩上下文…</span>
        {onAbort && (
          <button onClick={onAbort} className="ml-2 cursor-pointer text-danger t-fast hover:underline">
            中止压缩
          </button>
        )}
      </Row>,
    );
  }

  if (compactError && !seen(`compact-error:${compactError}`)) {
    rows.push(
      <Row
        key="compact-error"
        tone="danger"
        icon={<AlertTriangle size={12} />}
        onClose={() => hide(`compact-error:${compactError}`)}
      >
        上下文压缩失败：{compactError}
      </Row>,
    );
  }

  if (compactResult && !seen(`compact:${resultKey}`) && !compacting) {
    const saved = compactResult.tokensBefore - compactResult.estimatedTokensAfter;
    const pct = compactResult.tokensBefore > 0 ? Math.round((saved / compactResult.tokensBefore) * 100) : 0;
    rows.push(
      <Row
        key="compact-result"
        tone="success"
        icon={<Shrink size={12} />}
        onClose={() => hide(`compact:${resultKey}`)}
      >
        {COMPACT_REASON[compactResult.reason] ?? "上下文压缩"}完成：
        <span className="tabular-nums">
          {formatTokens(compactResult.tokensBefore)} → {formatTokens(compactResult.estimatedTokensAfter)}
        </span>
        {pct > 0 && <span className="tabular-nums"> （-{pct}%）</span>}
      </Row>,
    );
  }

  if (modelError && !seen("model-error")) {
    rows.push(
      <Row key="model-error" tone="danger" icon={<AlertTriangle size={12} />} onClose={() => hide("model-error")}>
        模型库加载失败：{modelError} · 可在「模型」页检查厂商密钥
      </Row>,
    );
  }

  if (modelScopeWarnings.length > 0 && !seen("scope-warn")) {
    rows.push(
      <Row key="scope-warn" tone="warn" icon={<AlertTriangle size={12} />} onClose={() => hide("scope-warn")}>
        模型范围（enabledModels）告警：{modelScopeWarnings.join("；")}
      </Row>,
    );
  }

  if (rows.length === 0) return null;

  return (
    <div className="pb-1.5" data-testid="agent-status-bar">
      <div className="chat-col flex flex-col gap-1.5">{rows}</div>
    </div>
  );
}
