/**
 * ELENVA 技能沉淀 —— 把会话里「值得留」的做法一键起草成技能，人工确认后入库。
 *
 * ## 它在补什么
 *
 * 会话里经常出现「这段做法值得留」的时刻（用户纠正、摸索出的流程、踩坑解法），
 * 但沉淀成技能只能手工开文件写 SKILL.md。这个扩展提供 `skill_draft` 工具：
 * 模型把做法整理成 `{name, description, body}`，**只出草稿、不写任何文件**，
 * 由网页侧渲染成草稿卡，用户点「保存到技能库」后才经 `POST /api/skills/draft/save`
 * 落到 `~/.pi/agent/skills/<name>/SKILL.md`（重名不覆盖，见该路由）。
 *
 * 与内置技能的分工：内置技能是随仓库分发的通用起步技能；本扩展沉淀的是
 * **个人在真实会话里踩出来的做法**，落在 agent 目录的技能库里。
 *
 * 安装：`node extensions/elenva-skills/install.mjs`（复制到 `<agentRoot>/extensions/elenva-skills/`）。
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SKILL_DRAFT_NAME_MAX, validateSkillDraft } from "./draft.js";

export default function elenvaSkills(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "skill_draft",
    label: "技能草稿",
    description:
      "把一个可复用的做法整理成技能草稿（SKILL.md 的 name / description / body）。只起草，不写任何文件；用户会在界面上确认后保存到技能库。适合在用户说「这个值得记下来」「沉淀成技能」或纠正出一套可复用流程时调用。",
    promptSnippet: "Draft a reusable skill (SKILL.md) for the user to confirm and save",
    promptGuidelines: [
      "整理成可复用的做法（不是复述这一次的具体内容）：提炼触发条件、步骤、坑与验证方式。",
      "name 用小写字母 / 数字 / 连字符、≤64；description 一句话说清「何时用这个技能」；body 写完整 SKILL.md 正文（markdown，含标题与分节）。",
      "skill_draft 只出草稿，不会写文件；保存由用户在界面上点「保存到技能库」，不要试图自己写 SKILL.md。",
    ],
    parameters: Type.Object({
      name: Type.String({
        description: `技能名：小写字母 / 数字 / 连字符，以字母数字开头结尾，长度 ≤ ${SKILL_DRAFT_NAME_MAX}（例：debug-node-esm）`,
      }),
      description: Type.String({
        description: "一句话说明「何时用这个技能」（写进 SKILL.md frontmatter，供技能列表与模型选用）",
      }),
      body: Type.String({
        description:
          "SKILL.md 正文（markdown，含 # 标题与分节：何时使用 / 步骤 / 坑 / 验证方式 等）。不要包含 frontmatter。",
      }),
    }),
    execute: async (_toolCallId, params) => {
      const result = validateSkillDraft(params);
      if (!result.ok) {
        throw new Error(`技能草稿未生成：${result.error}。请修正后重新调用 skill_draft。`);
      }
      const { draft } = result;
      return {
        content: [
          {
            type: "text",
            text: [
              "技能草稿已生成，等待人工确认（不会自动写入技能库）。",
              `name: ${draft.name}`,
              `description: ${draft.description}`,
              "",
              "用户在消息卡上点「保存到技能库」后才会落盘；在那之前不要自行写 SKILL.md。",
            ].join("\n"),
          },
        ],
        details: {
          kind: "elenva-skill-draft",
          name: draft.name,
          description: draft.description,
          body: draft.body,
        },
      };
    },
  });
}
