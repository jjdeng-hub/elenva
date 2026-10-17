/**
 * 整理（tidy）—— 纯函数实现，可单测、可离线跑。
 *
 * 依据《深入理解 AI Agent》ch3：
 * - **L221 记忆压缩与整理**：第一层按重要性评分筛选（访问频率、时间衰减、信息独特性），
 *   第二层聚类合并相似条目，第三层抽象泛化（我们暂不做，留给后续）；
 * - **L505 记忆与知识库的定期整理**：去重去旧、回到原始证据核查、
 *   **冲突解决与场景限定 —— 证据不足时保留冲突和待确认状态，不得强行收敛成一个结论**。
 *   所以本实现对冲突只做「标注 + 报告」，唯一的破坏性动作（去重/淘汰）都走**归档**，不删除。
 */
import { archiveEntries, serializeEntries, writeFileAtomic, type MemoryEntry, type StoreFile, type StoreSet } from "./stores.js";
import { accessCount, type ConflictRecord, type ElenvaMemoryState } from "./state.js";

const DUP_THRESHOLD = 0.85;
const CONFLICT_FLOOR = 0.35;

/** 字符三元组集合（对中文友好：中文没有词边界，字符 n-gram 是通用做法）。 */
export function shingles(text: string, size = 3): Set<string> {
  const normalized = text.replace(/\s+/g, "");
  const out = new Set<string>();
  if (normalized.length <= size) {
    if (normalized) out.add(normalized);
    return out;
  }
  for (let i = 0; i + size <= normalized.length; i += 1) out.add(normalized.slice(i, i + size));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function ageDaysOf(entry: MemoryEntry): number {
  const stamp = entry.last ?? entry.created;
  if (!stamp) return 0;
  const parsed = Date.parse(stamp);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, (Date.now() - parsed) / 86400000);
}

export interface ScoredEntry {
  entry: MemoryEntry;
  score: number;
  maxSimilarity: number;
  uniqueness: number;
  accesses: number;
}

/**
 * 重要性评分（ch3 L221 第一层）：访问频率 + 时间衰减 + 信息独特性。
 * 刻意用可解释的加权和，方便调权重与复盘。
 */
export function scoreEntries(entries: MemoryEntry[], state: ElenvaMemoryState): ScoredEntry[] {
  const prints = entries.map((entry) => shingles(entry.text));
  return entries.map((entry, index) => {
    let maxSimilarity = 0;
    for (let other = 0; other < entries.length; other += 1) {
      if (other === index) continue;
      const sim = jaccard(prints[index], prints[other]);
      if (sim > maxSimilarity) maxSimilarity = sim;
    }
    const accesses = accessCount(state, entry.id);
    const uniqueness = 1 - maxSimilarity;
    const score =
      2.0 * Math.log2(1 + accesses) +
      1.5 * Math.exp(-ageDaysOf(entry) / 45) +
      1.0 * uniqueness;
    return { entry, score, maxSimilarity, uniqueness, accesses };
  });
}

export interface DuplicateGroup {
  kept: MemoryEntry;
  dropped: MemoryEntry[];
}

export interface EvictionSuggestion {
  entry: MemoryEntry;
  score: number;
  storeScope: StoreFile["scope"];
  file: string;
}

const CHANGE_MARKERS = /改为|改成|作废|取消|停用|弃用|替换|不再|废弃|已换|换成|失效/;

function digitsOf(text: string): Set<string> {
  return new Set(text.match(/\d+/g) ?? []);
}

function setsDiffer(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  if (a.size !== b.size) return true;
  for (const item of a) if (!b.has(item)) return true;
  return false;
}

/** 同一条信息出现互相矛盾的说法？给一个可解释的理由（用于报告，不做自动裁决）。 */
export function conflictReason(a: MemoryEntry, b: MemoryEntry): string | null {
  const digitsA = digitsOf(a.text);
  const digitsB = digitsOf(b.text);
  if (setsDiffer(digitsA, digitsB)) return "同类条目但数字不一致";
  const changeA = CHANGE_MARKERS.test(a.text);
  const changeB = CHANGE_MARKERS.test(b.text);
  if (changeA !== changeB) return "一条写了变更/作废，另一条没有";
  return null;
}

