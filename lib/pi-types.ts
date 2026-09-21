import type {
  AgentSessionEvent,
  BashOperations,
  InputSource,
  SessionManager,
  SettingsManager,
  SlashCommandInfo,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentLoopTurnUpdate,
  AgentMessage as PiAgentMessage,
  PrepareNextTurnContext,
} from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

// Mirrors the SDK's `ExtensionMode` union. We can't import it — the package root
// doesn't re-export `ExtensionMode` (unlike `InputSource`, imported above).
// The `"rpc"` member is the SDK's name for a headless programmatic host, which is
// what ELENVA Web is; it does not mean we speak a JSON-RPC wire protocol.
type ExtensionModeLike = "tui" | "rpc" | "json" | "print";

export interface ContextUsage {
  percent: number | null;
  contextWindow: number;
  tokens: number | null;
}

export interface ModelLike {
  id: string;
  provider: string;
}

export interface ToolInfo {
  name: string;
  description: string;
  parameters?: unknown;
  promptGuidelines?: string[];
  sourceInfo?: unknown;
}

export interface NavigateTreeResult {
  editorText?: string;
  cancelled: boolean;
  aborted?: boolean;
}

export interface SessionStatsInfo {
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  /** 成本分项（USD）：输入 / 输出 / 缓存读写。
   *  注意：**内核的 getSessionStats() 不返回分项**，只有本项目的会话文件聚合
   *  （lib/session-stats 的 computeSessionStats / mergeSessionStats）会补上；`/session`
   *  命令把内核统计设为 override 时这三个字段就缺失 —— 所以是可选，消费端要兜底。 */
  costInput?: number;
  costOutput?: number;
  costCache?: number;
  contextUsage?: ContextUsage;
  /** Estimated active time across all entries in the session file. */
  totalActiveMs?: number;
}

interface PromptTemplateLike {
  name: string;
  description?: string;
  sourceInfo: SlashCommandInfo["sourceInfo"];
}

interface SkillLike {
  name: string;
  description?: string;
  sourceInfo: SlashCommandInfo["sourceInfo"];
}

interface ResourceLoaderLike {
  getSkills(): { skills: SkillLike[] };
  getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> };
}

interface ExtensionRunnerLike {
  getRegisteredCommands(): Array<{
    invocationName: string;
    description?: string;
    sourceInfo: SlashCommandInfo["sourceInfo"];
  }>;
  emit?(event: { type: "session_shutdown"; reason: "quit" }): Promise<unknown>;
  setUIContext?(uiContext?: unknown, mode?: ExtensionModeLike): void;
}

type DialogOptionsLike = {
  signal?: AbortSignal;
  timeout?: number;
};

type WidgetOptionsLike = {
  placement?: "aboveEditor" | "belowEditor";
};

export interface ExtensionUiContextLike {
  select(title: string, options: string[], opts?: DialogOptionsLike): Promise<string | undefined>;
  confirm(title: string, message: string, opts?: DialogOptionsLike): Promise<boolean>;
  input(title: string, placeholder?: string, opts?: DialogOptionsLike): Promise<string | undefined>;
  editor(title: string, prefill?: string, opts?: DialogOptionsLike): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  onTerminalInput(): () => void;
  setStatus(key: string, text: string | undefined): void;
  setWorkingMessage(message?: string): void;
  setWorkingVisible(visible: boolean): void;
  setWorkingIndicator(options?: { frames?: string[]; intervalMs?: number }): void;
  setHiddenThinkingLabel(label?: string): void;
  setWidget(key: string, content: string[] | ((...args: never[]) => unknown) | undefined, options?: WidgetOptionsLike): void;
  setFooter(factory: unknown): void;
  setHeader(factory: unknown): void;
  setTitle(title: string): void;
  custom<T = unknown>(...args: unknown[]): Promise<T>;
  pasteToEditor(text: string): void;
  setEditorText(text: string): void;
  getEditorText(): string;
  addAutocompleteProvider(): void;
  setEditorComponent(): void;
  getEditorComponent(): undefined;
  readonly theme: Theme;
  getAllThemes(): unknown[];
  getTheme(name: string): undefined;
  setTheme(theme: unknown): { success: boolean; error?: string };
  getToolsExpanded(): boolean;
  setToolsExpanded(expanded: boolean): void;
}

