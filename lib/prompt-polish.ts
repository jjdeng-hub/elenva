/**
 * 提示词优化 —— 把用户草稿改写成「目标 / 背景 / 约束 / 期望产出」齐全的可执行提示词。
 *
 * 依据《深入理解 AI Agent》ch2 提示工程一节：
 * - **L606**：系统提示词的设计标准是「一个聪明的新员工读完能不能知道该怎么做」——
 *   用户发给 Agent 的提示词同理：含糊的指令会让 Agent 只能靠猜。
 * - **L682-684**：模糊的规则会导致行为极不稳定，必须「明确到可执行的程度」；
 *   优化器要做的就是在不改变原意的前提下把草稿补到可执行。
 * - **L616**：结构化标签（如 `<original_prompt>`）携带语义、减少理解偏差。
 *
 * 实现方式与 generateSessionTitle 同款：借源会话的模型 / 鉴权 / 传输，
 * 起一个一次性的临时 Agent（无工具、空历史、专用系统提示），不污染源会话。
 */
import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { buildSessionTitleAgentOptions } from "./session-title";

const POLISH_TIMEOUT_MS = 60_000;
/** 结果硬上限：正常草稿优化远小于此；防御模型跑飞 */
const MAX_POLISHED_LENGTH = 12_000;

const POLISH_SYSTEM_PROMPT = `你是「提示词优化器」。用户会给你一段他准备发给一个编程 Agent（名叫 Elen，能读写文件、执行命令、访问网络）的草稿。你的任务：在完全不改变用户原意的前提下，把它改写成一个清晰、具体、可执行的提示词。

原则：
- 保留用户的语言（中文就中文）、语气与全部具体要求；不新增用户没有表达过的需求、事实或约束。
- 补齐让 Agent 不产生误解所需的要素：目标（要达成什么）、背景（为什么要做 / 现状）、范围与约束（改哪里、不要动什么）、期望产出（交付物形态、怎么算完成）。
- 把含糊的词（「优化一下」「弄好看点」「那个」）就地替换为可执行的描述；不确定的地方不要编造——保持克制，宁少勿多。
- 如果原稿极短（只有几个词），把它扩充为一段完整但克制的指令；不替用户做他没提的重大决定。
- 只输出优化后的提示词本身：不要解释、不要评论、不要前后缀、不要用代码块包裹、不要向用户提问。`;

export interface PolishedPrompt {
  polished: string;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

function buildPolishUserMessage(text: string): string {
  return `请优化下面这段提示词（只输出优化后的提示词本身）：\n<original_prompt>\n${text}\n</original_prompt>`;
}

/** 从临时 Agent 的新增消息里取最后一条助手文本；模型报错原样抛出。 */
function extractPolishedText(agent: Agent): string {
  const messages = agent.state.messages;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    if (message.stopReason === "error") {
      throw new Error(message.errorMessage || "优化请求失败");
    }
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (!text) continue;
    return text;
  }
  throw new Error("模型没有返回优化结果");
}

/**
 * 输出清洗：整段被代码块包裹时剥一层；去掉「优化后：」这类标签前缀。
 * 只剥离最外层、只在确实是包裹时剥——用户草稿本身的代码块不受影响。
 */
export function parsePolishedPrompt(raw: string): string {
  let value = raw.trim();
  const fenced = value.match(/^```[a-z]*\s*\n([\s\S]*?)\n?```$/i);
  if (fenced) value = fenced[1].trim();
  value = value.replace(/^(?:优化后的?提示词|优化结果|polished\s*prompt|optimized\s*prompt)\s*[:：-]\s*/i, "").trim();
  if (!value) throw new Error("模型返回的优化结果为空");
  return value.length > MAX_POLISHED_LENGTH ? value.slice(0, MAX_POLISHED_LENGTH) : value;
}

export async function polishUserPrompt(source: AgentSession, text: string): Promise<PolishedPrompt> {
  const sourceAgent = source.agent;
  const options = buildSessionTitleAgentOptions(sourceAgent);

  // 一次性 Agent：空历史、无工具、专用系统提示（不继承源会话的 transformContext，
  // 那份会强制注入运行时的系统提示，覆盖掉这里的优化器指令）。
  options.initialState = {
    systemPrompt: POLISH_SYSTEM_PROMPT,
    model: sourceAgent.state.model,
    thinkingLevel: "off",
    tools: [],
    messages: [],
  };
  options.transformContext = undefined;
  options.convertToLlm = undefined;

  const agent = new Agent(options);
  const runPromise = agent.prompt(buildPolishUserMessage(text));
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      runPromise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          agent.abort();
          reject(new Error("提示词优化超时（60 秒）"));
        }, POLISH_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    agent.abort();
    await runPromise.catch(() => {});
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  const message = agent.state.messages.filter((m) => m.role === "assistant").at(-1);
  return {
    polished: parsePolishedPrompt(extractPolishedText(agent)),
    ...(message?.usage
      ? {
          usage: {
            input: message.usage.input,
            output: message.usage.output,
            cacheRead: message.usage.cacheRead,
            cacheWrite: message.usage.cacheWrite,
            total: message.usage.totalTokens,
          },
        }
      : {}),
  };
}