/** 把数字抹成 0：用来判断两条是不是「同一句话换了个数」。 */
export function maskDigits(text: string): string {
  return text.replace(/\d+/g, "0");
}

/** 冲突上限：超过就只留最相似的几条（否则报告会被平行条目淹没，实测合成数据上出现过 700+ 组）。 */
const MAX_CONFLICTS = 8;

export interface TidyResult {
  duplicates: Array<{ scope: StoreFile["scope"]; kept: MemoryEntry; dropped: MemoryEntry[] }>;
  conflicts: Array<ConflictRecord & { title?: string }>;
  /** 容量压力下的全部候选（= 失效建议 + 归档建议，保留给汇总/旧消费方） */
  evictions: EvictionSuggestion[];
  /** R2r2：建议「标失效」的条目（被推翻 / 参与冲突 / 变更标记）——非破坏性，可恢复 */
  invalidationSuggestions: EvictionSuggestion[];
  /** R2r2：建议「归档」的条目（已失效残留 / 纯噪声 / 重复淘汰）——物理移出文件 */
  archiveSuggestions: EvictionSuggestion[];
  summary: string;
  applied: string[];
  accessAfterApply?: ElenvaMemoryState["access"];
}

export interface TidyOptions {
  apply?: boolean;
  /** 淘汰线：超过配额这个比例才开始给淘汰建议 */
  evictionRatio?: number;
}

