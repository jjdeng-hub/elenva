"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** 与 lib/model-notes.ts 的存储形状一致（键 = `provider/modelId`）。 */
export type ModelNote = { note: string; updatedAt: string };
export type ModelNoteMap = Record<string, ModelNote>;

/**
 * 模型备注的客户端取数 / 落库。
 *
 * 备注表极小（每个模型一条短文本），一次全量拉完即可——逐行请求既慢又要在两处
 * （模型页、选择器）各写一套。`enabled=false` 时不动网络：选择器在聊天页常驻，
 * 先不问，等菜单真打开再拉。
 */
export function useModelNotes({ enabled = true }: { enabled?: boolean } = {}) {
  const [notes, setNotes] = useState<ModelNoteMap>({});
  const loadedRef = useRef(false);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/model-notes", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { notes?: ModelNoteMap };
      setNotes(data.notes ?? {});
      loadedRef.current = true;
    } catch {
      /* 备注取不到不影响选模型的主流程，静默降级 */
    }
  }, []);

  useEffect(() => {
    if (enabled && !loadedRef.current) void reload();
  }, [enabled, reload]);

  /**
   * 落一条备注（空串 = 清除）；成功时就地更新本地表，免得再拉一次全量。
   * 失败抛错，由调用方决定怎么提示。
   */
  const save = useCallback(async (provider: string, modelId: string, note: string) => {
    const res = await fetch("/api/model-notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, modelId, note }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      note?: string | null;
      updatedAt?: string | null;
    };
    if (!res.ok) throw new Error(data.error || `保存失败（HTTP ${res.status}）`);

    const key = `${provider}/${modelId}`;
    setNotes((prev) => {
      const next = { ...prev };
      if (data.note) next[key] = { note: data.note, updatedAt: data.updatedAt ?? new Date().toISOString() };
      else delete next[key];
      return next;
    });
  }, []);

  return { notes, reload, save };
}
