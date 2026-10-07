/**
 * elenva-comfyui —— 给 Elen 补上「本机生图」：调用本机 ComfyUI（默认 Flux 工作流）出图。
 *
 * 为什么是扩展：pi 内置的生图通道只对接 OpenRouter（云）；本机 ComfyUI 没有现成通道，
 * 用扩展注册一个 generate_image 工具即可——工具结果按 pi 的 ImageContent 约定返回，
 * 图片随会话保存、在网页对话里渲染（非视觉模型会自动跳过图片输入，不影响对话）。
 *
 * 安装：node extensions/elenva-comfyui/install.mjs
 * 配置：<agentRoot>/comfyui.json（可选；见 README.md）
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { generateViaComfyUI, loadConfig } from "./comfy.js";

const TOOL_NAME = "generate_image";

export default function elenvaComfyUI(pi: ExtensionAPI): void {
  pi.registerTool({
    name: TOOL_NAME,
    label: "生成图片",
    description:
      "调用本机 ComfyUI（Flux）按提示词生成图片，结果以图片形式返回并在对话中展示。适合需要出图的任务（配图、封面、示意图等）。提示词写具体（英文通常效果更好）；生成一般需要 10–60 秒，同一请求不要重复调用。失败时优先检查本机 ComfyUI 是否在运行。",
    promptSnippet: "调用本机 ComfyUI 生成图片（默认 Flux）",
    promptGuidelines: [
      "用户要求生成/画图/出图时调用 generate_image；提示词写具体、描述性的内容（英文提示词通常效果更好）。",
      "生成耗时 10–60 秒属正常；同一请求不要重复提交。",
      "报「连不上 ComfyUI」时告诉用户：请确认本机 ComfyUI 正在运行（默认 127.0.0.1:8188）。",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "图片内容描述（越具体越好；英文效果通常更好）" }),
      width: Type.Optional(Type.Number({ description: "图片宽度（默认 1024）" })),
      height: Type.Optional(Type.Number({ description: "图片高度（默认 1024）" })),
      seed: Type.Optional(Type.Number({ description: "随机种子；不传则随机" })),
    }),
    execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
      const config = loadConfig();
      const result = await generateViaComfyUI({
        prompt: params.prompt,
        width: params.width,
        height: params.height,
        seed: params.seed,
        config,
        signal,
      });
      return {
        content: [
          {
            type: "text",
            text: `已生成图片（${result.width}×${result.height}，seed ${result.seed}，用时 ${(result.elapsedMs / 1000).toFixed(1)}s）。副本已存到 ${result.savedPath}；ComfyUI 输出文件名 ${result.filename}。`,
          },
          { type: "image", data: result.imageBase64, mimeType: result.mimeType },
        ],
        details: {
          promptId: result.promptId,
          filename: result.filename,
          savedPath: result.savedPath,
          seed: result.seed,
          width: result.width,
          height: result.height,
          elapsedMs: result.elapsedMs,
        },
      };
    },
  });
}