export interface AgentSessionLike {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly autoCompactionEnabled: boolean;
  readonly autoRetryEnabled: boolean;
  readonly model: ModelLike | undefined;
  readonly modelRuntime: {
    getModel: (provider: string, modelId: string) => ModelLike | undefined;
    refresh: (options?: { allowNetwork?: boolean }) => Promise<unknown>;
  };
  readonly sessionManager: SessionManager;
  readonly settingsManager: SettingsManager;
  readonly agent: {
    state?: {
      /** 0.86 起只读：提示词由转写里的 system 消息承载，改动走「请求前投影」（agent-runtime.ts） */
      readonly systemPrompt?: string;
      thinkingLevel?: string;
      streamingMessage?: PiAgentMessage;
    };
    /** 请求前上下文变换（0.86：请求前投影的挂载点） */
    transformContext?: (
      messages: PiAgentMessage[],
      signal?: AbortSignal,
    ) => Promise<PiAgentMessage[]>;
    prepareNextTurnWithContext?: (
      context: PrepareNextTurnContext,
      signal?: AbortSignal,
    ) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
  };
  readonly extensionRunner: ExtensionRunnerLike;
  readonly promptTemplates: readonly PromptTemplateLike[];
  readonly resourceLoader: ResourceLoaderLike;

  readonly bindExtensions?: unknown;
  dispose(): void;
  reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void>;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string, options?: {
    images?: Array<{ type: "image"; data: string; mimeType: string }>;
    streamingBehavior?: "steer" | "followUp";
    source?: InputSource;
    preflightResult?: (success: boolean) => void;
  }): Promise<void>;
  sendCustomMessage<T = unknown>(message: {
    customType: string;
    content: string | (TextContent | ImageContent)[];
    display: boolean;
    details?: T;
  }, options?: {
    triggerTurn?: boolean;
    deliverAs?: "steer" | "followUp" | "nextTurn";
  }): Promise<void>;
  abort(): Promise<void>;
  executeBash(command: string, onChunk?: (chunk: string) => void, options?: {
    excludeFromContext?: boolean;
    operations?: BashOperations;
  }): Promise<{ output: string; exitCode?: number; cancelled?: boolean; truncated?: boolean; fullOutputPath?: string }>;
  abortBash(): void;
  readonly isBashRunning: boolean;
  setModel(model: ModelLike): Promise<void>;
  navigateTree(targetId: string, options?: { summarize?: boolean }): Promise<NavigateTreeResult>;
  setThinkingLevel(level: string): void;
  compact(customInstructions?: string): Promise<unknown>;
  setSessionName(name: string): void;
  getSessionStats(): Omit<SessionStatsInfo, "sessionName">;
  getLastAssistantText(): string | undefined;
  setAutoCompactionEnabled(enabled: boolean): void;
  setAutoRetryEnabled(enabled: boolean): void;
  steer(text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<void>;
  followUp(text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<void>;
  readonly pendingMessageCount: number;
  getSteeringMessages(): readonly string[];
  getFollowUpMessages(): readonly string[];
  clearQueue(): { steering: string[]; followUp: string[] };
  getAllTools(): ToolInfo[];
  getActiveToolNames(): string[];
  setActiveToolsByName(names: string[]): void;
  abortCompaction(): void;
  getContextUsage(): ContextUsage | undefined;
  readonly steeringMode: "all" | "one-at-a-time";
  readonly followUpMode: "all" | "one-at-a-time";
  setSteeringMode(mode: "all" | "one-at-a-time"): void;
  setFollowUpMode(mode: "all" | "one-at-a-time"): void;
}
