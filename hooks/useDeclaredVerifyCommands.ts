"use client";

import { useEffect, useState } from "react";

/**
 * 项目声明的验证命令（护栏设置 `verifyCommandsByProject`）——界面侧只读一次并缓存。
 *
 * 为什么要有它：声明过的命令在服务端账本里已按「验证」记账，但界面汇总此前没传
 * 这份声明，于是「整体验证通过」永远显示成「未跑验证」（`/api/guardrails?cwd=` 早就
 * 返回了 `verifyCommands`，只是没人用）。
 *
 * 三条设计约束：
 *   · **模块级缓存**：观测栏「本轮」区与输入框上方那行都要用，各自 fetch 会打爆接口；
 *   · **失败即退回**：拉取失败 / 无 cwd → 返回 `undefined`，`summarizeTurn` 行为与没接
 *     这个功能时逐字节一致 —— 声明只是让结论更准，不该阻塞或打扰用户；
 *   · **不缓存失败**：成功（含空列表）才写缓存，失败留着下次会话再试。
 */

/** cwd → 声明列表（成功才写，空数组也算成功） */
const cache = new Map<string, string[]>();
/** 同一 cwd 并发只发一次请求 */
const inflight = new Map<string, Promise<string[] | null>>();

async function loadDeclared(cwd: string): Promise<string[] | null> {
  const cached = cache.get(cwd);
  if (cached) return cached;
  const running = inflight.get(cwd);
  if (running) return running;
  const task = (async () => {
    try {
      const res = await fetch(`/api/guardrails?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" });
      if (!res.ok) return null;
      const data = (await res.json()) as { verifyCommands?: unknown };
      const list = Array.isArray(data.verifyCommands)
        ? data.verifyCommands.filter((item): item is string => typeof item === "string" && item.trim() !== "")
        : [];
      cache.set(cwd, list);
      return list;
    } catch {
      return null;
    } finally {
      inflight.delete(cwd);
    }
  })();
  inflight.set(cwd, task);
  return task;
}

function usable(list: string[] | null | undefined): string[] | undefined {
  return list && list.length > 0 ? list : undefined;
}

export function useDeclaredVerifyCommands(cwd: string | null | undefined): string[] | undefined {
  const key = cwd && cwd !== "unknown" ? cwd : "";
  const [patterns, setPatterns] = useState<string[] | undefined>(() =>
    key ? usable(cache.get(key)) : undefined,
  );

  useEffect(() => {
    if (!key) {
      setPatterns(undefined);
      return;
    }
    setPatterns(usable(cache.get(key)));
    let alive = true;
    void loadDeclared(key).then((list) => {
      if (!alive) return;
      setPatterns(usable(list));
    });
    return () => {
      alive = false;
    };
  }, [key]);

  return patterns;
}
