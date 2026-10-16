import { NextResponse } from "next/server";
import { buildHostPrompt, hostPromptSections, type HostPromptSection } from "@/lib/host-prompt";
import { previewIdentityText } from "@/lib/identity";

export const dynamic = "force-dynamic";

/** 装配位置元数据（GET 响应里的常量部分） */
const PLACEMENT = [
  { id: "base", label: "pi 基座（角色 + 工具 + Guidelines）", owner: "pi 内核" },
  { id: "host", label: "宿主层：身份 + 能力 + 环境事实（本文件）", owner: "ELENVA" },
  { id: "docs", label: "pi 文档指针", owner: "pi 内核" },
  { id: "project", label: "<cwd>/AGENTS.md", owner: "项目 / 用户手写" },
  { id: "skills", label: "技能索引 + cwd", owner: "按已装技能生成" },
];

/** 项目级/用户级还有两个文件式插槽，不需要改代码 */
const FILE_SLOTS = [
  { path: "~/.pi/agent/APPEND_SYSTEM.md", scope: "本机所有项目", trusted: false },
  { path: "<项目>/.pi/APPEND_SYSTEM.md", scope: "该项目（需信任）", trusted: true },
];

function view(sections: readonly HostPromptSection[]) {
  const assembled = buildHostPrompt(sections);
  return {
    assembled,
    totalChars: assembled.length,
    sections: sections.map((section) => ({
      id: section.id,
      rationale: section.rationale,
      relatedTo: section.relatedTo,
      text: section.text,
      chars: section.text.length,
    })),
    placement: PLACEMENT,
    fileSlots: FILE_SLOTS,
  };
}

/**
 * GET /api/host-prompt —— 宿主提示词的可读视图。
 *
 * 这一层每轮都注入、每个会话都有，所以它必须**看得见**：改了什么、为什么留、多长，
 * 都在这里一次看全。设置页拿它渲染只读视图；调试时也用它确认内核实际拿到什么。
 *
 * 身份段（`id: "identity"`）的正文来自受管文件（见 lib/identity.ts），其余段是代码里的静态文本。
 */
export async function GET() {
  return NextResponse.json(view(hostPromptSections()), { headers: { "Cache-Control": "no-store" } });
}

/**
 * POST /api/host-prompt —— 生效预览。
 *
 * body: { identitySections: [{ id, title, body }] }
 *
 * 用**与真实会话相同的装配路径**（`buildHostPrompt`）把候选身份段拼进宿主层，返回
 * 「下次新会话将看到的宿主层」。不落盘、不启动会话 —— 只算字符串。
 * 只覆盖宿主层这一块：基座 / 项目 AGENTS.md / 技能索引不在预览里（完整提示词见「提示词」页；
 * 那边对从未跑过的项目 preview 会返回空串，所以这里直接用装配函数而不是复用那个接口）。
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { identitySections?: unknown };
    const identityText = previewIdentityText(body.identitySections);
    const sections = hostPromptSections().map((section) =>
      section.id === "identity" ? { ...section, text: identityText } : section,
    );
    return NextResponse.json(
      { ...view(sections), identityText, note: "新建会话生效，已打开的会话不回溯" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
