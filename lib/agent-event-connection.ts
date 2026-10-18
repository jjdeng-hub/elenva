import type { AgentEventLike } from "./agent-event-wire";

export interface AgentEventSourceLike {
  readonly readyState: number;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

export type AgentEventConnectionStatus = "ready_timeout" | "startup_error" | "closed";

/**
 * 失败时的现场信息。以前只有一个枚举 status，用户只能看到
 * 「Timed out starting the agent session. Please try again.」——
 * 既不知道卡在哪一步，也不知道等了多久、试了几次。
 */
export interface AgentEventConnectionDetail {
  /** 本次尝试已经过去的毫秒数（ready_timeout 时就是等待时长） */
  elapsedMs?: number;
  /** 这是第几次尝试（1 = 首次） */
  attempt?: number;
  /** 断线时距最近一次事件的毫秒数；null = 一个事件都没收到 */
  idleMs?: number | null;
  /** 服务端给出的失败阶段（例如 session_start） */
  stage?: string;
  /** 服务端给出的错误细节 */
  serverDetail?: string;
}

/** 把现场信息拼进给用户看的那一句话（失败提示的唯一出口） */
export function decorateConnectionMessage(
  summary: string,
  detail: AgentEventConnectionDetail,
): string {
  const parts = [summary];
  if (detail.stage) parts.push(`失败于 ${detail.stage}`);
  if (detail.attempt !== undefined && detail.attempt > 1) parts.push(`第 ${detail.attempt} 次尝试`);
  if (detail.elapsedMs !== undefined) parts.push(`已等待 ${(detail.elapsedMs / 1000).toFixed(1)}s`);
  if (detail.idleMs !== undefined && detail.idleMs !== null) {
    parts.push(`距最近一次内核事件 ${(detail.idleMs / 1000).toFixed(1)}s`);
  }
  if (detail.serverDetail) parts.push(`服务端：${detail.serverDetail}`);
  return parts.join(" · ");
}

export class AgentEventConnectionError extends Error {
  constructor(
    public readonly status: AgentEventConnectionStatus,
    message?: string,
    public readonly detail: AgentEventConnectionDetail = {},
  ) {
    super(decorateConnectionMessage(
      message ?? (status === "ready_timeout"
        ? "等待会话就绪超时，未能建立事件流"
        : "无法连接智能体事件流"),
      detail,
    ));
    this.name = "AgentEventConnectionError";
  }
}

type Attempt = {
  promise: Promise<void>;
  ready: boolean;
  succeed(): void;
  fail(error: AgentEventConnectionError): void;
};

type Connection = {
  sessionId: string;
  source: AgentEventSourceLike;
  attempt: Attempt;
};

export interface AgentEventConnectionOptions {
  createSource(sessionId: string): AgentEventSourceLike;
  onEvent(event: AgentEventLike): void;
  shouldMaintain(sessionId: string): boolean;
  readinessTimeoutMs: number;
  reconnectDelayMs: number;
  onUnexpectedError?(error: unknown): void;
  /** 连接状态变化（重连中 / 已恢复 / 放弃）——纯通知，不影响重连逻辑 */
  onStatus?(info: AgentEventConnectionStatusInfo): void;
}

/** 上报给界面的连接状态；用来回答「是卡在等待，还是连接已经断了」 */
export interface AgentEventConnectionStatusInfo {
  sessionId: string;
  phase: "retrying" | "reconnected" | "failed";
  /** 第几次尝试（1 = 首次） */
  attempt: number;
  /** 触发这次状态变化的原因（人类可读） */
  reason: string;
}

const EVENT_SOURCE_OPEN = 1;

/** Owns the EventSource, agent-readiness handshake, and passive reconnect. */
export class AgentEventConnection {
  private current: Connection | null = null;
  private retry: { sessionId: string; timer: ReturnType<typeof setTimeout> } | null = null;
  private retryGeneration = 0;
  /** 本轮连续尝试次数（1 = 首次）；连上或主动关闭后归零。仅用于诊断输出。 */
  private attempts = 0;

  constructor(private readonly options: AgentEventConnectionOptions) {}

  close(): void {
    this.stopRetrying();
    if (this.current) this.discard(this.current, new AgentEventConnectionError("closed"));
  }

  maintain(sessionId: string): void {
    if (!this.options.shouldMaintain(sessionId)) return;
    const retryGeneration = this.retryGeneration;
    void this.ensureConnected(sessionId).catch((error) => {
      if (retryGeneration !== this.retryGeneration) return;
      if (error instanceof AgentEventConnectionError) {
        if (error.status === "startup_error") this.stopRetrying();
        else this.scheduleRetry(sessionId);
      } else {
        this.options.onUnexpectedError?.(error);
      }
    });
  }

