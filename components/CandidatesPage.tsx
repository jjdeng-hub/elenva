"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FlaskConical, GitBranch, Loader2, Play, RotateCw, Trash2, Upload } from "lucide-react";
import { PageHeader } from "@/components/ui/bits";
import { Card, CardHeader } from "@/components/ui/card";
import { cn } from "@/components/lib/utils";
import { dialogConfirm, toast } from "@/components/ui/dialog";
import type { MemoryProject } from "@/components/MemoryPage";

/**
 * 并行试验：同一个任务开 N 个候选，各自在独立 worktree 里跑，跑完并排比。
 *
 * 不是「多开几个会话」——那只是并行，没解决判断问题。这里的分工是：
 * 候选各自有一份隔离的工作区（改动互不污染），界面上把差异摆在一起
 * （改了几个文件、加删多少行、最后说了什么），选定后一键把改动打回主工作区。
 */

interface CandidateInfo {
  sessionId: string;
  worktreePath: string;
  branch: string;
  status: "running" | "idle" | "error";
  error?: string;
  changedFiles: number;
  additions: number;
  deletions: number;
  summary: string | null;
}

interface CandidateGroup {
  id: string;
  cwd: string;
  baseCommit: string;
  prompt: string;
  createdAt: string;
  candidates: CandidateInfo[];
}

function shortTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return date.toLocaleDateString();
}

/** 空态的示例任务。选的是「改法可以不同、结果能并排比较」的任务形态 ——
    只有这类任务才值得开多个候选（纯事实查询开候选是浪费 token）。 */
const CANDIDATE_EXAMPLES = [
  "把这个模块里最长的那个函数拆成几个小函数，并补上单测",
  "找出这一层里重复度最高的三段逻辑，合并成一个可复用的工具函数",
  "给这个功能补上错误处理与边界情况，并在收尾时说明你覆盖了哪些分支",
];

