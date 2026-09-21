"use client";

import { Eye, GitBranch, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "@/components/lib/utils";
import { Resizer, usePersistedWidth } from "@/components/ui/Resizer";
import { CommitBar } from "@/components/code/CommitBar";
import { FileTree, pathKey } from "@/components/code/FileTree";
import { FileViewer } from "@/components/code/FileViewer";
import type { GitStatusResponse } from "@/lib/git-types";

/**
 * 「代码」页 —— 文件浏览 + 改动查看 + 提交，合一。
 *
 * 为什么合并：原来「Git 变更」和「文件浏览器」是两个页面 —— 一个只会列改动、
 * 一个只会翻文件，而实际工作是同一件事的连续动作（看到改动 → 打开那个文件 →
 * 提交）。分页导致要在两者之间来回跳，切页时还会丢失「当前看的是哪个文件」。
 * 现在左侧树同时承担「浏览」与「改动清单」，右侧一栏在「内容 / 改动」间切换。
 */

type Worktree = { path: string; branch?: string };

export function CodeView({
  roots,
  defaultCwd,
  initialCwd,
  initialFile,
  initialOnlyChanged,
}: {
  /** 可浏览的根目录（按最近活跃排序） */
  roots: string[];
  defaultCwd: string | null;
  /** 从其它视图跳进来时要定位到的目录（如会话顶栏的分支 chip） */
  initialCwd?: string | null;
  /** 从其它视图跳进来时要定位到的文件（如观测栏的「在代码页打开」） */
  initialFile?: string | null;
  /**
   * 进入时是否直接进「只看改动」清单。
   * 观测栏的 Git 按钮写的是「去提交这 N 个文件」，那就该直接把改动清单摆出来 ——
   * 否则落到全量文件树，用户还得自己点一次，而且与旁边的「查看项目」变成同一个效果。
   */
  initialOnlyChanged?: boolean;
}) {
  const fallbackRoot = roots[0] ?? defaultCwd ?? "";
  const [pickedCwd, setPickedCwd] = useState<string | null>(null);
  const cwd = pickedCwd ?? initialCwd ?? fallbackRoot;

  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [branch, setBranch] = useState<string | null>(null);
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [commitSelection, setCommitSelection] = useState<Set<string>>(new Set());
  const [diff, setDiff] = useState<{ path: string; patch?: string; supported?: boolean } | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  /* initialCwd 变化（从会话跳进来）时跟随 */
  useEffect(() => {
    if (initialCwd) setPickedCwd(initialCwd);
  }, [initialCwd]);

  /* initialFile：从观测栏跳进来时直接定位到该文件 */
  useEffect(() => {
    if (initialFile) setSelectedFile(initialFile);
  }, [initialFile]);

  /* initialOnlyChanged：写「去提交这 N 个文件」的入口进来就该看到改动清单 */
  useEffect(() => {
    if (initialOnlyChanged) setOnlyChanged(true);
  }, [initialOnlyChanged]);

  const load = useCallback(async (dir: string) => {
    if (!dir) return;
    setStatusLoading(true);
    try {
      const [s, w] = await Promise.all([
        fetch(`/api/git/status?cwd=${encodeURIComponent(dir)}`, { cache: "no-store" }).then((r) => r.json()),
        fetch(`/api/worktrees?cwd=${encodeURIComponent(dir)}`, { cache: "no-store" }).then((r) => r.json()),
      ]);
      setStatus(s as GitStatusResponse);
      if (w?.isGit && Array.isArray(w.worktrees)) {
        setWorktrees(w.worktrees.map((x: { path: string; branch?: string }) => ({ path: x.path, branch: x.branch })));
      } else {
        setWorktrees([]);
      }
      setBranch((s as { branch?: string })?.branch ?? null);
      // 刷新后重新全选（与初始行为一致：默认全选，用户再取消不要的）
      const list = ((s as GitStatusResponse).files ?? []).map((f) => f.filePath);
      setCommitSelection(new Set(list));
      setRefreshToken((n) => n + 1);
    } catch {
      setStatus(null);
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(cwd);
  }, [cwd, load]);

  /**
   * 两份索引：
   *  · changed：pathKey（小写正斜杠）→ 状态码，用于在树/清单里查表
   *  · originalByKey：pathKey → **原始绝对路径**。提交接口按原始路径校验，
   *    若把 key 直接传过去（大小写/分隔符不同）会全部匹配不上，表现为「勾了却提交 0 个文件」。
   */
  const { changed, originalByKey } = useMemo(() => {
    const codes = new Map<string, string>();
    const originals = new Map<string, string>();
    for (const f of status?.files ?? []) {
      const key = pathKey(f.filePath);
      codes.set(key, f.code);
      originals.set(key, f.filePath);
    }
    return { changed: codes, originalByKey: originals };
  }, [status]);

  /* 选中文件变化 → 若它有改动就预取 diff（切到「改动」页签时无需等待） */
  useEffect(() => {
    setDiff(null);
    if (!selectedFile || !changed.has(pathKey(selectedFile))) return;
    let alive = true;
    setDiffLoading(true);
    fetch(`/api/git/diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(selectedFile)}`, {
      cache: "no-store",
    })
      .then((r) => r.json())
      .then((d: { patch?: string; supported?: boolean }) => {
        if (alive) setDiff({ path: selectedFile, patch: d.patch, supported: d.supported });
      })
      .catch(() => {
        if (alive) setDiff({ path: selectedFile, supported: false });
      })
      .finally(() => {
        if (alive) setDiffLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [selectedFile, cwd, changed]);

  const toggleCommit = useCallback((path: string) => {
    setCommitSelection((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const changedCount = status?.files.length ?? 0;
  const { width: treeWidth, grow: growTree, reset: resetTree } = usePersistedWidth(
    "elenva-code-tree-width",
    300,
    220,
    520,
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 工具条 */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-panel px-4">
        <select
          value={roots.includes(cwd) ? cwd : ""}
          onChange={(e) => {
            if (e.target.value) setPickedCwd(e.target.value);
          }}
          title="切换项目 / 工作区"
          data-testid="code-project"
          className="h-8 max-w-xs cursor-pointer rounded-lg border border-line bg-panel-2 px-2 text-[12px] text-fg outline-none"
        >
          {!roots.includes(cwd) && <option value="">（当前：{cwd || "—"}）</option>}
          {roots.map((r) => {
            const parts = r.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
            return (
              <option key={r} value={r}>
                {parts[parts.length - 1] ?? r} — {r}
              </option>
            );
          })}
        </select>

        {branch && (
          <span className="chip shrink-0 items-center gap-1.5 px-2" title="当前分支 / 工作树">
            <GitBranch size={12} className="shrink-0 text-dim" />
            <span className="max-w-32 truncate">{branch}</span>
          </span>
        )}
        {worktrees.length > 1 && (
          <select
            value={worktrees.some((w) => w.path === cwd) ? cwd : ""}
            onChange={(e) => e.target.value && setPickedCwd(e.target.value)}
            title="切换工作树"
            className="h-8 max-w-xs cursor-pointer rounded-lg border border-line bg-panel-2 px-2 text-[12px] text-fg outline-none"
          >
            {!worktrees.some((w) => w.path === cwd) && <option value="">主工作区</option>}
            {worktrees.map((w) => (
              <option key={w.path} value={w.path}>
                {w.path.replace(/[\\/]+$/, "").split(/[\\/]/).pop()}
                {w.branch ? ` (${w.branch})` : ""}
              </option>
            ))}
          </select>
        )}

        <span className="shrink-0 text-[12px] text-dim">
          {status?.isGitRepository
            ? `${changedCount} 个变更 · +${status.additions} / −${status.deletions}`
            : "非 Git 仓库"}
        </span>

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <button
            onClick={() => setOnlyChanged((v) => !v)}
            data-testid="only-changed"
            title="只显示含变更的文件"
            className={cn(
              "btn btn-sm",
              onlyChanged ? "btn-primary" : "btn-ghost",
            )}
          >
            <Eye size={12} /> 只看改动
          </button>
          <button
            onClick={() => void load(cwd)}
            className="btn btn-sm btn-ghost"
            title="刷新"
          >
            <RefreshCw size={12} className={cn(statusLoading && "anim-spin")} /> 刷新
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 左：文件树（含改动徽标与提交勾选） */}
        <div className="flex shrink-0 flex-col border-r border-line bg-panel" style={{ width: treeWidth }}>
          <FileTree
            root={cwd}
            changed={changed}
            originalByKey={originalByKey}
            onlyChanged={onlyChanged}
            refreshToken={refreshToken}
            selectedFile={selectedFile}
            commitSelection={commitSelection}
            onSelectFile={setSelectedFile}
            onToggleCommit={toggleCommit}
          />
        </div>

        <Resizer onDrag={growTree} onDoubleClick={resetTree} label="调整文件树宽度" />

        {/* 右：内容 / 改动 */}
        <FileViewer
          path={selectedFile}
          cwd={cwd}
          changedCode={selectedFile ? changed.get(pathKey(selectedFile)) : undefined}
          defaultMode={onlyChanged ? "diff" : "content"}
          diffText={diff?.path === selectedFile ? diff?.patch : undefined}
          diffLoading={diffLoading}
          diffUnsupported={diff?.path === selectedFile ? diff?.supported === false : false}
        />
      </div>

      {/* 底：提交条 */}
      <CommitBar
        cwd={cwd}
        status={status}
        selected={commitSelection}
        onSelectedChange={setCommitSelection}
        onCommitted={() => void load(cwd)}
      />
    </div>
  );
}
