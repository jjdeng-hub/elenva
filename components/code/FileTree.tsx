"use client";

import { ChevronRight, File, FileCode2, FileText, Folder, FolderOpen, Image as ImageIcon, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/components/lib/utils";

/**
 * 项目文件树。
 *
 * 设计要点（对照之前 FileBrowser 的痛点）：
 *  · **真正的展开/折叠**：之前只能「点进去 / 上一级」逐层爬，看不到项目形状
 *  · 懒加载：只有展开的目录才请求子项，大仓库不会一次性拉爆
 *  · git 状态：文件显示 M/A/U/D 徽标；目录显示「内含变更」圆点，否则必须逐层点进去找
 *  · 提交勾选就在树上：勾哪几个文件是看树的时候决定的，不该在另一个列表里再选一次
 */

export type TreeEntry = { name: string; isDir: boolean; size: number; modified: string };
export type ReadChunk = {
  content?: string;
  truncated?: boolean;
  nextOffset?: number;
  language?: string;
  size?: number;
  binary?: boolean;
  reason?: string;
  error?: string;
};

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;

export function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.replace(/[\\/]+$/, "") + sep + name;
}

/** 统一成「正斜杠 + 小写」，用于与 /api/git/status 的绝对路径比对 */
export function pathKey(p: string): string {
  return p.split("\\").join("/").toLowerCase();
}


export async function fetchEntries(dir: string): Promise<TreeEntry[]> {
  const segments = dir.split(/[\\/]/).filter(Boolean).map(encodeURIComponent).join("/");
  const prefix = dir.startsWith("/") ? "/" : "";
  const res = await fetch(`/api/files/${prefix}${segments}?type=list`, { cache: "no-store" });
  const data = (await res.json()) as { entries?: TreeEntry[]; error?: string };
  if (!res.ok || data.error) {
    const message = data.error === "Access denied"
      ? "无权访问该目录（仅允许已授权的项目目录）"
      : data.error || `加载失败（HTTP ${res.status}）`;
    throw new Error(message);
  }
  return data.entries ?? [];
}

export function changedTone(code: string): string {
  if (code === "A") return "text-success";
  if (code === "D") return "text-danger";
  if (code === "U") return "text-warn";
  return "text-accent";
}

function FileIcon({ name }: { name: string }) {
  if (IMAGE_RE.test(name)) return <ImageIcon size={14} className="shrink-0 text-dim" />;
  if (/\.(md|mdx|txt)$/i.test(name)) return <FileText size={14} className="shrink-0 text-dim" />;
  if (/\.(ts|tsx|js|jsx|mjs|cjs|json|css|html|yml|yaml|toml|py|go|rs|java|sh)$/i.test(name)) {
    return <FileCode2 size={14} className="shrink-0 text-dim" />;
  }
  return <File size={14} className="shrink-0 text-dim" />;
}

