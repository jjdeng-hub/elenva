import type { SessionEntry } from "@/lib/types";

/**
 * 一条压缩记录（「这次压缩丢了什么」的条目级近似）。
 *
 * 会话文件里压缩是**追加**的：内核把被压掉的历史替换成一条 compaction 摘要，
 * 并用 `firstKeptEntryId` 指回「压缩后仍然保留的第一条」。要复盘压缩幅度，
 * 最直接的口径就是数一数这次压缩覆盖掉区间里有多少条 message。
 */
export interface CompactionRecord {
  /** compaction 条目自身的 id（UI 上做 key / 展开定位用） */
  entryId: string;
  /** compaction 条目时间戳（ISO） */
  timestamp: string;
  /** 压缩前该会话的 token 数；缺失或非法记 0 */
  tokensBefore: number;
  /** 压缩摘要全文 */
  summary: string;
  /** 本次压缩丢弃区间内的 message 条目数（文件顺序口径） */
  droppedMessages: number;
}

/** 安全读取条目字段：字段缺失 / 类型异常时不抛错，返回 undefined 交给调用方兜底 */
function field(entry: SessionEntry, key: string): unknown {
  return (entry as unknown as Record<string, unknown>)[key];
}

/**
 * 从会话的 entries 收集全部压缩记录（按**文件顺序**，即时间升序）。
 *
 * 丢弃区间采用**线性近似**：不做树 / 分支分析，直接按文件顺序把相邻两次压缩之间
 * 的条目当作「本次压缩覆盖的范围」——
 *   区间起点 = 上一条压缩的 `firstKeptEntryId`（没有上一条则文件头部）；
 *   区间终点 = 本条压缩的 `firstKeptEntryId`。
 * `droppedMessages` = 该半开区间 `[起点, 终点)` 内 `type === "message"` 的条目数。
 *
 * 为什么用线性近似：会话虽然是一棵树，但压缩发生在**当前活跃分支**上，而 JSONL
 * 本身就是按发生顺序追加的；分支场景下各条压缩的保留起点仍单调向前。按文件顺序
 * 处理足够表达「这次丢了多少条」，还能避免为极少数分支回放场景引入树遍历的复杂度。
 *
 * 宽容策略：字段缺失 / 异常不抛错；`tokensBefore` 非有限数字记 0；找不到某条
 * `firstKeptEntryId` 对应条目时，以该 compaction 条目自身的位置作为区间终点。
 */
export function collectCompactionRecords(entries: SessionEntry[]): CompactionRecord[] {
  if (!Array.isArray(entries) || entries.length === 0) return [];

  // 条目 id → 文件下标（首次出现为准）
  const indexById = new Map<string, number>();
  entries.forEach((entry, index) => {
    const id = field(entry, "id");
    if (typeof id === "string" && !indexById.has(id)) indexById.set(id, index);
  });

  const records: CompactionRecord[] = [];
  // 上一条压缩的保留起点（文件下标）；初始为文件头部
  let keptFromIndex = 0;

  entries.forEach((entry, index) => {
    if (entry.type !== "compaction") return;
    const rawKeptId = field(entry, "firstKeptEntryId");
    const keptIndex = typeof rawKeptId === "string" ? indexById.get(rawKeptId) : undefined;
    // 保留起点：找到了用它；缺字段 / 找不到退化为「本条 compaction 自身位置」
    const boundary = keptIndex !== undefined ? keptIndex : index;
    // 分支回放等极端情况下，本条保留起点可能落在上一起点之前 → 收敛为空区间
    const from = Math.min(keptFromIndex, boundary);

    let droppedMessages = 0;
    for (let i = from; i < boundary; i += 1) {
      if (entries[i]?.type === "message") droppedMessages += 1;
    }

    const rawTokens = field(entry, "tokensBefore");
    const rawSummary = field(entry, "summary");
    const rawTimestamp = field(entry, "timestamp");
    const rawId = field(entry, "id");

    records.push({
      entryId: typeof rawId === "string" ? rawId : "",
      timestamp: typeof rawTimestamp === "string" ? rawTimestamp : "",
      tokensBefore: typeof rawTokens === "number" && Number.isFinite(rawTokens) ? rawTokens : 0,
      summary: typeof rawSummary === "string" ? rawSummary : "",
      droppedMessages,
    });

    // 下一条压缩的区间起点：本条保留起点；缺字段时从本条 compaction 之后继续
    keptFromIndex = keptIndex !== undefined ? boundary : boundary + 1;
  });

  return records;
}
