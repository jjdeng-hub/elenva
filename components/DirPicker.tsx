"use client";

import { ArrowUp, Check, Folder, FolderPlus, HardDrive, Home, Loader2, Sparkles, X } from "lucide-react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/components/lib/utils";
import { toast } from "@/components/ui/dialog";

type BrowsableDirectory = { name: string; path: string };
type BrowseResponse = {
  path: string;
  parentPath: string | null;
  drives?: BrowsableDirectory[];
  places?: BrowsableDirectory[];
  directories: BrowsableDirectory[];
  error?: string;
};

/** 记住上次浏览到的目录：每次打开都从「此电脑」重新点四层是纯浪费 */
const LAST_DIR_KEY = "elenva-dir-picker-last";

/**
 * 工作区目录选择器。
 *
 * 修掉的三个真问题：
 *  1. **无法用鼠标选中目录**：每行的「选择」按钮原本靠 `group-hover:block` 显示，
 *     但父元素没有 `group` 类 → 永远不可见 → 只能手输路径。现在底部有常驻的
 *     「使用此目录」，每行也有常驻的「选择」。
 *  2. **每次都从根目录开始**：现在记住上次位置（localStorage）。
 *  3. **手输路径失败无反馈**：现在回显服务端的错误原因。
 *
 * 另加：常用位置（桌面/主目录/文档/下载）与「新建文件夹」—— 后者用于
 * 「在桌面上新建一个目录作为工作区」这种最常见的诉求。
 */
