import { NextResponse } from "next/server";
import { HOST_PROMPT_SECTIONS, buildHostPrompt } from "@/lib/host-prompt";

export const dynamic = "force-dynamic";

/**
 * GET /api/host-prompt —— 宿主提示词的可读视图。
 *
 * 这一层每轮都注入、每个会话都有，所以它必须**看得见**：改了什么、为什么留、多长，
 * 都在这里一次看全。设置页拿它渲染只读视图；调试时也用它确认内核实际拿到什么。
 */
export async function GET() {
  const assembled = buildHostPrompt();
  return NextResponse.json(
    {
      assembled,
      totalChars: assembled.length,
      sections: HOST_PROMPT_SECTIONS.map((section) => ({
        id: section.id,
        rationale: section.rationale,
        relatedTo: section.relatedTo,
        text: section.text,
        chars: section.text.length,
      })),
      /** 装配位置：内核 system-prompt.js 把这一层插在基座之后、项目上下文之前 */
      placement: [
        { id: "base", label: "pi 基座（角色 + 工具 + Guidelines）", owner: "pi 内核" },
        { id: "host", label: "宿主层：身份 + 能力 + 环境事实（本文件）", owner: "ELENVA" },
        { id: "docs", label: "pi 文档指针", owner: "pi 内核" },
        { id: "project", label: "<cwd>/AGENTS.md", owner: "项目 / 用户手写" },
        { id: "skills", label: "技能索引 + cwd", owner: "按已装技能生成" },
      ],
      /** 项目级/用户级还有两个文件式插槽，不需要改代码 */
      fileSlots: [
        { path: "~/.pi/agent/APPEND_SYSTEM.md", scope: "本机所有项目", trusted: false },
        { path: "<项目>/.pi/APPEND_SYSTEM.md", scope: "该项目（需信任）", trusted: true },
      ],
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
