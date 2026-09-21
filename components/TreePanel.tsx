"use client";

import {
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  GitBranch,
  MessageSquare,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { cn } from "@/components/lib/utils";
import { Resizer, usePersistedWidth } from "@/components/ui/Resizer";
import type { AgentMessage, SessionEntry, SessionTreeNode } from "@/lib/types";

/** 从 entry 提取展示信息 */
function describeEntry(entry: SessionEntry): { kind: "user" | "assistant" | "info" | "tool"; text: string } {
  const e = entry as SessionEntry & Record<string, unknown>;
  switch (e.type) {
    case "message": {
      const msg = e.message as AgentMessage | undefined;
      if (!msg) return { kind: "info", text: "(空消息)" };
      if (msg.role === "user") {
        const c = msg.content;
        const text = typeof c === "string" ? c : c.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join(" ");
        return { kind: "user", text: text || "(图片)" };
      }
      if (msg.role === "assistant") {
        const c = "content" in msg ? msg.content : [];
        const text = Array.isArray(c)
          ? c.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join(" ")
          : String(c ?? "");
        const toolNames = Array.isArray(c)
          ? c.filter((b) => b.type === "toolCall").map((b) => (b as { name?: string }).name).filter(Boolean)
          : [];
        if (text) return { kind: "assistant", text };
        if (toolNames.length) return { kind: "tool", text: `调用 ${toolNames.join(", ")}` };
        return { kind: "assistant", text: "(空回复)" };
      }
      if (msg.role === "bashExecution") {
        return { kind: "tool", text: `$ ${msg.command}` };
      }
      if (msg.role === "toolResult") {
        return { kind: "tool", text: "工具结果" };
      }
      return { kind: "info", text: msg.role };
    }
    case "compaction":
      return { kind: "info", text: "压缩上下文" };
    case "branch_summary":
      return { kind: "info", text: "分支摘要" };
    case "model_change":
      return { kind: "info", text: `切换模型 ${e.provider}/${e.modelId}` };
    case "thinking_level_change":
      return { kind: "info", text: `思考强度 → ${String(e.level ?? "?")}` };
    case "custom_message":
      return { kind: "info", text: String(e.customType ?? "扩展消息") };
    case "label":
      return { kind: "info", text: `书签：${String(e.label ?? "")}` };
    default:
      return { kind: "info", text: String(e.type) };
  }
}

function truncate(s: string, n = 120): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

/** 计算从根到 activeLeafId 的路径节点集合 */
function buildActivePathSet(tree: SessionTreeNode[], activeLeafId: string | null): Set<string> {
  const path = new Set<string>();
  if (!activeLeafId) return path;
  const walk = (nodes: SessionTreeNode[], ancestors: SessionTreeNode[]): boolean => {
    for (const node of nodes) {
      if (node.entry.id === activeLeafId) {
        for (const a of ancestors) path.add(a.entry.id);
        path.add(node.entry.id);
        return true;
      }
      if (walk(node.children, [...ancestors, node])) return true;
    }
    return false;
  };
  walk(tree, []);
  return path;
}

function TreeRow({
  node,
  depth,
  activeLeafId,
  activePath,
  onNavigate,
}: {
  node: SessionTreeNode;
  depth: number;
  activeLeafId: string | null;
  activePath: Set<string>;
  onNavigate: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const { kind, text } = describeEntry(node.entry);
  const isLeaf = node.entry.id === activeLeafId;
  const onPath = activePath.has(node.entry.id);
  const hasChildren = node.children.length > 0;
  const branching = node.children.length > 1;

  const Icon =
    kind === "user" ? MessageSquare : kind === "tool" ? Wrench : kind === "info" ? Sparkles : Sparkles;

  return (
    <div>
      <div
        className={cn(
          "group flex cursor-pointer items-start gap-1.5 rounded-md py-1 pr-2 t-fast",
          isLeaf ? "bg-active" : onPath ? "hover:bg-hover" : "opacity-60 hover:opacity-100 hover:bg-hover",
        )}
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
        onClick={() => onNavigate(node.entry.id)}
      >
        <button
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
          className={cn(
            "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm text-dim",
            hasChildren ? "cursor-pointer hover:bg-active hover:text-fg" : "invisible",
          )}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <Icon
          size={12}
          className={cn(
            "mt-0.5 shrink-0",
            kind === "user" ? "text-accent" : kind === "tool" ? "text-muted" : "text-dim",
          )}
        />
        <span
          className={cn(
            "min-w-0 flex-1 text-[12px] leading-snug",
            kind === "user" ? "font-medium text-fg" : "text-muted",
          )}
        >
          {truncate(text, depth > 3 ? 60 : 120)}
          {node.label ? <span className="ml-1 text-[10px] text-accent">#{node.label}</span> : null}
        </span>
        {branching && (
          <span className="mt-0.5 shrink-0 rounded-sm bg-active px-1 text-[10px] leading-4 text-muted" title={`${node.children.length} 个分支`}>
            {node.children.length} 分支
          </span>
        )}
        {isLeaf && (
          <span className="mt-0.5 shrink-0 rounded-sm bg-accent/15 px-1 text-[10px] leading-4 text-accent">当前</span>
        )}
      </div>
      {open &&
        node.children.map((child) => (
          <TreeRow
            key={child.entry.id}
            node={child}
            depth={depth + 1}
            activeLeafId={activeLeafId}
            activePath={activePath}
            onNavigate={onNavigate}
          />
        ))}
    </div>
  );
}

export function TreePanel({
  docked = false,
  tree,
  activeLeafId,
  onNavigate,
  onClose,
}: {
  tree: SessionTreeNode[];
  activeLeafId: string | null;
  onNavigate: (id: string) => void;
  onClose: () => void;
  /** 停靠模式：作为右侧整栏（与观测栏/预览面板同一槽位），而不是浮在聊天上方的弹层 */
  docked?: boolean;
}) {
  const activePath = useMemo(() => buildActivePathSet(tree, activeLeafId), [tree, activeLeafId]);
  /* 停靠态宽度可拖拽（与观测栏/预览面板同一套交互） */
  const { width: paneWidth, grow: growPane, reset: resetPane } = usePersistedWidth(
    "elenva-tree-panel-width",
    400,
    300,
    640,
  );
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    if (!query.trim()) return tree;
    const q = query.toLowerCase();
    const keep = (node: SessionTreeNode): SessionTreeNode | null => {
      const { text } = describeEntry(node.entry);
      const children = node.children.map(keep).filter((x): x is SessionTreeNode => x !== null);
      if (text.toLowerCase().includes(q) || children.length > 0) {
        return { ...node, children };
      }
      return null;
    };
    return tree.map(keep).filter((x): x is SessionTreeNode => x !== null);
  }, [tree, query]);

  const handleNavigate = useCallback(
    (id: string) => {
      onNavigate(id);
      onClose();
    },
    [onNavigate, onClose],
  );

  const flattenCount = (nodes: SessionTreeNode[]): number =>
    nodes.reduce((acc, n) => acc + 1 + flattenCount(n.children), 0);

  const panel = (
    <div
      data-testid="tree-panel"
      className={cn(
        "flex min-h-0 flex-col bg-panel",
        docked
          ? "h-full shrink-0 border-r border-line"
          : "absolute right-0 top-9 z-50 max-h-[70vh] w-[420px] overflow-hidden rounded-card border border-line shadow-lg",
      )}
      style={docked ? { width: paneWidth } : undefined}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3.5">
        <GitBranch size={14} className="shrink-0 text-accent" />
        <span className="text-[13px] font-semibold text-fg">会话树</span>
        {docked && <span className="shrink-0 text-[11px] text-dim">{flattenCount(tree)} 个节点</span>}
        <button
          onClick={onClose}
          className="ml-auto flex size-6 cursor-pointer items-center justify-center rounded-md text-dim t-fast hover:bg-hover hover:text-fg"
        >
          <X size={14} />
        </button>
      </div>
      {/* 说明只在停靠态常驻（浮层空间紧，靠标题 tooltip 兑付） */}
      {docked && (
        <div className="shrink-0 border-b border-line-soft px-3.5 py-1.5 text-[11px] leading-relaxed text-dim">
          点任意节点即从那里继续（产生新分支）；当前所在位置已高亮。
        </div>
      )}
      <div className="shrink-0 border-b border-line-soft px-3 py-1.5">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="筛选消息…"
          className="h-6 w-full rounded-md border border-line bg-panel-2 px-2 text-[12px] text-fg outline-none placeholder:text-dim focus:border-accent/50"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {filtered.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px] text-dim">没有匹配的消息</div>
        ) : (
          filtered.map((node) => (
            <TreeRow
              key={node.entry.id}
              node={node}
              depth={0}
              activeLeafId={activeLeafId}
              activePath={activePath}
              onNavigate={handleNavigate}
            />
          ))
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5 border-t border-line-soft px-3 py-1.5 text-[11px] leading-relaxed text-dim">
        <CornerDownRight size={10} className="shrink-0" /> 点击历史节点 = 从该处继续（原历史保留）
      </div>
    </div>
  );

  if (!docked) return panel;
  return (
    <>
      <Resizer onDrag={growPane} onDoubleClick={resetPane} invert side="left" label="调整会话树宽度" />
      {panel}
    </>
  );
}