/** 单个目录节点：自己管自己的展开状态与子项缓存 */
function DirNode({
  dir,
  name,
  depth,
  changed,
  refreshToken,
  selectedFile,
  commitSelection,
  onSelectFile,
  onToggleCommit,
}: {
  dir: string;
  name: string;
  depth: number;
  changed: Map<string, string>;
  refreshToken: number;
  selectedFile: string | null;
  commitSelection: Set<string>;
  onSelectFile: (path: string) => void;
  onToggleCommit: (path: string) => void;
}) {
  const [open, setOpen] = useState(depth === 0);
  /*
   * 拉取状态与**目录绑定**（而不是分散的 entries/loading/error 三个 useState）。
   *
   * 原因：根目录首帧可能是空字符串（roots 异步到达），会先发一个必然 404 的请求；
   * 随后 dir 变成真实路径时旧请求被守卫丢弃，而 finally 里的 setLoading(false) 也一并
   * 被丢弃 —— loading 永远为 true，之后所有拉取都被守卫挡住，节点彻底死掉（实测如此）。
   * 绑定到目录后，「某个目录是否在加载 / 是否已加载 / 是否出错」各自独立。
   */
  const [loaded, setLoaded] = useState<{ dir: string; entries: TreeEntry[] } | null>(null);
  const [failed, setFailed] = useState<{ dir: string; message: string } | null>(null);
  /** 仅供 spinner 显示；**不能进 effect 依赖** —— 见下方注释 */
  const [loadingDir, setLoadingDir] = useState<string | null>(null);
  /** 在途请求守卫用 ref：放进依赖会导致「设置它」本身把请求结果作废 */
  const inFlight = useRef<string | null>(null);
  const entries = loaded?.dir === dir ? loaded.entries : null;
  const error = failed?.dir === dir ? failed.message : null;

  useEffect(() => {
    // 刷新：清掉已加载与错误，让下面的 effect 重新拉取
    setLoaded(null);
    setFailed(null);
    inFlight.current = null;
  }, [refreshToken]);

  useEffect(() => {
    if (!open || !dir) return;
    if (loaded?.dir === dir) return;   // 已有该目录数据
    if (failed?.dir === dir) return;   // 出错后不自动重试，避免打转（刷新可重置）
    if (inFlight.current === dir) return;

    /*
     * 在途标记必须用 ref。
     * 之前用 state 并把 loadingDir 放进依赖数组：setLoadingDir(dir) 会立刻改变依赖 →
     * effect 重跑 → 上一次的 cleanup 把 alive 置 false → **刚发出的请求结果被整个丢弃**，
     * loaded 永远是 null，目录看起来「永远加载不出来」。
     */
    inFlight.current = dir;
    let alive = true;
    setLoadingDir(dir);
    fetchEntries(dir)
      .then((list) => {
        if (alive) setLoaded({ dir, entries: list });
      })
      .catch((e: unknown) => {
        if (alive) setFailed({ dir, message: e instanceof Error ? e.message : String(e) });
      })
      .finally(() => {
        if (inFlight.current === dir) inFlight.current = null;
        if (alive) setLoadingDir((cur) => (cur === dir ? null : cur));
      });
    return () => {
      alive = false;
      if (inFlight.current === dir) inFlight.current = null;
    };
  }, [open, dir, loaded, failed]);

  const loading = loadingDir === dir;

  const dirPrefix = `${pathKey(dir)}/`;
  const hasChanges = useMemo(
    () => [...changed.keys()].some((k) => k.startsWith(dirPrefix)),
    [changed, dirPrefix],
  );
  const visible = entries ?? [];


  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        data-testid="tree-dir"
        title={dir}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        className="flex w-full cursor-pointer items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[12px] text-fg t-fast hover:bg-hover"
      >
        <ChevronRight
          size={12}
          className={cn("shrink-0 text-dim transition-transform", open && "rotate-90")}
        />
        {open ? (
          <FolderOpen size={14} className={cn("shrink-0", hasChanges ? "text-accent" : "text-accent/70")} />
        ) : (
          <Folder size={14} className={cn("shrink-0", hasChanges ? "text-accent" : "text-accent/70")} />
        )}
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {hasChanges && <span className="shrink-0 text-[10px] text-accent/70">●</span>}
        {loading && <Loader2 size={10} className="anim-spin shrink-0 text-dim" />}
      </button>

      {open && (
        <div>
          {error && (
            <div
              style={{ paddingLeft: `${depth * 12 + 30}px` }}
              className="py-1 pr-2 text-[11px] text-danger"
            >
              {error}
            </div>
          )}
          {entries !== null && visible.length === 0 && !error && (
            <div style={{ paddingLeft: `${depth * 12 + 30}px` }} className="py-1 pr-2 text-[11px] text-dim/70">
              空目录
            </div>
          )}
          {visible.map((e) =>
            e.isDir ? (
              <DirNode
                key={e.name}
                dir={joinPath(dir, e.name)}
                name={e.name}
                depth={depth + 1}
                changed={changed}
                refreshToken={refreshToken}
                selectedFile={selectedFile}
                commitSelection={commitSelection}
                onSelectFile={onSelectFile}
                onToggleCommit={onToggleCommit}
              />
            ) : (
              <FileRow
                key={e.name}
                path={joinPath(dir, e.name)}
                name={e.name}
                depth={depth + 1}
                code={changed.get(pathKey(joinPath(dir, e.name)))}
                selected={selectedFile === joinPath(dir, e.name)}
                checked={commitSelection.has(joinPath(dir, e.name))}
                onSelectFile={onSelectFile}
                onToggleCommit={onToggleCommit}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function FileRow({
  path,
  name,
  depth,
  code,
  selected,
  checked,
  onSelectFile,
  onToggleCommit,
}: {
  path: string;
  name: string;
  depth: number;
  code?: string;
  selected: boolean;
  checked: boolean;
  onSelectFile: (path: string) => void;
  onToggleCommit: (path: string) => void;
}) {
  return (
    <div
      /* testid 挂在整行（含勾选框），而不是内部的名字按钮 —— 否则
         「勾选」「选中」两个动作在 DOM 上分属不同层级，很难稳定定位 */
      data-testid="tree-file"
      data-path={path}
      data-code={code ?? ""}
      className={cn(
        "group flex items-center gap-1.5 rounded-md py-1 pr-2 t-fast",
        selected ? "bg-active" : "hover:bg-hover",
      )}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
    >
      {/* 有改动才给勾选框：勾选只对「本次要提交的文件」有意义 */}
      {code ? (
        <input
          type="checkbox"
          checked={checked}
          onChange={() => onToggleCommit(path)}
          onClick={(e) => e.stopPropagation()}
          title="勾选以纳入本次提交"
          aria-label={`纳入提交：${name}`}
          className="size-3 shrink-0 cursor-pointer accent-[var(--accent)]"
        />
      ) : (
        <span className="w-3 shrink-0" />
      )}
      <button
        onClick={() => onSelectFile(path)}
        data-testid="tree-file-open"
        title={path}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left text-[12px]"
      >
        <FileIcon name={name} />
        <span className={cn("min-w-0 truncate", selected ? "text-accent" : "text-fg")}>{name}</span>
      </button>
      {code && (
        <span className={cn("shrink-0 font-mono text-[10px] font-bold", changedTone(code))}>{code}</span>
      )}
    </div>
  );
}

export function FileTree({
  root,
  changed,
  originalByKey,
  onlyChanged,
  refreshToken,
  selectedFile,
  commitSelection,
  onSelectFile,
  onToggleCommit,
}: {
  root: string;
  /** pathKey(绝对路径) → git 状态码，仅用于查表 */
  changed: Map<string, string>;
  /** pathKey → 原始绝对路径。扁平清单只有 key，必须反查回真实路径 —— 提交接口按原样路径匹配 */
  originalByKey: Map<string, string>;
  onlyChanged: boolean;
  refreshToken: number;
  selectedFile: string | null;
  commitSelection: Set<string>;
  onSelectFile: (path: string) => void;
  onToggleCommit: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  /* 搜索走 /api/file-index（与 @ 引用同一索引）：能按名字找**任意**文件，
     而不是只在变更清单里过滤 —— 后者在「我记得文件名但不知道在哪」时完全没用。 */
  const [hits, setHits] = useState<{ path: string; isDir: boolean }[] | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      setSearching(true);
      fetch(`/api/file-index?cwd=${encodeURIComponent(root)}&q=${encodeURIComponent(q)}`, {
        cache: "no-store",
      })
        .then((r) => (r.ok ? r.json() : { matches: [] }))
        .then((d: { matches?: { path: string; isDir: boolean }[] }) => {
          if (alive) setHits(d.matches ?? []);
        })
        .catch(() => {
          if (alive) setHits([]);
        })
        .finally(() => {
          if (alive) setSearching(false);
        });
    }, 180);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query, root]);

  /*
   * 「只看改动」与搜索都走**扁平清单**而不是过滤树。
   *
   * 理由：变更文件通常埋在未展开的子目录里，过滤树只会剩下几个目录节点，
   * 用户还得一层层点开才看得到 —— 那正是「看改动」想避免的事。
   * 扁平列出路径（相对根目录）才是这个模式该有的样子。
   */
  /** 变更文件的扁平清单（不依赖搜索） */
  const changedRows = useMemo(() => {
    const prefix = `${pathKey(root).replace(/\/+$/, "")}/`;
    return [...changed.entries()]
      .map(([key, code]) => ({
        key,
        code,
        rel: key.startsWith(prefix) ? key.slice(prefix.length) : key,
      }))
      .sort((a, b) => a.rel.localeCompare(b.rel));
  }, [changed, root]);

  if (!root) {
    return (
      <div className="flex min-h-0 flex-col">
        <div className="px-3 py-4 text-[11px] leading-relaxed text-dim">
          正在确定项目目录…（若长时间无内容，请到「工作台」新建一个会话）
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-col">
      <div className="shrink-0 px-2 pb-1.5 pt-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="按名字搜索项目文件…"
          data-testid="tree-search"
          className="h-7 w-full rounded-md border border-line bg-panel-2 px-2 text-[12px] text-fg outline-none focus:border-accent/50"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2" data-testid="file-tree">
        {hits !== null ? (
          <>
            {searching && <div className="px-2 py-2 text-[11px] text-dim">搜索中…</div>}
            {!searching && hits.length === 0 && (
              <div className="px-2 py-3 text-[11px] text-dim">没有匹配的文件</div>
            )}
            {hits.map((hit) => {
              const abs = joinPath(root, hit.path);
              const key = pathKey(abs);
              const code = changed.get(key);
              return (
                <FileRow
                  key={abs}
                  path={abs}
                  name={hit.isDir ? `${hit.path}/` : hit.path}
                  depth={0}
                  code={code}
                  selected={selectedFile !== null && pathKey(selectedFile) === key}
                  checked={commitSelection.has(abs)}
                  onSelectFile={onSelectFile}
                  onToggleCommit={onToggleCommit}
                />
              );
            })}
          </>
        ) : onlyChanged ? (
          changedRows.length === 0 ? (
            <div className="px-2 py-3 text-[11px] text-dim">
              {changed.size === 0 ? "当前没有任何变更" : "没有匹配的变更文件"}
            </div>
          ) : (
            changedRows.map((row) => (
              <FileRow
                key={row.key}
                path={originalByKey.get(row.key) ?? row.key}
                name={row.rel}
                depth={0}
                code={row.code}
                selected={selectedFile !== null && pathKey(selectedFile) === row.key}
                checked={commitSelection.has(originalByKey.get(row.key) ?? row.key)}
                onSelectFile={onSelectFile}
                onToggleCommit={onToggleCommit}
              />
            ))
          )
        ) : (
          <>
            <DirNode
              dir={root}
              name={root.split(/[\\/]/).filter(Boolean).pop() ?? root}
              depth={0}
              changed={changed}
              refreshToken={refreshToken}
              selectedFile={selectedFile}
              commitSelection={commitSelection}
              onSelectFile={onSelectFile}
              onToggleCommit={onToggleCommit}
            />
          </>
        )}
      </div>
    </div>
  );
}
