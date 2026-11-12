"use client";

import { useCallback, useMemo, useState } from "react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/components/lib/utils";
import type { PanelData, PanelItem } from "@/lib/agents/panels";
import { isDocBlock, type AgentBlock } from "@/lib/agents/workspace";
import { AgentDocEditor } from "@/components/agent-doc-editor";
import type { BlockPayload } from "@/lib/agents/workspace";

/**
 * 平台提供的元件库 —— Agent 只声明「用哪种、读哪个文件」，这里负责渲染与交互。
 *
 * 三条约束（也是与「每个 Agent 自己写前端」的分界）：
 * 1. 元件是公有的、随仓库分发的；应用包（私有）不带任何前端代码；
 * 2. 只有 manifest 声明了 `schema` + `editable` 的块才可写 —— 界面上没有「随便改」的口子；
 * 3. 写回一律带 `revision`，撞车时让人刷新而不是覆盖掉 Agent 刚写的内容。
 */

export type { BlockPayload } from "@/lib/agents/workspace";

type SaveState = { kind: "idle" } | { kind: "dirty" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

export function AgentBlockCard({
  agentId,
  block,
  onAction,
  wide,
}: {
  agentId: string;
  block: BlockPayload;
  onAction: (blockId: string, actionId: string, context: Record<string, unknown>) => Promise<string | null>;
  /** 铺满一行：表格/正文天然要宽，卡片条与时间线也建议铺满（由调用方按视图排布决定） */
  wide?: boolean;
}) {
  const editable = block.editable ?? [];
  const canWrite = Boolean(block.schema) && editable.length > 0;
  const fullWidth = wide ?? (block.type === "table" || isDocBlock({ type: block.type } as AgentBlock));

  // 卡头右侧的一行元信息：只放「能让人决定要不要展开」的数字，不放条目总数
  const headerMeta = (() => {
    if (block.type === "table") return `${block.data?.rows?.length ?? 0} 条`;
    if (block.type === "queue") {
      const waiting = (block.data?.items ?? []).filter((item) => (item.status ?? "").includes("等")).length;
      return waiting > 0 ? `${waiting} 待你` : undefined;
    }
    if (isDocBlock({ type: block.type } as AgentBlock)) return `${block.files?.length ?? 0} 篇`;
    return undefined;
  })();

  return (
    <Card
      data-testid={`agent-block-${block.id}`}
      className={cn("min-w-0", fullWidth && "md:col-span-2")}
    >
      <CardHeader>
        <CardTitle>{block.title}</CardTitle>
        {headerMeta && (
          <span className="ml-auto shrink-0 text-[11px] tabular-nums text-dim">{headerMeta}</span>
        )}
      </CardHeader>
      <div className="@container px-4 py-3">
        {block.error ? (
          <div className="text-[12px] text-dim">{block.error}</div>
        ) : isDocBlock({ type: block.type } as AgentBlock) ? (
          <AgentDocEditor agentId={agentId} block={block} />
        ) : block.type === "table" ? (
          <TableBlock agentId={agentId} block={block} canWrite={canWrite} editable={editable} onAction={onAction} />
        ) : (
          <ListBlock block={block} onAction={onAction} />
        )}
      </div>
    </Card>
  );
}

/* ---------------- 只读列表（cards / queue / timeline / gallery） ---------------- */

function ListBlock({
  block,
  onAction,
}: {
  block: BlockPayload;
  onAction: (blockId: string, actionId: string, context: Record<string, unknown>) => Promise<string | null>;
}) {
  const items = block.data?.items ?? [];
  if (items.length === 0) return <EmptyState block={block} />;

  if (block.type === "gallery") return <GalleryItems items={items} />;
  if (block.type === "timeline") return <TimelineItems items={items} />;
  if (block.type === "cards") return <CardsItems items={items} />;
  return <QueueItems items={items} block={block} onAction={onAction} />;
}

/**
 * 空状态：由应用包自己说话。
 *
 * 「暂无数据」是平台的默认嗓子，每个 Agent 该有自己的一句——没有训练记录时说「练完报一句」，
 * 没有待办时说「想到什么直接说」。这句话写在 manifest 的 `emptyHint` 里，平台只负责留位置。
 * 没写时才退回中性文案，并把 source 收进 title（排错要看，但不该在正文里吵人）。
 */
function EmptyState({ block }: { block: BlockPayload }) {
  return (
    <div className="flex items-start gap-2 py-0.5">
      <span className="mt-2 size-1 shrink-0 rounded-full bg-line" />
      <p className="min-w-0 text-[12px] leading-5 text-dim" title={block.source ? `source: ${block.source}` : undefined}>
        {block.emptyHint ?? "暂无数据"}
      </p>
    </div>
  );
}

/**
 * cards：四条以内的「现在」用统计砖，不是列表。
 *
 * 与 queue 的区别只在密度：queue 是一行一件事（要扫），cards 是一格一个数（要看一眼）。
 * 值短（≤12 字）走 18px 大字，值长（一句话/待办描述）自动降到 12px —— 同一个块既能放
 * 「0 / 3」也能放「08-06 · 肩」，不靠调用方约定。
 */
function CardsItems({ items }: { items: PanelItem[] }) {
  // 第一格横跨两列，其余各占一格 —— 总列数 = 条目数 + 1，这样一行就能排满，不会剩半行空白
  const columns = items.length + 1;
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-2",
        columns === 3 && "@min-[420px]:grid-cols-3",
        columns === 4 && "@min-[520px]:grid-cols-4",
        columns >= 5 && "@min-[620px]:grid-cols-5",
      )}
    >
      {items.map((item, index) => {
        const value = item.meta ?? "—";
        // 第一格是「现在最重要的那个数」：横跨两列，别的砖保持一格 —— 四块等宽等于没有主次
        const lead = index === 0 && items.length >= 3;
        const numeric = value.length <= 12;
        return (
          <div
            key={index}
            className={cn(
              "min-w-0 rounded-[8px] px-3 py-2",
              lead ? "col-span-2 bg-accent-soft/60" : "bg-panel-2/60",
            )}
          >
            <div className="truncate text-[11px] leading-4 text-dim" title={item.title}>
              {item.title}
            </div>
            <div
              className={cn(
                "mt-1",
                numeric
                  ? "truncate text-[18px] font-semibold leading-6 tabular-nums"
                  : "line-clamp-2 text-[13px] font-semibold leading-5",
                lead && numeric && "text-[20px]",
              )}
              title={value}
            >
              {value}
            </div>
            {item.detail && (
              <div className="mt-0.5 truncate text-[11px] leading-4 text-dim/80" title={item.detail}>
                {item.detail}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function GalleryItems({ items }: { items: PanelItem[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {items.map((item, index) => (
        <figure key={index} className="min-w-0">
          {item.src && /^https?:\/\//i.test(item.src) ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={item.src} alt={item.title} className="h-28 w-full rounded-lg border border-line object-cover" />
          ) : (
            <div className="flex h-28 w-full items-center justify-center rounded-lg border border-line bg-panel-2 text-[11px] text-dim">
              无预览
            </div>
          )}
          <figcaption className="mt-1 truncate text-[11px] text-dim">{item.title}</figcaption>
        </figure>
      ))}
    </div>
  );
}

/**
 * 时间线的日期：今天 / 昨天 / M-D。
 *
 * 日期是时间线的骨架，不是背景字——所以「今天」这种东西要直接说出来，
 * 而今年之内一律省掉年份。同一天的条目向下分组，日期只在组首出现一次：
 * 一列「2026-11-11」重复三遍，读的人会以为那是三条不同的事。
 */
function dayLabel(raw?: string): string {
  if (!raw) return "—";
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!matched) return raw;
  const [year, month, day] = [Number(matched[1]), Number(matched[2]), Number(matched[3])];
  const that = new Date(year, month - 1, day);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today.getTime() - that.getTime()) / 86_400_000);
  if (diffDays === 0) return "今天";
  if (diffDays === 1) return "昨天";
  return year === today.getFullYear() ? `${matched[2]}-${matched[3]}` : raw;
}

function groupByDay(items: PanelItem[]): { label: string; items: PanelItem[] }[] {
  const groups: { label: string; items: PanelItem[] }[] = [];
  for (const item of items) {
    const label = dayLabel(item.date);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

function TimelineItems({ items }: { items: PanelItem[] }) {
  const groups = groupByDay(items);
  return (
    <div className="flex flex-col gap-3">
      {groups.map((group, groupIndex) => (
        <div key={`${group.label}-${groupIndex}`} className="flex gap-3">
          <span className="w-12 shrink-0 pt-0.5 text-right text-[11px] leading-4 tabular-nums text-dim">
            {group.label}
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            {group.items.map((item, index) => {
              const inGroupLast = index === group.items.length - 1;
              const newest = groupIndex === 0 && index === 0;
              return (
                <div key={index} className="flex gap-2">
                  <span className="flex w-1.5 shrink-0 flex-col items-center">
                    <span
                      className={cn(
                        "mt-1.5 size-1.5 shrink-0 rounded-full",
                        newest ? "bg-accent" : "bg-line",
                      )}
                    />
                    {!inGroupLast && <span className="mt-1 w-px flex-1 bg-line-soft" />}
                  </span>
                  <span className={cn("min-w-0 flex-1", inGroupLast ? "pb-0" : "pb-2.5")}>
                    <span className="block text-[12px] leading-4 text-fg">{item.title}</span>
                    {item.detail && (
                      <span className="mt-0.5 block text-[11px] leading-4 text-dim">{item.detail}</span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function QueueItems({
  items,
  block,
  onAction,
}: {
  items: PanelItem[];
  block: BlockPayload;
  onAction: (blockId: string, actionId: string, context: Record<string, unknown>) => Promise<string | null>;
}) {
  return (
    <ul className="flex flex-col">
      {items.map((item, index) => {
        // 「等你」是可操作的那一档，给它 accent；其余（我在做 / 已定 / 搁置）退到中性
        const waiting = item.status?.includes("等") ?? false;
        return (
          <li
            key={index}
            className="group flex items-start gap-2 rounded-[6px] px-1.5 py-1.5 text-[12px] t-fast hover:bg-hover"
          >
            {item.status && (
              <span
                className={cn(
                  "mt-0.5 shrink-0 rounded-sm border px-1 text-[10px] leading-4",
                  waiting ? "border-accent/30 text-accent" : "border-line text-dim",
                )}
              >
                {item.status}
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-fg" title={item.title}>
                {item.title}
              </span>
              {item.detail && (
                <span className="mt-0.5 line-clamp-2 block text-[11px] leading-4 text-dim" title={item.detail}>
                  {item.detail}
                </span>
              )}
            </span>
            {item.meta && (
              <span className="w-12 shrink-0 pt-0.5 text-right text-[11px] text-dim">{item.meta}</span>
            )}
            <span className="shrink-0 pt-0.5">
              <BlockActions block={block} context={itemContext(item)} onAction={onAction} compact />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/* ---------------- 表格（可选单元格编辑 + 行动作） ---------------- */

function TableBlock({
  agentId,
  block,
  canWrite,
  editable,
  onAction,
}: {
  agentId: string;
  block: BlockPayload;
  canWrite: boolean;
  editable: string[];
  onAction: (blockId: string, actionId: string, context: Record<string, unknown>) => Promise<string | null>;
}) {
  const columns = block.data?.columns ?? [];
  const [rows, setRows] = useState<string[][]>(block.data?.rows ?? []);
  const [revision, setRevision] = useState(block.revision ?? "");
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const editableIndexes = useMemo(
    () => columns.map((name, index) => (editable.includes(name) ? index : -1)).filter((index) => index >= 0),
    [columns, editable],
  );

  const save = useCallback(async () => {
    setState({ kind: "saving" });
    try {
      const res = await fetch("/api/agents/data", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: agentId,
          path: block.source,
          revision,
          content: JSON.stringify({ columns, rows }, null, 2),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { revision?: string; error?: string; details?: string[] };
      if (!res.ok) {
        setState({ kind: "error", message: data.details?.join("；") ?? data.error ?? `HTTP ${res.status}` });
        return;
      }
      setRevision(data.revision ?? revision);
      setState({ kind: "saved" });
    } catch (error) {
      setState({ kind: "error", message: String(error) });
    }
  }, [agentId, block.source, columns, revision, rows]);

  const setCell = (rowIndex: number, cellIndex: number, value: string) => {
    setRows((prev) => prev.map((row, i) => (i === rowIndex ? row.map((cell, j) => (j === cellIndex ? value : cell)) : row)));
    setState({ kind: "dirty" });
  };

  if (rows.length === 0) return <EmptyState block={block} />;

  // 数值列右对齐：重量 / 组次 / 体感 这类一眼要纵向比较的列，左对齐会让小数点参差
  const numericColumns = columns.map((name) => /重量|组|次|体感|rpe|数量|金额/i.test(name));

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr>
              {columns.map((column, columnIndex) => (
                <th
                  key={column}
                  className={cn(
                    "sticky top-0 z-10 whitespace-nowrap border-b border-line bg-panel px-3 py-1.5 font-medium text-dim",
                    numericColumns[columnIndex] ? "text-right" : "text-left",
                  )}
                >
                  {column}
                  {editable.includes(column) && <span className="ml-1 text-[10px] text-accent">可改</span>}
                </th>
              ))}
              {block.actions?.length ? <th className="sticky top-0 z-10 border-b border-line bg-panel px-3 py-1.5 text-left font-medium text-dim">操作</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="t-fast hover:bg-hover/50">
                {row.map((cell, cellIndex) => {
                  const isEditable = canWrite && editableIndexes.includes(cellIndex);
                  return (
                    <td
                      key={cellIndex}
                      className={cn(
                        "border-b border-line-soft px-3 py-1.5 text-fg",
                        // 短值不折行：日期、组次、重量这类一眼要横向扫的格子，折成两行就没法比了
                        cell.length <= 12 && "whitespace-nowrap",
                        numericColumns[cellIndex] && "text-right tabular-nums",
                      )}
                      title={cell.length > 24 ? cell : undefined}
                    >
                      {isEditable ? (
                        <input
                          value={cell}
                          aria-label={`${columns[cellIndex]} 第 ${rowIndex + 1} 行`}
                          onChange={(event) => setCell(rowIndex, cellIndex, event.target.value)}
                          className="w-24 rounded-sm border border-transparent bg-transparent px-1 py-0.5 text-[12px] text-fg outline-none t-fast hover:border-line focus:border-accent"
                        />
                      ) : (
                        cell
                      )}
                    </td>
                  );
                })}
                {block.actions?.length ? (
                  <td className="border-b border-line-soft px-3 py-1.5">
                    <BlockActions
                      block={block}
                      context={rowContext(columns, row)}
                      onAction={onAction}
                      compact
                    />
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canWrite && (
        <div className="flex items-center gap-2">
          <button type="button" className="btn btn-sm btn-primary" disabled={state.kind === "saving"} onClick={save}>
            {state.kind === "saving" ? "保存中…" : "保存"}
          </button>
          <span className={cn("text-[11px]", state.kind === "error" ? "text-danger" : "text-dim")}>
            {state.kind === "error"
              ? state.message
              : state.kind === "saved"
                ? "已写回文件（Agent 下次读到的就是这份）"
                : state.kind === "dirty"
                  ? "有未保存的改动"
                  : `可改字段：${editable.join(" / ")}`}
          </span>
        </div>
      )}
    </div>
  );
}

/* ---------------- 动作 ---------------- */

function BlockActions({
  block,
  context,
  onAction,
  compact,
}: {
  block: BlockPayload;
  context: Record<string, unknown>;
  onAction: (blockId: string, actionId: string, context: Record<string, unknown>) => Promise<string | null>;
  compact?: boolean;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const actions = block.actions ?? [];
  if (actions.length === 0) return null;

  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1",
        // 行内动作常驻但压低：只在 hover 才出现，等于对不悬停的人不存在（触屏、键盘、看截图）
        compact && "opacity-60 transition-opacity t-fast group-hover:opacity-100 focus-within:opacity-100",
      )}
    >
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          className="btn btn-sm btn-subtle"
          disabled={pending !== null}
          title={error ?? action.prompt}
          onClick={async () => {
            setPending(action.id);
            setError(null);
            const message = await onAction(block.id, action.id, context);
            setPending(null);
            if (message) setError(message);
          }}
        >
          {pending === action.id ? "已发送…" : action.label}
        </button>
      ))}
      {error && <span className="text-[10px] text-danger">{error}</span>}
    </span>
  );
}

function itemContext(item: PanelItem): Record<string, unknown> {
  return {
    title: item.title,
    meta: item.meta,
    status: item.status,
    detail: item.detail,
    date: item.date,
  };
}

/** 表格行 → 上下文：列名当键（小写），行号从 1 开始。 */
function rowContext(columns: string[], row: string[]): Record<string, unknown> {
  const context: Record<string, unknown> = {};
  columns.forEach((name, index) => {
    context[name.toLowerCase()] = row[index];
  });
  context.row = String(row.find((cell) => cell.trim()) ?? row.join(" "));
  return context;
}