export function DirPicker({
  open,
  onClose,
  onPick,
  defaultCwd,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (path: string) => void;
  defaultCwd: string | null;
}) {
  const [current, setCurrent] = useState<string>("");
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [drives, setDrives] = useState<BrowsableDirectory[]>([]);
  const [places, setPlaces] = useState<BrowsableDirectory[]>([]);
  const [dirs, setDirs] = useState<BrowsableDirectory[]>([]);
  const [loading, setLoading] = useState(false);
  const [manual, setManual] = useState("");
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* 新建文件夹：null = 未在创建；字符串 = 正在输入的名字 */
  const [newName, setNewName] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const newNameRef = useRef<HTMLInputElement | null>(null);

  const browse = useCallback(async (p: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = (await fetch(`/api/cwd/browse${p ? `?path=${encodeURIComponent(p)}` : ""}`, {
        cache: "no-store",
      }).then((r) => r.json())) as BrowseResponse;
      if (data.error) {
        setError(data.error);
        return;
      }
      setCurrent(data.path || "");
      setParentPath(data.parentPath ?? null);
      setDrives(data.drives ?? []);
      setPlaces(data.places ?? []);
      setDirs(data.directories ?? []);
      setManual(data.path || "");
      if (data.path) {
        try {
          localStorage.setItem(LAST_DIR_KEY, data.path);
        } catch {
          /* 隐身模式下 localStorage 可能不可用 */
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDirs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  /* 打开时回到上次位置；没记录过才落回「此电脑」 */
  useEffect(() => {
    if (!open) return;
    setError(null);
    setNewName(null);
    let last = "";
    try {
      last = localStorage.getItem(LAST_DIR_KEY) ?? "";
    } catch {
      last = "";
    }
    void browse(last);
  }, [open, browse]);

  useEffect(() => {
    if (newName !== null) newNameRef.current?.focus();
  }, [newName]);

  if (!open) return null;

  const useDirectory = async (path: string) => {
    const p = path.trim();
    if (!p) return;
    setValidating(true);
    setError(null);
    try {
      const res = await fetch("/api/cwd/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: p }),
      });
      if (res.ok) {
        onPick(p);
        onClose();
        return;
      }
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      // 原来这里静默 return —— 用户以为没反应，其实路径不合法
      setError(d.error || `无法使用该目录（HTTP ${res.status}）`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setValidating(false);
    }
  };

  const createFolder = async () => {
    if (newName === null || !newName.trim() || !current) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/cwd/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parent: current, name: newName }),
      });
      const d = (await res.json()) as { path?: string; error?: string };
      if (!res.ok) throw new Error(d.error || `创建失败（HTTP ${res.status}）`);
      toast(`已创建「${newName.trim()}」`);
      setNewName(null);
      await browse(d.path ?? current);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-overlay p-4" onMouseDown={onClose}>
      <div
        className="flex max-h-[75vh] w-full max-w-xl flex-col overflow-hidden rounded-card border border-line bg-panel shadow-lg"
        onMouseDown={(e) => e.stopPropagation()}
        data-testid="dir-picker"
      >
        {/* 标题 */}
        <CardHeader>
          <Folder size={14} className="text-accent" />
          <CardTitle>选择工作区目录</CardTitle>
          <span className="text-[11px] text-dim">Agent 将以此为工作目录读写文件</span>
          <button
            onClick={onClose}
            aria-label="关闭"
            className="ml-auto flex size-7 cursor-pointer items-center justify-center rounded-md text-dim t-fast hover:bg-hover hover:text-fg"
          >
            <X size={14} />
          </button>
        </CardHeader>

        {/* 手输路径 */}
        <div className="flex gap-2 border-b border-line-soft px-4 py-2.5">
          <input
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void useDirectory(manual)}
            placeholder={"直接输入绝对路径，如 C:\\Users\\" + "…\\Desktop\\我的项目"}
            data-testid="dir-manual"
            className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-panel-2 px-2.5 font-mono text-[12px] text-fg outline-none focus:border-accent/50"
          />
          <button
            onClick={() => void useDirectory(manual)}
            disabled={validating || !manual.trim()}
            className="flex h-8 cursor-pointer items-center gap-1 rounded-lg border border-line bg-panel-2 px-3 text-[12px] text-muted t-fast hover:text-fg disabled:opacity-50"
          >
            {validating ? <Loader2 size={12} className="anim-spin" /> : <Check size={12} />}
            使用此路径
          </button>
        </div>

        {/* 工具行 */}
        <div className="flex items-center gap-2 px-4 py-2 text-[12px] text-dim">
          <button
            onClick={() => parentPath !== null && void browse(parentPath)}
            disabled={parentPath === null || loading}
            className="flex h-7 cursor-pointer items-center gap-1 rounded-md border border-line bg-panel-2 px-2 text-muted t-fast hover:text-fg disabled:opacity-40"
          >
            <ArrowUp size={12} /> 上一级
          </button>
          <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={current}>
            {current || "此电脑"}
          </span>
          {loading && <Loader2 size={14} className="anim-spin" />}
          {current && (
            <button
              onClick={() => setNewName(newName === null ? "" : null)}
              className="flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-line bg-panel-2 px-2 text-muted t-fast hover:text-fg"
              data-testid="dir-new-folder"
            >
              <FolderPlus size={12} /> 新建文件夹
            </button>
          )}
        </div>

        {/* 新建文件夹输入 */}
        {newName !== null && current && (
          <div className="flex items-center gap-2 border-b border-line-soft bg-panel-2/60 px-4 py-2">
            <span className="shrink-0 text-[11px] text-dim">在 {current} 下新建：</span>
            <input
              ref={newNameRef}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) void createFolder();
                else if (e.key === "Escape") setNewName(null);
              }}
              placeholder="文件夹名称"
              data-testid="dir-new-name"
              className="h-7 min-w-0 flex-1 rounded-md border border-accent/50 bg-panel px-2 text-[12px] text-fg outline-none"
            />
            <button
              onClick={() => void createFolder()}
              disabled={creating || !newName.trim()}
              data-testid="dir-new-confirm"
              className="btn btn-sm btn-primary shrink-0"
            >
              {creating ? <Loader2 size={10} className="anim-spin" /> : <Check size={10} />} 创建
            </button>
            <button onClick={() => setNewName(null)} className="btn btn-sm btn-subtle shrink-0">
              取消
            </button>
          </div>
        )}

        {error && (
          <div className="border-b border-line-soft bg-danger/10 px-4 py-2 text-[12px] text-danger">{error}</div>
        )}

        {/* 目录列表 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {/* 常用位置：把「C: → Users → 用户名 → Desktop」四层缩成一次点击 */}
          {places.length > 0 && (
            <>
              <div className="px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-dim">
                常用位置
              </div>
              <div className="flex flex-wrap gap-1.5 px-2 pb-2">
                {places.map((place) => (
                  <button
                    key={place.path}
                    onClick={() => void browse(place.path)}
                    title={place.path}
                    className="flex cursor-pointer items-center gap-1.5 rounded-md border border-line bg-panel-2 px-2 py-1 text-[12px] text-muted t-fast hover:border-accent/40 hover:text-fg"
                  >
                    <Home size={12} className="shrink-0 text-dim" />
                    {place.name}
                  </button>
                ))}
              </div>
            </>
          )}

          {drives.length > 0 && (
            <>
              <div className="px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-dim">
                磁盘
              </div>
              {drives.map((d) => (
                <button
                  key={d.path}
                  onClick={() => void browse(d.path)}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-fg t-fast hover:bg-hover"
                >
                  <HardDrive size={14} className="shrink-0 text-dim" />
                  {d.name}
                </button>
              ))}
            </>
          )}

          {dirs.length > 0 && (
            <div className="px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-dim">
              子目录
            </div>
          )}
          {dirs.map((d) => (
            <div
              key={d.path}
              className={cn(
                "group flex w-full items-center gap-2 rounded-md px-2 py-1.5 t-fast hover:bg-hover",
                d.path === defaultCwd && "bg-accent-soft/40",
              )}
            >
              {/* 点名进入；右侧「选择」才真正选中 —— 两个动作分离，各有明确按钮 */}
              <button
                onClick={() => void browse(d.path)}
                title={d.path}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left text-[12px] text-fg"
              >
                <Folder size={14} className="shrink-0 text-accent/70" />
                <span className="min-w-0 flex-1 truncate">{d.name}</span>
              </button>
              {d.path === defaultCwd && <span className="chip chip-accent shrink-0">默认</span>}
              <button
                onClick={() => void useDirectory(d.path)}
                data-testid="dir-use-row"
                className="shrink-0 cursor-pointer rounded-sm px-1.5 py-0.5 text-[11px] text-accent t-fast hover:bg-accent-soft"
              >
                选择
              </button>
            </div>
          ))}

          {dirs.length === 0 && drives.length === 0 && !loading && (
            <div className="px-2 py-6 text-center text-[12px] text-dim">没有子目录</div>
          )}
        </div>

        {/* 底部 */}
        <div className="flex flex-wrap items-center gap-2 border-t border-line-soft px-4 py-2.5">
          {current && (
            <button
              onClick={() => void useDirectory(current)}
              disabled={validating}
              data-testid="dir-use-current"
              className="btn btn-primary"
            >
              {validating ? <Loader2 size={12} className="anim-spin" /> : <Check size={12} />}
              使用此目录
            </button>
          )}
          {defaultCwd && (
            <button
              onClick={() => void useDirectory(defaultCwd)}
              className="btn btn-ghost"
              title={defaultCwd}
            >
              <Sparkles size={12} /> 使用默认工作区
            </button>
          )}
          <span className="ml-auto text-[11px] text-dim">点目录名进入 · 点「选择」直接采用</span>
        </div>
      </div>
    </div>
  );
}
