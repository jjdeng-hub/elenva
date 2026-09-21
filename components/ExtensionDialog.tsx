"use client";

import { useState } from "react";
import { Check, Puzzle } from "lucide-react";
import { cn } from "@/components/lib/utils";
import { Markdown } from "@/components/MessageView";
import type { ExtensionUiDialogRequest } from "@/hooks/useAgentSession";

/**
 * 扩展交互对话框：扩展通过 Extension UI 协议请求的 select / confirm / input。
 * editor 方法以多行输入降级支持；custom 自定义 UI 不在此处理。
 *
 * ## 两种内容形态，两套排版
 *
 * 宿主扩展会在标题换行后的部分塞两类完全不同的东西：
 *
 *  · **文档**（计划正文）：长、带 markdown 结构，用户要**读懂**它 —— ×　宽弹窗 + markdown 渲染。
 *  · **命令 / 路径**（危险操作确认）：短、需要逐字核对 —— 窄弹窗 + 等宽字体，宽屏反而
 *    让 `rm -rf ./build` 这种短字符串散在中间更难看清。
 *
 * 判据是内容本身（长度 + markdown 特征）而不是方法名：`select` 两种都会用。
 * 之前一律 400px + 等宽 pre，计划正文被压成一条窄柱、`##` 与 `-` 原样显示 —— 就是
 * 「内容很紧密、格式没渲染」的来源。
 */
export function ExtensionDialog({
  request,
  onRespond,
}: {
  request: ExtensionUiDialogRequest;
  onRespond: (
    request: ExtensionUiDialogRequest,
    response: { value: string } | { confirmed: boolean } | { cancelled: true },
  ) => void | Promise<void>;
}) {
  const [text, setText] = useState((request as { prefill?: string }).prefill ?? "");
  const multi = request.method === "editor";
  // 标题只取第一行；其余按多行正文渲染（单行截断会让用户看不到自己在批准什么）
  const [titleLine, ...titleRest] = request.title.split("\n");
  const detail = [titleRest.join("\n").trim(), request.method === "confirm" ? request.message : ""]
    .filter(Boolean)
    .join("\n\n");

  /** 文档型内容：长，或带明显的 markdown 结构 */
  const isDocument = detail.length > 240
    || /(^|\n)#{1,4} /.test(detail)
    || /(^|\n)\s*[-*] /.test(detail)
    || /(^|\n)\s*\d+\. /.test(detail)
    || detail.includes("```");

  const options = request.method === "select" ? (request.options ?? []) : [];
  /** 选项少 → 底部按钮行（计划批准就是三个动作）；选项多 → 竖排列表更适合扫读 */
  const asActionRow = options.length > 0 && options.length <= 3;

  const cancel = () => void onRespond(request, { cancelled: true });

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-[110] flex items-center justify-center bg-overlay p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
      data-testid="extension-dialog"
    >
      <div
        className={cn(
          "flex max-h-[86vh] flex-col overflow-hidden rounded-card border border-line bg-panel shadow-lg",
          isDocument ? "w-[min(880px,94vw)]" : "w-[420px] max-w-full",
        )}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-line-soft px-4 py-2.5">
          <Puzzle size={12} className="shrink-0 text-accent" />
          <span className="truncate text-[13px] font-semibold text-fg">{titleLine}</span>
          <span className="ml-auto shrink-0 rounded-md bg-panel-2 px-1.5 py-0.5 text-[10px] text-dim">扩展</span>
        </div>

        {/* 内容区独立滚动：计划可以很长，操作按钮不能被顶出视口 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {detail && (
            isDocument ? (
              <div className="md-body text-[13px] leading-relaxed text-fg">
                <Markdown text={detail} />
              </div>
            ) : (
              <p className="whitespace-pre-wrap break-words rounded-lg border border-line bg-panel-2 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-muted">
                {detail}
              </p>
            )
          )}

          {!asActionRow && options.length > 0 && (
            <div className="flex flex-col gap-1">
              {options.map((opt) => (
                <button
                  key={opt}
                  onClick={() => void onRespond(request, { value: opt })}
                  className="cursor-pointer rounded-lg border border-line bg-panel-2 px-3 py-1.5 text-left text-[12px] text-fg t-fast hover:border-accent/50 hover:bg-hover"
                >
                  {opt}
                </button>
              ))}
            </div>
          )}

          {(request.method === "input" || multi) && (
            multi ? (
              <textarea
                autoFocus
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={6}
                className="w-full resize-y rounded-lg border border-line bg-panel-2 px-2.5 py-2 font-mono text-[12px] text-fg outline-none focus:border-accent/60"
              />
            ) : (
              <input
                autoFocus
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    void onRespond(request, { value: text });
                  }
                }}
                placeholder={request.placeholder}
                className="h-9 w-full rounded-lg border border-line bg-panel-2 px-2.5 text-[12px] text-fg outline-none focus:border-accent/60"
              />
            )
          )}
        </div>

        {/* 底部动作区：常显、不滚动。select 的短选项也收在这里 */}
        {(asActionRow || request.method === "confirm" || request.method === "input" || multi) && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line-soft bg-panel-2/60 px-4 py-2.5">
            {(request.method !== "select") && (
              <button
                onClick={cancel}
                className="h-7.5 cursor-pointer rounded-lg border border-line bg-panel px-3 text-[12px] text-muted t-fast hover:text-fg"
              >
                取消
              </button>
            )}
            {asActionRow && options.map((opt, index) => (
              <button
                key={opt}
                onClick={() => void onRespond(request, { value: opt })}
                data-testid={index === 0 ? "extension-primary" : undefined}
                className={cn(
                  "h-7.5 cursor-pointer rounded-lg px-3.5 text-[12px] t-fast",
                  index === 0
                    ? "bg-accent font-medium text-accent-fg hover:bg-accent-hover"
                    : "border border-line bg-panel text-muted hover:text-fg",
                )}
              >
                {index === 0 && <Check size={12} className="mr-1 inline align-[-2px]" />}
                {opt}
              </button>
            ))}
            {request.method === "confirm" && (
              <button
                data-testid="extension-confirm"
                onClick={() => void onRespond(request, { confirmed: true })}
                className="h-7.5 cursor-pointer rounded-lg bg-accent px-3.5 text-[12px] font-medium text-accent-fg t-fast hover:bg-accent-hover"
              >
                确认
              </button>
            )}
            {(request.method === "input" || multi) && (
              <button
                onClick={() => void onRespond(request, { value: text })}
                className="h-7.5 cursor-pointer rounded-lg bg-accent px-3.5 text-[12px] font-medium text-accent-fg t-fast hover:bg-accent-hover"
              >
                确定
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