export function CandidatesPage({
  projects,
  defaultCwd,
  onOpenSession,
}: {
  projects: MemoryProject[];
  defaultCwd: string | null;
  /** 打开候选会话（跳到对话视图） */
  onOpenSession?: (sessionId: string) => void;
}) {
  const [cwd, setCwd] = useState<string>(defaultCwd ?? projects[0]?.path ?? "");
  const [prompt, setPrompt] = useState("");
  const [count, setCount] = useState(2);
  const [groups, setGroups] = useState<CandidateGroup[]>([]);
  const [repoInfo, setRepoInfo] = useState<{ isGitRepo: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!cwd && (defaultCwd || projects[0]?.path)) setCwd(defaultCwd ?? projects[0]?.path ?? "");
  }, [cwd, defaultCwd, projects]);

  const load = useCallback(async (target: string, quiet = false) => {
    if (!target) return;
    if (!quiet) setLoading(true);
    try {
      const res = await fetch(`/api/candidates?cwd=${encodeURIComponent(target)}`, { cache: "no-store" });
      const data = (await res.json()) as {
        groups?: CandidateGroup[];
        repo?: { isGitRepo: boolean };
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || `加载失败（HTTP ${res.status}）`);
      setGroups(data.groups ?? []);
      setRepoInfo(data.repo ?? null);
    } catch (error) {
      if (!quiet) toast(error instanceof Error ? error.message : "加载失败");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(cwd);
  }, [cwd, load]);

  const anyRunning = useMemo(
    () => groups.some((group) => group.candidates.some((candidate) => candidate.status === "running")),
    [groups],
  );

  // 有候选在跑时轻量轮询，跑完自动停
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => void load(cwd, true), 4000);
    return () => clearInterval(timer);
  }, [anyRunning, cwd, load]);

  const start = useCallback(async () => {
    if (!cwd || !prompt.trim()) return;
    setStarting(true);
    try {
      const res = await fetch("/api/candidates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start", cwd, prompt, count }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error || `启动失败（HTTP ${res.status}）`);
      toast(`已启动 ${count} 个候选，各自在独立工作区里跑`);
      setPrompt("");
      await load(cwd);
    } catch (error) {
      toast(error instanceof Error ? error.message : "启动失败");
    } finally {
      setStarting(false);
    }
  }, [cwd, prompt, count, load]);

  const adopt = useCallback(async (group: CandidateGroup, candidate: CandidateInfo) => {
    const ok = await dialogConfirm({
      title: "采用这个候选",
      message: `把「${candidate.branch}」相对基线（${group.baseCommit.slice(0, 7)}）的改动打回主工作区：\n`
        + `${candidate.changedFiles} 个文件 · +${candidate.additions} −${candidate.deletions}\n\n`
        + "只应用改动，不提交、不切换分支；主工作区若有冲突会原样报错。",
      confirmText: "采用",
    });
    if (!ok) return;
    setBusy(candidate.sessionId);
    try {
      const res = await fetch("/api/candidates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "adopt", groupId: group.id, sessionId: candidate.sessionId }),
      });
      const data = (await res.json()) as { error?: string; files?: string[] };
      if (!res.ok) throw new Error(data.error || `采用失败（HTTP ${res.status}）`);
      toast(`已应用 ${data.files?.length ?? 0} 个文件的改动到主工作区`);
    } catch (error) {
      toast(error instanceof Error ? error.message : "采用失败");
    } finally {
      setBusy(null);
    }
  }, []);

  const discard = useCallback(async (group: CandidateGroup, candidate: CandidateInfo) => {
    const ok = await dialogConfirm({
      title: "丢弃这个候选",
      message: `删除工作区和分支「${candidate.branch}」。候选里的改动会一并丢弃，此操作不可撤销。`,
      confirmText: "丢弃",
      danger: true,
    });
    if (!ok) return;
    setBusy(candidate.sessionId);
    try {
      const res = await fetch("/api/candidates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "discard", groupId: group.id, sessionId: candidate.sessionId }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error || `丢弃失败（HTTP ${res.status}）`);
      toast("已删除候选工作区");
      await load(cwd);
    } catch (error) {
      toast(error instanceof Error ? error.message : "丢弃失败");
    } finally {
      setBusy(null);
    }
  }, [cwd, load]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {/* 与其它页共用 page-col：之前它直接贴在窗口边缘（两侧 0 边距），
          与其余页的 32px 对齐不一致 */}
      <div className="page-col flex flex-col gap-3 py-6">
        <PageHeader
          icon={<FlaskConical size={16} />}
          title="并行试验"
          subtitle="同一句话同时开几个候选，各自在独立的 git 工作区里跑，跑完并排比改动"
        />
        <Card className="flex flex-col gap-3 p-4">
          <p className="text-[11px] leading-relaxed text-dim">
            每个候选都会真实消耗 token；采用只把改动打回主工作区，不提交、不切分支。
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-[12px] text-dim">
              项目
              <select
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                className="h-7 max-w-72 cursor-pointer rounded-md border border-line bg-panel-2 px-2 text-[12px] text-fg outline-none"
              >
                {!projects.some((project) => project.path === cwd) && cwd && (
                  <option value={cwd}>{cwd}</option>
                )}
                {projects.map((project) => (
                  <option key={project.path} value={project.path}>{project.name || project.path}</option>
                ))}
              </select>
            </label>

            <div className="flex items-center gap-1 text-[12px] text-dim">
              候选数
              {[2, 3].map((value) => (
                <button
                  key={value}
                  onClick={() => setCount(value)}
                  className={cn(
                    "flex size-6 cursor-pointer items-center justify-center rounded-md border text-[12px] tabular-nums t-fast",
                    count === value
                      ? "border-accent/50 bg-accent-soft text-accent"
                      : "border-line bg-panel-2 text-muted hover:text-fg",
                  )}
                >
                  {value}
                </button>
              ))}
            </div>

            <button
              onClick={() => void load(cwd)}
              className="btn btn-sm ml-auto"
              title="刷新候选与改动"
            >
              <RotateCw size={12} className={cn(loading && "anim-spin")} />
              刷新
            </button>
          </div>

          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            placeholder="要并行试试的任务，例如：把 lib/usage-aggregate.ts 的统计函数拆小，并为它补上单测"
            className="w-full resize-y rounded-lg border border-line bg-panel-2 px-2.5 py-2 text-[12px] leading-relaxed text-fg outline-none placeholder:text-dim focus:border-accent/60"
          />

          {repoInfo && !repoInfo.isGitRepo && cwd && (
            <p className="text-[12px] text-warn">该项目不是 git 仓库，无法建立隔离工作区。</p>
          )}

          <div className="flex items-center gap-2">
            <button
              onClick={() => void start()}
              disabled={starting || !prompt.trim() || !cwd || repoInfo?.isGitRepo === false}
              className="btn btn-primary btn-sm"
            >
              {starting ? <Loader2 size={12} className="anim-spin" /> : <Play size={12} />}
              {starting ? "正在建立工作区…" : `开 ${count} 个候选`}
            </button>
            <span className="text-[12px] text-dim">
              会创建 <span className="font-mono">elenva/&lt;组&gt;-N</span> 分支与对应工作区目录。
            </span>
          </div>
        </Card>

      {groups.length === 0 && !loading && (
        /* 空态不该只是一行提示：这页的入口只有顶部表单，第一次进来的人既不知道
           该写什么任务，也不知道「候选数」意味着什么。把下方近千像素的空白
           换成「这页怎么用 + 可直接点选的示例任务」。 */
        <Card className="px-6 py-10">
          <div className="mx-auto flex max-w-[620px] flex-col items-center text-center">
            <FlaskConical size={20} className="text-dim" />
            <div className="mt-3 text-[14px] font-semibold text-fg">还没有试验组</div>
            <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
              同一句话可以同时开几个候选，各自在独立的 git 工作区里跑，跑完并排比改动。
              每个候选都会真实消耗 token。
            </p>
            <div className="mt-7 w-full text-left">
              <div className="text-[12px] tracking-wide text-dim">可以这样用（点一下填进上面的输入框）</div>
              <div className="mt-2 flex flex-col gap-2">
                {CANDIDATE_EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    onClick={() => setPrompt(ex)}
                    className="t-fast flex w-full cursor-pointer items-start gap-2.5 rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-left text-[12px] text-muted hover:border-accent/40 hover:text-fg"
                  >
                    <span className="mt-[5px] size-1.5 shrink-0 rounded-full bg-accent/50" />
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </Card>
      )}

      {groups.map((group) => (
        <Card key={group.id}>
          <CardHeader>
            <GitBranch size={12} className="text-dim" />
            <span className="truncate text-[12px] text-fg" title={group.prompt}>{group.prompt}</span>
            <span className="ml-auto shrink-0 text-[11px] text-dim">
              基线 {group.baseCommit.slice(0, 7)} · {shortTime(group.createdAt)}
            </span>
          </CardHeader>
          <div className="px-4 py-3">
            <div className={cn("grid gap-2", group.candidates.length === 2 ? "md:grid-cols-2" : "md:grid-cols-3")}>
              {group.candidates.map((candidate) => (
                <div key={candidate.sessionId || candidate.branch} className="flex flex-col rounded-lg border border-line bg-panel-2/60 p-2.5">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-[12px] text-muted" title={candidate.branch}>
                      {candidate.branch}
                    </span>
                    <span
                      className={cn(
                        "chip ml-auto shrink-0",
                        candidate.status === "running" && "chip-accent",
                        candidate.status === "idle" && "chip-success",
                        candidate.status === "error" && "chip-danger",
                      )}
                    >
                      {candidate.status === "running" && <Loader2 size={10} className="anim-spin" />}
                      {candidate.status === "running" ? "运行中" : candidate.status === "idle" ? "已完成" : "失败"}
                    </span>
                  </div>

                  <div className="mt-1.5 flex items-center gap-2 text-[11px] text-dim">
                    <span className="tabular-nums">{candidate.changedFiles} 个文件</span>
                    <span className="tabular-nums text-success">+{candidate.additions}</span>
                    <span className="tabular-nums text-danger">−{candidate.deletions}</span>
                  </div>

                  <p className="mt-1.5 line-clamp-4 whitespace-pre-wrap text-[12px] leading-relaxed text-muted">
                    {candidate.error ?? candidate.summary ?? (candidate.status === "running" ? "正在处理…" : "没有产出文字结论")}
                  </p>

                  <div className="mt-auto flex items-center gap-1.5 pt-2.5">
                    <button
                      onClick={() => onOpenSession?.(candidate.sessionId)}
                      disabled={!candidate.sessionId || !onOpenSession}
                      className="btn btn-sm"
                      title="打开这个候选的完整会话"
                    >
                      查看会话
                    </button>
                    <button
                      onClick={() => void adopt(group, candidate)}
                      disabled={busy === candidate.sessionId || candidate.status === "running" || candidate.changedFiles === 0}
                      className="btn btn-primary btn-sm"
                      title="把该候选的改动打回主工作区"
                    >
                      {busy === candidate.sessionId ? <Loader2 size={12} className="anim-spin" /> : <Upload size={12} />}
                      采用
                    </button>
                    <button
                      onClick={() => void discard(group, candidate)}
                      disabled={busy === candidate.sessionId}
                      className="btn btn-sm btn-ghost ml-auto text-danger"
                      title="删除工作区与分支"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Card>
      ))}
      </div>
    </div>
  );
}