  async ensureConnected(sessionId: string): Promise<void> {
    while (true) {
      let connection = this.current;
      if (!connection || connection.sessionId !== sessionId) {
        connection = this.open(sessionId);
      } else if (
        connection.attempt.ready
        && connection.source.readyState === EVENT_SOURCE_OPEN
      ) {
        return;
      }

      await connection.attempt.promise;
      if (this.current !== connection) {
        if (this.current?.sessionId === sessionId) continue;
        throw new AgentEventConnectionError("closed");
      }
      if (connection.source.readyState === EVENT_SOURCE_OPEN) return;

      // A once-ready EventSource may otherwise remain CONNECTING indefinitely.
      this.discard(connection, new AgentEventConnectionError("closed"));
    }
  }

  private open(sessionId: string): Connection {
    if (this.current) this.discard(this.current, new AgentEventConnectionError("closed"));

    let source: AgentEventSourceLike;
    try {
      source = this.options.createSource(sessionId);
    } catch (error) {
      throw new AgentEventConnectionError(
        "closed",
        error instanceof Error ? error.message : String(error),
      );
    }

    let settled = false;
    /** 本次尝试的开始时刻与最近一次事件时刻——失败提示里要报出来 */
    const openedAt = Date.now();
    let lastEventAt: number | null = null;
    this.attempts += 1;
    const attemptNumber = this.attempts;
    let resolve!: () => void;
    let reject!: (error: AgentEventConnectionError) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const timeout = setTimeout(() => {
      this.fail(connection, new AgentEventConnectionError("ready_timeout", undefined, {
        elapsedMs: Date.now() - openedAt,
        attempt: attemptNumber,
        idleMs: lastEventAt === null ? null : Date.now() - lastEventAt,
      }));
    }, this.options.readinessTimeoutMs);
    const attempt: Attempt = {
      promise,
      ready: false,
      succeed() {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      },
      fail(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      },
    };
    const connection: Connection = { sessionId, source, attempt };
    this.current = connection;

    source.onmessage = (message) => {
      if (this.current !== connection) return;
      let event: AgentEventLike;
      try {
        event = JSON.parse(message.data) as AgentEventLike;
      } catch {
        return;
      }
      lastEventAt = Date.now();

      if (event.type === "connected") {
        attempt.ready = true;
        attempt.succeed();
        this.stopRetrying();
        if (attemptNumber > 1) {
          this.options.onStatus?.({
            sessionId,
            phase: "reconnected",
            attempt: attemptNumber,
            reason: `事件流已恢复（第 ${attemptNumber} 次尝试才连上）`,
          });
        }
      } else if (event.type === "startup_error") {
        const message = typeof event.errorMessage === "string" ? event.errorMessage : undefined;
        /* 服务端现在会带上阶段与错误细节（哪一步、什么错）；旧服务端只有 errorMessage，
           取不到就退回原行为。 */
        const stage = typeof event.stage === "string" ? event.stage : undefined;
        const serverDetail = typeof event.errorDetail === "string" ? event.errorDetail : undefined;
        const waitMs = typeof event.waitMs === "number" ? event.waitMs : Date.now() - openedAt;
        this.fail(connection, new AgentEventConnectionError("startup_error", message, {
          elapsedMs: waitMs,
          attempt: attemptNumber,
          stage,
          serverDetail,
        }));
        return;
      }
      this.options.onEvent(event);
    };
    source.onerror = () => {
      this.fail(connection, new AgentEventConnectionError("closed", undefined, {
        elapsedMs: Date.now() - openedAt,
        attempt: attemptNumber,
        idleMs: lastEventAt === null ? null : Date.now() - lastEventAt,
      }));
    };

    return connection;
  }

  private fail(connection: Connection, error: AgentEventConnectionError): void {
    if (this.current !== connection) return;
    this.discard(connection, error);
    if (error.status === "startup_error") this.stopRetrying();
    else this.scheduleRetry(connection.sessionId);
    /* 断流在界面上原本是完全静默的（只会一直转圈）——补一条状态上报，
       逻辑不变：仍然照旧重连，只是让用户知道「连接断过、正在重试」。 */
    this.options.onStatus?.({
      sessionId: connection.sessionId,
      phase: error.status === "startup_error" ? "failed" : "retrying",
      attempt: error.detail.attempt ?? this.attempts,
      reason: error.message,
    });
  }

  private discard(connection: Connection, error: AgentEventConnectionError): void {
    connection.attempt.fail(error);
    connection.source.close();
    if (this.current === connection) this.current = null;
  }

  private scheduleRetry(sessionId: string): void {
    if (!this.options.shouldMaintain(sessionId)) return;
    if (this.retry?.sessionId === sessionId) return;
    this.clearRetry();

    const timer = setTimeout(() => {
      if (this.retry?.timer !== timer) return;
      this.retry = null;
      this.maintain(sessionId);
    }, this.options.reconnectDelayMs);
    this.retry = { sessionId, timer };
  }

  private stopRetrying(): void {
    this.retryGeneration += 1;
    this.clearRetry();
    this.attempts = 0;
  }

  private clearRetry(): void {
    if (this.retry) clearTimeout(this.retry.timer);
    this.retry = null;
  }
}
