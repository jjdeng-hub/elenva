"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { PlayingSFX } from "uisfx";
import { playCue } from "@/lib/sound";

/**
 * 八条「事件 → cue」映射（规格 docs/specs/2026-11-12-ui-sound.md）。
 * 事件统一来自 SessionRuntimeSurface，Pi / Hermes 两条链路共用。
 *
 *   send        提交时响一次（调用方在 handleSend 包装里触发）
 *   complete    一轮成功结束；<2s 的短任务不响
 *   error       一轮失败（与 complete 互斥）
 *   notification  pending 空→非空 响一次
 *   check/cancel  批准/拒绝（调用方包装 onRespond 触发）
 *   disconnect/connect  连接状态翻转（Hermes hermesConnection）
 *   processing loop   仅当本轮 >15s 才起，结束/失败必须 stop；loop 偏好默认关
 *   select      切会话/模型（轻，库冷却抑制）
 */

export interface UseSoundEventsOptions {
  agentRunning: boolean;
  /** 一轮失败信号：rt.error（Pi）或 hermesConnection lost（Hermes 的 error 字段也用它） */
  error: string | null;
  /** 审批 pending：Pi=extensionDialog，Hermes=hermesPermission；null 视为空 */
  approvalPending: unknown;
  /** 连接状态（仅 Hermes 有）；"live" | "lost" | undefined */
  connection: "live" | "lost" | undefined;
  /** 切换会话（按会话 id 变化响 select） */
  sessionKey: string | null;
  /** 切换模型（回调包装响 select） */
  onModelChange?: (...args: never[]) => unknown;
  /** 长任务 loop（processing）是否开启（设置里单独开，默认关） */
  loopEnabled: boolean;
}

/** 最短可响时长：一轮 <2s 的快速问答不出声 */
const MIN_TURN_MS = 2000;
/** 长任务 loop 起播门槛 */
const LOOP_DELAY_MS = 15000;

export function useSoundEvents(options: UseSoundEventsOptions): {
  /** 在提交处调用：响 send */
  notifySubmit: () => void;
  /** 包一层审批响应：批准响 check、拒绝响 cancel */
  notifyApprovalResponse: (response: unknown) => void;
  /** 包一层模型切换：响 select */
  wrappedModelChange: (...args: never[]) => unknown;
} {
  const { agentRunning, error, approvalPending, connection, sessionKey, loopEnabled } = options;

  const turnStartRef = useRef<number | null>(null);
  const loopRef = useRef<PlayingSFX | null>(null);
  const loopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasRunningRef = useRef(false);
  const wasApprovalPendingRef = useRef(false);
  const wasConnectionRef = useRef<"live" | "lost" | undefined>(undefined);
  const wasSessionKeyRef = useRef<string | null>(null);
  /** 挂起的 complete/error：running 翻 false 时记下，等 error 字段同步后消费 */
  const pendingEndRef = useRef<"complete" | "error" | null>(null);

  const stopLoop = () => {
    if (loopTimerRef.current) {
      clearTimeout(loopTimerRef.current);
      loopTimerRef.current = null;
    }
    if (loopRef.current) {
      try {
        loopRef.current.stop();
      } catch {
        // 已结束：忽略
      }
      loopRef.current = null;
    }
  };

  const notifySubmit = useCallback(() => {
    playCue("send");
  }, []);

  const notifyApprovalResponse = useCallback((response: unknown) => {
    const cancelled =
      typeof response === "object" && response !== null && (response as { cancelled?: boolean }).cancelled === true;
    playCue(cancelled ? "cancel" : "check");
  }, []);

  const onModelChangeRef = useRef(options.onModelChange);
  onModelChangeRef.current = options.onModelChange;
  const wrappedModelChange = useCallback((...args: never[]) => {
    playCue("select");
    return onModelChangeRef.current?.(...args);
  }, []);

  // ---- 一轮开始/结束 + loop 调度 ----
  useEffect(() => {
    if (agentRunning && !wasRunningRef.current) {
      // 开始：重置计时，调度 15s 后的 loop
      turnStartRef.current = Date.now();
      stopLoop();
      if (loopEnabled) {
        loopTimerRef.current = setTimeout(() => {
          loopTimerRef.current = null;
          if (!loopRef.current) {
            loopRef.current = playCue("processing", { volume: 0.35, loop: true, retrigger: "ignore" });
          }
        }, LOOP_DELAY_MS);
      }
    }
    if (!agentRunning && wasRunningRef.current) {
      // 结束：先停 loop（失败/取消也必须停）
      stopLoop();
      const elapsed = turnStartRef.current ? Date.now() - turnStartRef.current : 0;
      // complete/error 互斥：error 字段通常在事件流里先于/同期于 running 翻转，
      // 所以这里只挂起，由下面的 error/complete 消费 effect 统一落音。
      pendingEndRef.current = elapsed >= MIN_TURN_MS ? "complete" : null;
    }
    wasRunningRef.current = agentRunning;
  }, [agentRunning, loopEnabled]);

  // ---- 消费一轮结束音（complete/error 互斥；error 优先）----
  useEffect(() => {
    if (!pendingEndRef.current) return;
    if (error) {
      pendingEndRef.current = null;
      playCue("error");
      stopLoop();
      return;
    }
    if (!agentRunning) {
      const kind = pendingEndRef.current;
      pendingEndRef.current = null;
      if (kind === "complete") playCue("complete");
    }
  }, [error, agentRunning]);

  // error 直接出现（未经过 running 翻转捕获，例如提交即失败）也响 error
  const prevErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (error && !prevErrorRef.current && !pendingEndRef.current) {
      playCue("error");
      stopLoop();
    }
    prevErrorRef.current = error;
  }, [error]);

  // ---- 审批：pending 空→非空 响一次 ----
  useEffect(() => {
    const now = Boolean(approvalPending);
    if (now && !wasApprovalPendingRef.current) playCue("notification");
    wasApprovalPendingRef.current = now;
  }, [approvalPending]);

  // ---- 连接断开 / 恢复（Hermes）----
  useEffect(() => {
    const prev = wasConnectionRef.current;
    wasConnectionRef.current = connection;
    if (prev === undefined || connection === undefined) return;
    if (connection === "lost" && prev === "live") playCue("disconnect");
    if (connection === "live" && prev === "lost") playCue("connect");
  }, [connection]);

  // ---- 切换会话：select（轻）----
  useEffect(() => {
    const prev = wasSessionKeyRef.current;
    wasSessionKeyRef.current = sessionKey;
    if (prev !== null && sessionKey !== null && prev !== sessionKey) playCue("select");
  }, [sessionKey]);

  // 卸载兜底：loop 必须停
  useEffect(() => stopLoop, []);

  // 返回稳定引用：调用方会把它放进 useCallback/useEffect 依赖，
  // 每次渲染返回新对象会让依赖永远变 → React #185（Maximum update depth）。
  return useMemo(
    () => ({ notifySubmit, notifyApprovalResponse, wrappedModelChange }),
    [notifySubmit, notifyApprovalResponse, wrappedModelChange],
  );
}
