import type {
  AssistantMessage,
  AgentMessage,
  ThinkingContent,
  ToolCallContent,
  ToolResultMessage,
  UserMessage,
} from "@/lib/types";

/** 一轮对话的界面状态：已完结的消息 + 正在流式输出的那一条 */
export type AcpChatState = {
  messages: AgentMessage[];
  streaming: AssistantMessage | null;
};

/**
 * ACP 事件 → ELENVA 会话模型（lib/types 的 AgentMessage）。
 *
 * 为什么要有这一层：ELENVA 的会话界面（ChatWindow / MessageView / ChatInput / ModelPicker）
 * 是照 Pi 的消息模型写的。Hermes 走 ACP，事件形态不一样，所以把 ACP 的
 * session/update 流翻译成同一套 AgentMessage，界面就能原样复用——
 * 换 Agent 不用换界面，工具卡、diff、思考块、审批都是同一套。
 */

const TOOL_NAME_ALIASES: Record<string, string> = {
  // Hermes 的工具名对齐 Pi 的内置名，MessageView 的图标/差异渲染才认得
  write_file: "write",
  read_file: "read",
  list_dir: "ls",
  search_files: "grep",
  terminal: "bash",
  execute_code: "bash",
};

export function normalizeToolName(raw: string): string {
  const name = (raw || "").trim().toLowerCase();
  return TOOL_NAME_ALIASES[name] ?? name;
}

/** 工具标题形如 `write_file: /path/to/file` —— 冒号前是工具名 */
function toolNameFromTitle(title: string): string {
  const head = title.split(":")[0]?.trim() ?? "";
  return normalizeToolName(head || "tool");
}

function textOf(message: { content: unknown }): string {
  if (typeof message.content === "string") return message.content;
  return "";
}

/** 往 assistant 的内容里追加一段文本/思考，合并同类相邻块 */
function appendBlock(
  message: AssistantMessage,
  block: { type: "text"; text: string } | ThinkingContent,
): AssistantMessage {
  const content = [...message.content];
  const last = content[content.length - 1];
  if (last && last.type === block.type) {
    if (block.type === "text" && last.type === "text") {
      content[content.length - 1] = { type: "text", text: last.text + block.text };
    } else if (block.type === "thinking" && last.type === "thinking") {
      content[content.length - 1] = { type: "thinking", thinking: last.thinking + block.thinking };
    }
  } else {
    content.push(block);
  }
  return { ...message, content };
}

export function emptyAssistant(ctx: { provider: string; modelId: string }): AssistantMessage {
  return { role: "assistant", content: [], model: ctx.modelId, provider: ctx.provider };
}

/** 用户那句话：能合并就合并（流式回显是一段段来的） */
export function appendUserText(state: AcpChatState, text: string): AcpChatState {
  if (!text) return state;
  const messages = [...state.messages];
  const last = messages[messages.length - 1];
  if (last && last.role === "user") {
    const previous = textOf(last as UserMessage);
    messages[messages.length - 1] = { ...last, content: previous + text } as UserMessage;
  } else {
    messages.push({ role: "user", content: text, timestamp: Date.now() });
  }
  return { ...state, messages };
}

export function appendAssistantText(state: AcpChatState, text: string, ctx: { provider: string; modelId: string }): AcpChatState {
  if (!text) return state;
  const base = state.streaming ?? emptyAssistant(ctx);
  return { ...state, streaming: appendBlock(base, { type: "text", text }) };
}

export function appendThinkingText(state: AcpChatState, text: string, ctx: { provider: string; modelId: string }): AcpChatState {
  if (!text) return state;
  const base = state.streaming ?? emptyAssistant(ctx);
  return { ...state, streaming: appendBlock(base, { type: "thinking", thinking: text }) };
}

