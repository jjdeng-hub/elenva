"use client";

import { ChevronRight, Loader2, RefreshCw, ScrollText } from "lucide-react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { MemoryProject } from "@/components/MemoryPage";
import { cn } from "@/components/lib/utils";
import { EmptyState, PageHeader } from "@/components/ui/bits";
import { toast } from "@/components/ui/dialog";
import { CopyButton } from "@/components/ui/widgets";
import { basename } from "@/lib/format";

type PromptSource = "live" | "preview";

type PromptPayload = {
  cwd: string;
  source: PromptSource;
  sessionId?: string;
  prompt: string;
  generatedAt: string;
  error?: string;
};

/**
 * 提示词页：按项目查看「模型每轮实际看到的完整内容」。
 *
 * 数据有两种来源，页内必须说清楚（同一项目两次打开内容不一样时，用户得知道为什么）：
 *  - live：该项目有已加载会话 → 读它最近一次运行实际使用的版本，含扩展每轮注入（记忆、计划模式）。
 *  - preview：没有在线会话 → 用与真实会话相同的装配路径现场组装基础版本。
 * 读取逻辑在 lib/agent-runtime.ts 的 readLiveAgentSystemPrompt / buildAgentSystemPromptPreview。
 */
export function SystemPromptPage({
  defaultCwd,
  projects,
}: {
  defaultCwd: string | null;
  projects: MemoryProject[];
}) {
  // 项目候选项：会话聚合出的项目 + 默认工作区（后者可能不在项目列表里）
  const options = useMemo(() => {
    const seen = new Set<string>();
    const list: MemoryProject[] = [];
    for (const project of projects) {
      if (seen.has(project.path)) continue;
      seen.add(project.path);
      list.push(project);
    }
    if (defaultCwd && !seen.has(defaultCwd)) {
      list.unshift({ name: basename(defaultCwd), path: defaultCwd });
    }
    return list;
  }, [projects, defaultCwd]);

  const [cwd, setCwd] = useState("");
  const [data, setData] = useState<PromptPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // 项目列表异步到达后补默认选中（深链直接进本页时，挂载时还是空数组）
  useEffect(() => {
    setCwd((prev) => prev || options[0]?.path || "");
  }, [options]);

  const load = useCallback(async (dir: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/system-prompt?cwd=${encodeURIComponent(dir)}`, { cache: "no-store" });
      const payload = (await res.json()) as PromptPayload;
      if (!res.ok) throw new Error(payload.error || `读取失败（HTTP ${res.status}）`);
      setData(payload);
    } catch (e) {
      setData(null);
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      toast(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!cwd) return;
    setData(null);
    void load(cwd);
  }, [load, cwd, reloadKey]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="page-col-form py-6">
        <PageHeader
          icon={<ScrollText size={16} />}
          title="提示词"
          subtitle="模型每轮实际看到的完整内容（按项目）"
          actions={
            <>
              {options.length > 0 && (
                <select
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                  className="h-7 max-w-72 cursor-pointer rounded-lg border border-line bg-panel-2 px-2 text-[12px] text-fg outline-none t-fast focus:border-accent/60"
                >
                  {options.map((project) => (
                    <option key={project.path} value={project.path}>
                      {project.name}
                    </option>
                  ))}
                </select>
              )}
              <button
                onClick={() => setReloadKey((n) => n + 1)}
                disabled={loading || !cwd}
                className="btn btn-ghost"
              >
                <RefreshCw size={12} className={loading ? "anim-spin" : undefined} /> 重新读取
              </button>
            </>
          }
        />

        {options.length === 0 ? (
          <EmptyState
            icon={<ScrollText size={20} />}
            title="还没有可查看的项目"
            hint="打开一个会话，或在工作台新建项目后回来。"
          />
        ) : (
          <div className="flex flex-col gap-3">
            <div className="rounded-lg border border-line-soft bg-panel-2 px-3 py-2 text-[11px] leading-relaxed text-dim">
              {data?.source === "live" ? (
                <>
                  来自正在运行的会话 —— 这是它<span className="text-fg">最近一次运行实际使用</span>的版本，
                  含扩展每轮注入的内容（记忆、计划模式等）。
                </>
              ) : (
                <>
                  这是<span className="text-fg">基础组装结果</span>：新会话启动时会得到的内容。
                  运行中的会话还会在此基础上注入记忆、计划模式等 —— 打开一个会话后回到本页即可看到实际版本。
                </>
              )}
              <div className="mt-1">
                组装顺序：pi 基座（身份 + 工具 + 约束）→{" "}
                {/* 宿主层是 ELENVA 自己加的那一段，解释与维护口径在设置页 */}
                <a href="#settings" className="text-accent t-fast hover:underline">宿主层</a>
                {" "}→ 项目指令（AGENTS.md 等）→ 技能索引 → 工作目录。
              </div>
            </div>

            <Card>
              <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-4 py-2.5">
                {data && (
                  <span
                    className={cn("chip", data.source === "live" && "chip-accent")}
                    title={data.sessionId ? `会话 ${data.sessionId}` : undefined}
                  >
                    {data.source === "live" ? "实时会话" : "基础预览"}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-dim" title={data?.cwd ?? cwd}>
                  {data?.cwd ?? cwd}
                </span>
                {data && (
                  <span className="flex shrink-0 items-center gap-3 text-[11px] tabular-nums text-dim">
                    <span>{data.prompt.length} 字符</span>
                    <span>{data.prompt.split("\n").length} 行</span>
                    <CopyButton text={data.prompt} />
                  </span>
                )}
              </div>
              <div className="px-4 py-3">
                {loading && !data ? (
                  <div className="flex items-center gap-2 py-8 text-[12px] text-dim">
                    <Loader2 size={14} className="anim-spin" /> 正在组装…
                  </div>
                ) : error ? (
                  <div className="py-8 text-[12px] text-warn">{error}</div>
                ) : data ? (
                  /* 限宽 76ch：之前整块铺到 137 字符/行 —— 系统提示词是要逐句核对的东西，
                     行太长会丢行。mono 字体下 76ch ≈ 满屏的 2/3，长行仍可折行不截断。 */
                  <pre className="max-w-[76ch] whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-fg">
                    {data.prompt}
                  </pre>
                ) : null}
              </div>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