export function runTidy(stores: StoreSet, state: ElenvaMemoryState, options: TidyOptions = {}): TidyResult {
  const evictionRatio = options.evictionRatio ?? 0.95;
  const result: TidyResult = {
    duplicates: [],
    conflicts: [],
    evictions: [],
    invalidationSuggestions: [],
    archiveSuggestions: [],
    summary: "",
    applied: [],
  };

  for (const store of stores.stores) {
    const scored = scoreEntries(store.entries, state);

    // ① 去重（ch3 L221 第二层：聚类合并）
    const consumed = new Set<string>();
    for (const item of [...scored].sort((a, b) => b.score - a.score)) {
      if (consumed.has(item.entry.id)) continue;
      const group = scored.filter(
        (other) =>
          other.entry.id !== item.entry.id &&
          !consumed.has(other.entry.id) &&
          jaccard(shingles(item.entry.text), shingles(other.entry.text)) >= DUP_THRESHOLD,
      );
      if (group.length === 0) continue;
      for (const member of group) consumed.add(member.entry.id);
      consumed.add(item.entry.id);
      result.duplicates.push({ scope: store.scope, kept: item.entry, dropped: group.map((g) => g.entry) });
    }

    // ② 冲突（ch3 L505：只标注，不合并）
    for (let i = 0; i < scored.length; i += 1) {
      for (let j = i + 1; j < scored.length; j += 1) {
        const sim = jaccard(shingles(scored[i].entry.text), shingles(scored[j].entry.text));
        if (sim < CONFLICT_FLOOR || sim >= DUP_THRESHOLD) continue;
        const reason = conflictReason(scored[i].entry, scored[j].entry);
        if (!reason) continue;
        if (reason === "同类条目但数字不一致") {
          // 数字不同 ≠ 冲突：平行条目（"第1条/第2条"）也会数字不同。
          // 真正的冲突 = 把数字抹掉后几乎是同一句话（"尾号 3021" vs "尾号 8899"）。
          const masked = jaccard(shingles(maskDigits(scored[i].entry.text)), shingles(maskDigits(scored[j].entry.text)));
          if (masked < 0.9) continue;
        }
        result.conflicts.push({
          a: scored[i].entry.id,
          b: scored[j].entry.id,
          sim: Number(sim.toFixed(3)),
          reason,
          at: new Date().toISOString(),
        });
      }
    }

    // ③ 容量淘汰建议（ch3 L221 第一层：低于阈值的可压缩 / 可删除）
    // R2r2 分流：「失效建议」（被推翻 / 参与冲突 / 变更标记，非破坏性）与
    // 「归档建议」（已失效残留 / 纯噪声 / 重复淘汰，物理移出）。
    const inConflict = new Set<string>();
    for (const conflict of result.conflicts) {
      inConflict.add(conflict.a);
      inConflict.add(conflict.b);
    }
    if (store.rawChars > store.limit * evictionRatio) {
      const target = store.limit * 0.9;
      let projected = store.rawChars;
      for (const item of [...scored].sort((a, b) => a.score - b.score)) {
        if (projected <= target) break;
        projected -= item.entry.text.length + 3;
        const candidate: EvictionSuggestion = { entry: item.entry, score: item.score, storeScope: store.scope, file: store.file };
        result.evictions.push(candidate);
        if (inConflict.has(item.entry.id) || CHANGE_MARKERS.test(item.entry.text)) {
          result.invalidationSuggestions.push(candidate);
        } else {
          result.archiveSuggestions.push(candidate);
        }
      }
    }
    // 已失效条目的清出：即使未达容量线也归「归档建议」（它们已不参与注入，清出零语义损失）。
    const suggestedIds = new Set(result.evictions.map((item) => item.entry.id));
    for (const entry of store.entries) {
      if (!entry.invalidated || suggestedIds.has(entry.id)) continue;
      result.evictions.push({
        entry,
        score: scoreEntries([entry], state)[0]?.score ?? 0,
        storeScope: store.scope,
        file: store.file,
      });
      result.archiveSuggestions.push({ entry, score: 0, storeScope: store.scope, file: store.file });
      suggestedIds.add(entry.id);
    }

    // ④ apply：归档重复与归档建议；失效建议**只标记不删除**（可恢复）
    if (options.apply && (result.duplicates.some((d) => d.scope === store.scope) || result.archiveSuggestions.some((e) => e.file === store.file) || result.invalidationSuggestions.some((e) => e.file === store.file))) {
      const dropIds = new Set<string>();
      const keptIds = new Set<string>();
      for (const group of result.duplicates) {
        if (group.scope !== store.scope) continue;
        keptIds.add(group.kept.id);
        for (const dropped of group.dropped) dropIds.add(dropped.id);
      }
      for (const eviction of result.archiveSuggestions) {
        if (eviction.file !== store.file) continue;
        if (keptIds.has(eviction.entry.id)) continue;
        dropIds.add(eviction.entry.id);
      }
      const invalidateIds = new Set<string>();
      for (const suggestion of result.invalidationSuggestions) {
        if (suggestion.file !== store.file) continue;
        if (dropIds.has(suggestion.entry.id) || keptIds.has(suggestion.entry.id)) continue;
        invalidateIds.add(suggestion.entry.id);
      }

      const toArchive = store.entries.filter((entry) => dropIds.has(entry.id));
      if (toArchive.length > 0) {
        const archiveFile = archiveEntries(store, toArchive, "tidy：去重合并 / 失效残留清出");
        result.applied.push(`${store.scope}：归档 ${toArchive.length} 条 → ${archiveFile ?? "（未落盘）"}`);
      }

      const today = new Date().toISOString().slice(0, 10);
      let invalidatedCount = 0;
      const remaining = store.entries
        .filter((entry) => !dropIds.has(entry.id))
        .map((entry) => {
          if (!invalidateIds.has(entry.id)) return entry;
          invalidatedCount += 1;
          return { ...entry, invalidated: entry.invalidated ?? today, reason: entry.reason ?? "tidy：被推翻 / 与其它条目冲突" };
        });
      if (toArchive.length > 0 || invalidatedCount > 0) {
        writeFileAtomic(store.file, serializeEntries(remaining));
        store.entries = remaining;
        store.rawChars = serializeEntries(remaining).length;
        if (invalidatedCount > 0) {
          result.applied.push(`${store.scope}：标记失效 ${invalidatedCount} 条（不删除，可用 memory_status restore 恢复）`);
        }
        result.applied.push(`${store.scope}：余 ${remaining.length} 条 / ${store.rawChars} 字符`);
      }
    }
  }

  // 冲突去重（同一对只留一条）+ 截断到上限（留最相似的）
  const seen = new Set<string>();
  const unique = result.conflicts.filter((conflict) => {
    const key = [conflict.a, conflict.b].sort().join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => b.sim - a.sim);
  const omittedConflicts = Math.max(0, unique.length - MAX_CONFLICTS);
  result.conflicts = unique.slice(0, MAX_CONFLICTS);

  const parts = [
    `重复 ${result.duplicates.length} 组`,
    `冲突 ${result.conflicts.length} 组${omittedConflicts > 0 ? `（另有 ${omittedConflicts} 组未列出）` : ""}`,
    `失效建议 ${result.invalidationSuggestions.length} 条`,
    `归档建议 ${result.archiveSuggestions.length} 条`,
  ];
  result.summary = parts.join("、");
  if (options.apply) result.accessAfterApply = state.access;
  return result;
}

export function renderTidyReport(result: TidyResult): string {
  const lines: string[] = [];
  lines.push(`记忆整理报告（${new Date().toLocaleString("zh-CN")}）`);
  lines.push(`摘要：${result.summary}`);

  if (result.duplicates.length > 0) {
    lines.push("", "【重复（apply 时归档后写的那些）】");
    for (const group of result.duplicates) {
      lines.push(`- ${group.scope}：保留「${head(group.kept.text)}」`);
      for (const dropped of group.dropped) lines.push(`    归档「${head(dropped.text)}」`);
    }
  }
  if (result.conflicts.length > 0) {
    lines.push("", "【冲突（保留 + 待确认，不自动合并）】");
    for (const conflict of result.conflicts) {
      lines.push(`- ${conflict.a} ↔ ${conflict.b}（相似度 ${conflict.sim}）：${conflict.reason}`);
    }
  }
  if (result.invalidationSuggestions.length > 0) {
    lines.push("", "【失效建议（被推翻 / 冲突 / 变更标记；apply 时只标记失效，不删除）】");
    for (const suggestion of result.invalidationSuggestions) {
      lines.push(`- [${suggestion.storeScope}] ${head(suggestion.entry.text)}（分数 ${suggestion.score.toFixed(2)}）`);
    }
  }
  if (result.archiveSuggestions.length > 0) {
    lines.push("", "【归档建议（已失效残留 / 纯噪声 / 重复淘汰；apply 时移入 archive/）】");
    for (const suggestion of result.archiveSuggestions) {
      lines.push(`- [${suggestion.storeScope}] ${head(suggestion.entry.text)}（分数 ${suggestion.score.toFixed(2)}）`);
    }
  }
  if (result.applied.length > 0) {
    lines.push("", "【已执行】", ...result.applied.map((line) => `- ${line}`));
  }
  return lines.join("\n");
}

function head(text: string, max = 42): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * 「周整理提案」——节律每周只读任务的产出（不写任何文件，供人过目后手动执行）。
 *
 * 与 renderTidyReport 的区别：那份是**整理动作报告**（重复/冲突/建议 + apply 结果）；
 * 这份面向“本周该清什么”的四段式巡检：水位（含上次整理对照）、可清出的失效条目、
 * 近重复/冲突候选、一句建议。分节固定，便于逐周对比。
 */
export function renderWeeklyProposal(stores: StoreSet, tidy: TidyResult, state: ElenvaMemoryState): string {
  const lines: string[] = [];
  const now = new Date();
  lines.push(`记忆周整理提案（${now.toLocaleString("zh-CN")}）`);

  // 一、水位（含上次整理对照，给“趋势”一个可读的锚点）
  lines.push("", "【一、水位】");
  let totalChars = 0;
  let totalLimit = 0;
  for (const store of stores.stores) {
    totalChars += store.rawChars;
    totalLimit += store.limit;
    const pct = store.limit > 0 ? Math.round((store.rawChars / store.limit) * 100) : 0;
    const flag = pct >= 85 ? " ⚠ 接近上限（≥85%，写入会开始提醒）" : "";
    lines.push(`- ${store.scope}: ${store.rawChars} / ${store.limit} 字符（${pct}%，${store.entries.length} 条）${flag}`);
  }
  if (totalLimit > 0) {
    lines.push(`- 合计: ${totalChars} / ${totalLimit} 字符（${Math.round((totalChars / totalLimit) * 100)}%）`);
  }
  if (stores.projectName === null) {
    lines.push("- （当前目录未识别为项目，未纳入项目记忆；如需看项目水位请把任务 cwd 指到仓库根）");
  }
  if (state.tidy?.lastRunAt) {
    lines.push(`- 上次整理：${state.tidy.lastRunAt}（${state.tidy.lastSummary ?? "无摘要"}）—— 与本次对比即走势`);
  } else {
    lines.push("- 上次整理：无记录（本次为首次周整理）");
  }

  // 二、失效条目（可清出的）
  const invalidated = stores.stores.flatMap((store) =>
    store.entries.filter((e) => e.invalidated).map((entry) => ({ store, entry })),
  );
  const reclaim = stores.stores.reduce(
    (sum, store) => sum + (serializeEntries(store.entries.filter((e) => e.invalidated)).length || 0),
    0,
  );
  lines.push("", `【二、失效条目（可清出）】共 ${invalidated.length} 条，预计可释放约 ${reclaim} 字符`);
  if (invalidated.length === 0) {
    lines.push("- 无（没有已标失效的条目）");
  } else {
    for (const { store, entry } of invalidated) {
      lines.push(`- [${store.scope}] ${head(entry.text, 50)}（失效于 ${entry.invalidated}${entry.reason ? `：${entry.reason}` : ""}）`);
    }
    lines.push("- 清出方式：确认无需恢复后，用归档（tidy --apply 的归档建议）或逐条删除；失效本身可逆（memory_status restore）。");
  }

  // 三、近重复 / 冲突候选
  lines.push("", "【三、近重复 / 冲突候选】");
  if (tidy.duplicates.length === 0 && tidy.conflicts.length === 0) {
    lines.push("- 无（相似度 ≥0.85 的近重复与同题冲突均为 0）");
  }
  for (const group of tidy.duplicates) {
    lines.push(`- 近重复 [${group.scope}]：保留「${head(group.kept.text)}」；归档 ${group.dropped.length} 条（如「${head(group.dropped[0]?.text ?? "")}」）`);
  }
  for (const conflict of tidy.conflicts) {
    lines.push(`- 冲突：「${head(conflict.a, 30)}」↔「${head(conflict.b, 30)}」（相似度 ${conflict.sim}）：${conflict.reason}`);
  }

  // 四、本周建议（确定性，不调模型）
  lines.push("", "【四、本周建议】");
  const advice: string[] = [];
  const overRatio = stores.stores.filter((s) => s.limit > 0 && s.rawChars / s.limit >= 0.85);
  if (invalidated.length > 0) advice.push(`先清出 ${invalidated.length} 条失效条目（约释放 ${reclaim} 字符，不需动有效内容）`);
  if (tidy.duplicates.length > 0) advice.push(`合并 ${tidy.duplicates.length} 组近重复`);
  if (overRatio.length > 0) advice.push(`${overRatio.map((s) => s.scope).join("/")} 已接近上限，建议本周合并或迁出长条目（程序性内容写 skill）`);
  if (advice.length === 0) lines.push("水位健康、无近重复与失效积压 —— 本周无需整理动作。");
  else lines.push(`${advice.join("；")}。`);

  lines.push("", "（只读提案：未修改任何记忆文件；确认后再手动执行 /memory-tidy --apply 或逐条处理。）");
  return lines.join("\n");
}