export function addToolCall(
  state: AcpChatState,
  tool: { id: string; title: string; kind?: string; locations?: string[]; diff?: { oldText: string; newText: string } },
  ctx: { provider: string; modelId: string },
): AcpChatState {
  const base = state.streaming ?? emptyAssistant(ctx);
  const name = toolNameFromTitle(tool.title);
  const path = tool.locations?.[0];
  const input: Record<string, unknown> = {};
  if (path) input.path = path;
  if (tool.diff) {
    input.oldText = tool.diff.oldText;
    input.newText = tool.diff.newText;
    // write 类工具用 content 全量渲染，edit 类用 old/new 对比
    input.content = tool.diff.newText;
  }
  const block: ToolCallContent = { type: "toolCall", toolCallId: tool.id, toolName: name, input };
  const content = [...base.content];
  if (!content.some((item) => item.type === "toolCall" && item.toolCallId === tool.id)) content.push(block);
  return { ...state, streaming: { ...base, content } };
}

export function addToolResult(
  state: AcpChatState,
  result: { id: string; title: string; output?: string; failed?: boolean; diff?: { path?: string; oldText: string; newText: string } },
): AcpChatState {
  if (state.messages.some((message) => message.role === "toolResult" && message.toolCallId === result.id)) {
    return state;
  }
  const message: ToolResultMessage = {
    role: "toolResult",
    toolCallId: result.id,
    toolName: toolNameFromTitle(result.title),
    content: result.output ? [{ type: "text", text: result.output }] : [],
    isError: Boolean(result.failed),
    timestamp: Date.now(),
    ...(result.diff ? { details: { diff: toPiDiff(result.diff.oldText, result.diff.newText) } } : {}),
  };
  return { ...state, messages: [...state.messages, message] };
}

/** Pi 的展示 diff 只认「±行」；这里把 old/new 转成同一形态，复用同一个 DiffBlock */
export function toPiDiff(oldText: string, newText: string): string {
  const oldLines = oldText.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const newLines = newText.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  const lines: string[] = [];
  for (let index = start; index < oldEnd; index += 1) lines.push(`-${oldLines[index]}`);
  for (let index = start; index < newEnd; index += 1) lines.push(`+${newLines[index]}`);
  return lines.join("\n");
}

/** 一轮结束：把流式的 assistant 收进历史 */
export function sealTurn(state: AcpChatState): AcpChatState {
  if (!state.streaming) return state;
  const hasContent = state.streaming.content.length > 0;
  return {
    messages: hasContent ? [...state.messages, state.streaming] : state.messages,
    streaming: null,
  };
}

/** Hermes state.db 的一行消息（lib/agents/resources.ts 的 HermesMessage，这里按结构接受） */
export type HermesDbRecord = {
  role: string;
  text?: string;
  at?: string;
  toolCalls?: { id: string; toolName: string; input?: string; output?: string; isError?: boolean }[];
};

/**
 * Hermes state.db 的消息行 → ELENVA 会话模型。
 *
 * assistant 行可能同时带正文与 tool_calls：先出 assistant（文本 + 工具卡），
 * 每张卡后面跟一条 toolResult（结果正文在 resources 层已拼好）。没有结果时
 * 工具卡照样渲染，点开为空 —— 不编造。
 */
export function hermesDbToMessages(
  records: HermesDbRecord[],
  ctx: { provider: string; modelId: string },
): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (const record of records) {
    const ts = record.at ? new Date(record.at).getTime() : undefined;
    if (record.role === "user") {
      messages.push({ role: "user", content: record.text ?? "", timestamp: ts });
      continue;
    }
    if (record.role !== "assistant" || (!record.text && !(record.toolCalls && record.toolCalls.length > 0))) continue;

    const content: (ToolCallContent | { type: "text"; text: string })[] = [];
    if (record.text) content.push({ type: "text", text: record.text });
    const calls: ToolCallContent[] = [];
    for (const call of record.toolCalls ?? []) {
      let input: Record<string, unknown> = {};
      if (call.input) {
        try {
          const parsed = JSON.parse(call.input) as unknown;
          if (parsed && typeof parsed === "object") input = parsed as Record<string, unknown>;
        } catch {
          input = { raw: call.input };
        }
      }
      const block: ToolCallContent = {
        type: "toolCall",
        toolCallId: call.id,
        toolName: normalizeToolName(call.toolName),
        input,
      };
      content.push(block);
      calls.push(block);
    }
    messages.push({
      role: "assistant",
      content,
      model: ctx.modelId,
      provider: ctx.provider,
      timestamp: ts,
    });
    for (const call of calls) {
      messages.push({
        role: "toolResult",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        content: [],
        isError: false,
      });
    }
  }
  return messages;
}
