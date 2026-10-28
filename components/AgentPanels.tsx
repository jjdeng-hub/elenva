"use client";

import { useEffect, useState } from "react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { panelHasData, type AgentPanel, type PanelData, type PanelItem } from "@/lib/agents/panels";

type PanelWithData = { panel: AgentPanel; data: PanelData; error?: string };

/**
 * 声明式面板渲染器：五种类型，一套代码。
 *
 * 这是「N 个 Agent 不等于 N 套 UI」的落点 —— Agent 只在 manifest 里声明
 * 「哪个文件、用哪种类型展示」，不为每个 Agent 写前端。
 */
export function AgentPanels({ agentId }: { agentId: string }) {
  const [panels, setPanels] = useState<PanelWithData[] | null>(null);

  useEffect(() => {
    let alive = true;
    setPanels(null);
    fetch(`/api/agents/panels?id=${encodeURIComponent(agentId)}`, { cache: "no-store" })
      .then((res) => res.json())
      .then((data: { panels?: PanelWithData[] }) => {
        if (alive) setPanels(Array.isArray(data.panels) ? data.panels : []);
      })
      .catch(() => {
        if (alive) setPanels([]);
      });
    return () => {
      alive = false;
    };
  }, [agentId]);

  if (panels === null) {
    return <div className="mt-6 text-[12px] text-dim">加载面板…</div>;
  }
  if (panels.length === 0) {
    return (
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>面板</CardTitle>
        </CardHeader>
        <div className="px-4 py-3 text-[12px] text-dim">该 Agent 还没有声明面板。</div>
      </Card>
    );
  }

  return (
    <div className="mt-6 flex flex-col gap-4">
      {panels.map(({ panel, data, error }) => (
        <Card key={panel.id} data-testid={`agent-panel-${panel.id}`}>
          <CardHeader>
            <CardTitle>{panel.title}</CardTitle>
            <span className="ml-auto text-[10px] text-dim/70">{panel.type}</span>
          </CardHeader>
          <div className="px-4 py-3">
            {panelHasData(panel.type, data) ? (
              <PanelBody type={panel.type} data={data} />
            ) : (
              <div className="text-[12px] text-dim">
                暂无数据
                {panel.source && <span className="text-dim/70">（{panel.source}）</span>}
                {error && <span className="ml-2 text-dim/70">{error}</span>}
              </div>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}

function PanelBody({ type, data }: { type: AgentPanel["type"]; data: PanelData }) {
  if (type === "table") return <PanelTable data={data} />;
  const items = data.items ?? [];
  if (type === "timeline") return <PanelTimeline items={items} />;
  if (type === "gallery") return <PanelGallery items={items} />;
  if (type === "queue") return <PanelList items={items} showStatus />;
  return <PanelList items={items} />;
}

function PanelTable({ data }: { data: PanelData }) {
  const rows = data.rows ?? [];
  const columns = data.columns?.length ? data.columns : rows[0]?.map((_, index) => `列 ${index + 1}`) ?? [];
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[12px]">
        {columns.length > 0 && (
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  key={column}
                  className="border-b border-line px-3 py-1.5 text-left font-medium text-dim"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="border-b border-line-soft px-3 py-1.5 text-fg">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PanelTimeline({ items }: { items: PanelItem[] }) {
  return (
    <ol className="flex flex-col gap-2">
      {items.map((item, index) => (
        <li key={index} className="flex gap-3 text-[12px]">
          <span className="w-20 shrink-0 text-dim">{item.date ?? "—"}</span>
          <span className="min-w-0 flex-1">
            <span className="text-fg">{item.title}</span>
            {item.detail && <span className="ml-2 text-dim">{item.detail}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

function PanelGallery({ items }: { items: PanelItem[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {items.map((item, index) => (
        <figure key={index} className="min-w-0">
          {item.src && /^https?:\/\//i.test(item.src) ? (
            // 远程直链；本地文件等 P1 接上文件访问再加
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

function PanelList({ items, showStatus }: { items: PanelItem[]; showStatus?: boolean }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((item, index) => (
        <li key={index} className="flex items-baseline gap-2 text-[12px]">
          {showStatus && item.status && (
            <span className="shrink-0 rounded-sm border border-line px-1 text-[10px] text-dim">
              {item.status}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-fg">{item.title}</span>
          {item.meta && <span className="shrink-0 text-[11px] text-dim">{item.meta}</span>}
        </li>
      ))}
    </ul>
  );
}
