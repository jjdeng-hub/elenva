"use client";

import { ChevronDown, ChevronRight, GitCommitVertical, History, Loader2, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "@/components/lib/utils";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { dialogConfirm, toast } from "@/components/ui/dialog";
import { relTime } from "@/lib/format";
import type { GitCommitSummary, GitLogResponse } from "@/lib/git-log";
import type { GitCommitFile, GitShowResponse } from "@/lib/git-show";

/**
 * 提交历史面板（代码页内切换显示）。
 *
 * 补齐的摩擦：提交完只有一个 toast，界面上回答不了「刚才提交了什么」，
 * 也没法把某个文件退回历史版本。
 *
 * 三段状态都显式处理：列表（空仓库 / 非仓库 / 加载失败 / 分页）、
 * 详情（元信息 + 文件清单）、单文件 diff（默认折叠）。
 */

const PAGE_SIZE = 30;

type ListState = "loading" | "ready" | "empty" | "not-repo" | "error";

function statusTone(code: string): string {
  if (code === "A" || code === "U") return "text-success";
  if (code === "D") return "text-danger";
  if (code === "R" || code === "C") return "text-warn";
  return "text-muted";
}

function DiffLines({ diff }: { diff: string }) {
  return (
    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border border-line-soft bg-panel-2 p-2 font-mono text-[11px] leading-5">
      {diff.split("\n").map((line, index) => (
        <div
          key={index}
          className={cn(
            line.startsWith("+") && !line.startsWith("+++") && "text-success",
            line.startsWith("-") && !line.startsWith("---") && "text-danger",
            (line.startsWith("@@") || line.startsWith("diff --git")) && "text-muted",
          )}
        >
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

export function HistoryPanel({
  cwd,
  onRestored,
  onClose,
}: {
  cwd: string;
  /** 恢复成功后通知父级刷新工作区状态 */
  onRestored: () => void;
  onClose: () => void;
}) {
  const [commits, setCommits] = useState<GitCommitSummary[]>([]);
  const [branch, setBranch] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [listState, setListState] = useState<ListState>("loading");
  const [listError, setListError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);

  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [detail, setDetail] = useState<GitShowResponse | null>(null);
  const [detailState, setDetailState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [detailError, setDetailError] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [restoring, setRestoring] = useState<string | null>(null);

  const fetchPage = useCallback(
    async (before?: string) => {
      const query = new URLSearchParams({ cwd, limit: String(PAGE_SIZE) });
      if (before) query.set("before", before);
      const res = await fetch(`/api/git/log?${query.toString()}`, { cache: "no-store" });
      const data = (await res.json()) as GitLogResponse & { error?: string };
      if (!res.ok) throw new Error(data.error || `加载失败（HTTP ${res.status}）`);
      return data;
    },
    [cwd],
  );

  const loadList = useCallback(async () => {
    setListState("loading");
    setListError("");
    try {
      const data = await fetchPage();
      if (!data.isGitRepository) {
        setListState("not-repo");
        setCommits([]);
        return;
      }
      setBranch(data.branch ?? null);
      const list = data.commits ?? [];
      setCommits(list);
      setHasMore(Boolean(data.hasMore));
      setListState(list.length === 0 ? "empty" : "ready");
      setSelectedHash((prev) => (prev && list.some((c) => c.hash === prev) ? prev : list[0]?.hash ?? null));
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error));
      setListState("error");
    }
  }, [fetchPage]);

  useEffect(() => {
    setSelectedHash(null);
    setDetail(null);
    void loadList();
  }, [cwd, loadList]);

  const loadMore = useCallback(async () => {
    if (commits.length === 0) return;
    setLoadingMore(true);
    try {
      const data = await fetchPage(commits[commits.length - 1]?.hash);
      setCommits((prev) => [...prev, ...(data.commits ?? [])]);
      setHasMore(Boolean(data.hasMore));
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingMore(false);
    }
  }, [commits, fetchPage]);

  useEffect(() => {
    if (!selectedHash) {
      setDetail(null);
      setDetailState("idle");
      return;
    }
    let alive = true;
    setDetailState("loading");
    setDetailError("");
    setExpanded(new Set());
    fetch(`/api/git/show?cwd=${encodeURIComponent(cwd)}&hash=${encodeURIComponent(selectedHash)}`, {
      cache: "no-store",
    })
      .then(async (res) => {
        const data = (await res.json()) as GitShowResponse & { error?: string };
        if (!res.ok) throw new Error(data.error || `加载失败（HTTP ${res.status}）`);
        return data;
      })
      .then((data) => {
        if (!alive) return;
        setDetail(data);
        setDetailState("ready");
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setDetailError(error instanceof Error ? error.message : String(error));
        setDetailState("error");
      });
    return () => {
      alive = false;
    };
  }, [cwd, selectedHash]);

  const toggleExpand = (filePath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  };

  const restore = useCallback(
    async (file: GitCommitFile) => {
      if (!detail || !selectedHash) return;
      const confirmed = await dialogConfirm({
        title: "恢复此版本",
        message:
          `将把 ${file.path} 恢复到 ${detail.commit.shortHash} 的版本。\n\n`
          + "当前文件内容会被覆盖，该文件未提交的改动会丢失。",
        confirmText: "恢复",
        danger: true,
      });
      if (!confirmed) return;

      setRestoring(file.path);
      const call = async (force: boolean) => {
        const res = await fetch("/api/git/restore-file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd, hash: selectedHash, path: file.path, force }),
        });
        const data = (await res.json()) as {
          error?: string;
          code?: string;
          shortHash?: string;
          path?: string;
          matchesHead?: boolean;
          status?: { code: string; status: string } | null;
        };
        return { res, data };
      };

      try {
        let { res, data } = await call(false);
        if (res.status === 409 && data.code === "uncommitted-changes") {
          const force = await dialogConfirm({
            title: "该文件有未提交改动",
            message: `${data.error ?? "恢复会覆盖未提交的改动。"}\n\n仍然覆盖？被丢弃的改动无法从这个界面找回。`,
            confirmText: "仍然覆盖",
            danger: true,
          });
          if (!force) return;
          ({ res, data } = await call(true));
        }
        if (!res.ok) throw new Error(data.error || `恢复失败（HTTP ${res.status}）`);
        toast(
          data.matchesHead
            ? `已恢复 ${data.path ?? file.path}（与 HEAD 一致）`
            : `已恢复 ${data.path ?? file.path}，现在是「${data.status?.status ?? "已修改"}」待提交`,
        );
        onRestored();
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error));
      } finally {
        setRestoring(null);
      }
    },
    [cwd, detail, onRestored, selectedHash],
  );

  return (
    <div className="flex min-h-0 flex-1">
      {/* 左：提交列表 */}
      <div className="flex shrink-0 flex-col border-r border-line bg-panel" style={{ width: 340 }}>
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line-soft px-3">
          <History size={14} className="shrink-0 text-accent" />
          <span className="text-[13px] font-semibold text-fg">提交历史</span>
          {branch && <span className="chip chip-mono shrink-0 px-1.5">{branch}</span>}
          <button onClick={onClose} className="btn btn-icon btn-ghost ml-auto shrink-0" title="返回代码视图">
            <X size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-2" data-testid="git-history-list">
          {listState === "loading" && (
            <div className="flex items-center gap-2 px-2 py-3 text-[12px] text-dim">
              <Loader2 size={12} className="anim-spin" /> 正在读取提交历史…
            </div>
          )}
          {listState === "not-repo" && (
            <p className="px-2 py-3 text-[12px] text-dim">当前目录不是 Git 仓库。</p>
          )}
          {listState === "empty" && (
            <p className="px-2 py-3 text-[12px] text-dim">这个仓库还没有任何提交。</p>
          )}
          {listState === "error" && (
            <div className="px-2 py-3 text-[12px]">
              <p className="text-danger">提交历史加载失败</p>
              <p className="mt-1 text-muted">{listError}</p>
              <button onClick={() => void loadList()} className="btn btn-sm btn-ghost mt-2">
                重试
              </button>
            </div>
          )}

          {commits.map((commit) => (
            <button
              key={commit.hash}
              onClick={() => setSelectedHash(commit.hash)}
              data-testid="git-history-item"
              className={cn(
                "mb-1 w-full rounded-md border px-2 py-1.5 text-left t-fast",
                selectedHash === commit.hash
                  ? "border-accent/40 bg-accent/10"
                  : "border-transparent hover:bg-panel-2",
              )}
            >
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[11px] text-muted">{commit.shortHash}</span>
                {commit.isHead && <span className="chip chip-accent px-1.5 text-[10px]">HEAD</span>}
                <span className="ml-auto shrink-0 text-[10px] text-dim">{relTime(commit.date)}</span>
              </div>
              <div className="mt-0.5 truncate text-[12px] text-fg" title={commit.subject}>
                {commit.subject || "（无标题）"}
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-[10px] text-dim">
                <span className="truncate">{commit.author}</span>
                <span className="shrink-0 text-success">+{commit.additions}</span>
                <span className="shrink-0 text-danger">−{commit.deletions}</span>
                <span className="shrink-0">{commit.filesChanged} 个文件</span>
              </div>
            </button>
          ))}

          {listState === "ready" && hasMore && (
            <button
              onClick={() => void loadMore()}
              disabled={loadingMore}
              className="btn btn-sm btn-ghost mt-1 w-full"
            >
              {loadingMore ? <Loader2 size={12} className="anim-spin" /> : <ChevronDown size={12} />} 加载更早的提交
            </button>
          )}
          {listState === "ready" && !hasMore && commits.length > 0 && (
            <p className="py-2 text-center text-[10px] text-dim">— 已到最早的提交 —</p>
          )}
        </div>
      </div>

      {/* 右：详情 */}
      <div className="min-h-0 flex-1 overflow-auto bg-app p-4" data-testid="git-history-detail">
        {detailState === "idle" && (
          <div className="flex h-full items-center justify-center text-[12px] text-dim">
            从左侧选一条提交查看详情
          </div>
        )}
        {detailState === "loading" && (
          <div className="flex items-center gap-2 text-[12px] text-dim">
            <Loader2 size={12} className="anim-spin" /> 正在加载提交详情…
          </div>
        )}
        {detailState === "error" && (
          <div className="text-[12px]">
            <p className="text-danger">提交详情加载失败</p>
            <p className="mt-1 text-muted">{detailError}</p>
          </div>
        )}
        {detailState === "ready" && detail && (
          <div className="flex flex-col gap-3">
            <Card>
              <CardHeader>
                <GitCommitVertical size={14} className="shrink-0 text-accent" />
                <CardTitle>{detail.commit.subject || "（无标题）"}</CardTitle>
                <span className="chip chip-mono ml-auto shrink-0 px-1.5">{detail.commit.shortHash}</span>
              </CardHeader>
              <div className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-dim">
                  <span>{detail.commit.author}</span>
                  {detail.commit.authorEmail && <span className="text-muted">{detail.commit.authorEmail}</span>}
                  <span>{new Date(detail.commit.date).toLocaleString("zh-CN")}</span>
                  <span>{relTime(detail.commit.date)}</span>
                  {detail.commit.parents.length > 1 && <span>合并提交（{detail.commit.parents.length} 个父提交）</span>}
                  {detail.commit.parents.length === 0 && <span>初始提交</span>}
                </div>
                {detail.commit.body && (
                  <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line-soft bg-panel-2 p-2 font-mono text-[11px] text-fg">
                    {detail.commit.body}
                  </pre>
                )}
                <div className="mt-2 font-mono text-[10px] text-dim">{detail.commit.hash}</div>
              </div>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>变更文件</CardTitle>
                <span className="text-[11px] text-dim">{detail.files.length} 个</span>
                {detail.diffTruncated && <span className="chip chip-warn ml-auto px-1.5 text-[10px]">部分 diff 未加载</span>}
              </CardHeader>
              <div className="divide-y divide-line-soft">
                {detail.files.length === 0 && (
                  <p className="px-4 py-3 text-[12px] text-dim">这次提交没有文件变更（例如空提交或合并提交）。</p>
                )}
                {detail.files.map((file) => {
                  const isExpanded = expanded.has(file.path);
                  const canExpand = Boolean(file.diff);
                  return (
                    <div key={`${file.path}-${file.oldPath ?? ""}`} className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => canExpand && toggleExpand(file.path)}
                          disabled={!canExpand}
                          className={cn(
                            "flex min-w-0 flex-1 items-center gap-2 rounded-sm px-1 py-0.5 text-left",
                            canExpand ? "hover:bg-panel-2" : "cursor-default",
                          )}
                          title={canExpand ? "展开/收起 diff" : file.note ?? "没有可显示的 diff"}
                        >
                          {canExpand ? (
                            isExpanded ? <ChevronDown size={12} className="shrink-0 text-dim" /> : <ChevronRight size={12} className="shrink-0 text-dim" />
                          ) : (
                            <span className="w-3 shrink-0" />
                          )}
                          <span className={cn("w-3 shrink-0 font-mono text-[11px] font-semibold", statusTone(file.status))}>
                            {file.status}
                          </span>
                          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg" title={file.path}>
                            {file.oldPath && file.oldPath !== file.path && (
                              <span className="text-dim">{file.oldPath} → </span>
                            )}
                            {file.path}
                          </span>
                          {file.binary ? (
                            <span className="shrink-0 text-[10px] text-dim">二进制</span>
                          ) : (
                            <span className="shrink-0 text-[10px]">
                              <span className="text-success">+{file.additions ?? 0}</span>{" "}
                              <span className="text-danger">−{file.deletions ?? 0}</span>
                            </span>
                          )}
                        </button>
                        <button
                          onClick={() => void restore(file)}
                          disabled={restoring === file.path}
                          data-testid="git-restore-file"
                          className="btn btn-sm btn-ghost shrink-0"
                          title="把这个文件恢复到这次提交的版本"
                        >
                          {restoring === file.path ? (
                            <Loader2 size={10} className="anim-spin" />
                          ) : (
                            <RotateCcw size={10} />
                          )}{" "}
                          恢复此版本
                        </button>
                      </div>
                      {file.note && !isExpanded && <p className="pl-8 text-[10px] text-dim">{file.note}</p>}
                      {isExpanded && file.diff && (
                        <div className="mt-2 pl-4">
                          <DiffLines diff={file.diff} />
                          {file.truncated && <p className="mt-1 text-[10px] text-warn">diff 已截断（{file.note}）</p>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
