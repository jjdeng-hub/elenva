import { normalizeOriginEntryText } from "./memory-origins";

/**
 * 记忆冲突候选发现（纯函数，零模型调用、零新依赖、确定性）。
 *
 * 为什么要有它：条目越攒越多后，「同题重复」与「新旧矛盾」肉眼不可见——
 * failures.md 里已经出现同一件事被反复沉淀的情形。这里只做**候选发现 + 引导**：
 * 给出一对对疑似重复/反向的条目，让用户在记忆页肉眼对照后自己决定改哪条。
 *
 * 为什么只提示、不自动合并：《深入理解 AI Agent》ch3 L534 明确要求「证据仍不足时保留冲突与
 * 待确认状态，不得强行收敛」；L202 也点出自动 UPDATE/DELETE 的风险是「一次错误的更新或删除会
 * 不可逆地丢失历史信息」。合并是语义判断且不可逆，启发式只配当线索。（本决策已登记在
 * docs/agent-design-standard.md 的偏离登记：超阈值只提醒不自动整理。）
 *
 * 口径：正文先归一到 `normalizeOriginEntryText`（剥掉扩展写的尾部元数据注释）再分词；
 * 集合相似度用 Jaccard；反向词单独一层（剔除反向词后仍高度重叠，且恰有一方含反向词）。
 *
 * 边界：**文件内**比对（跨文件先不做）；输入空 → `[]`；每份文件最多 `CONFLICT_MAX_PAIRS_PER_FILE` 对。
 */

/** 冲突库的输入：一条记忆的正文 + 创建时间（时间缺失给 null） */
export interface MemoryConflictEntry {
  text: string;
  created: string | null;
}

/** 判定理由（文案即标签，UI 直接消费） */
export type MemoryConflictReason = "高度重复（建议合并）" | "明显相关" | "表述可能反向";

/** 一对候选对照 */
export interface MemoryConflictPair {
  aText: string;
  bText: string;
  aCreated: string | null;
  bCreated: string | null;
  /** Jaccard 相似度（0–1，越大越像；不去整，便于排错） */
  score: number;
  reasons: MemoryConflictReason[];
}

/** 候选门槛：Jaccard ≥ 此值才进入对照（低于此值视为无关，不打扰） */
export const CONFLICT_CANDIDATE_THRESHOLD = 0.25;
/** 高度重复门槛：≥ 此值判为「高度重复（建议合并）」，否则「明显相关」 */
export const CONFLICT_DUPLICATE_THRESHOLD = 0.5;
/** 反向 tag 门槛：剔除反向词后 overlap ≥ 此值，且恰有一方含反向词 → 追加「表述可能反向」 */
export const CONFLICT_NEGATION_OVERLAP_THRESHOLD = 0.3;
/** 每份文件最多汇报的对照对数（一屏看得完，不做全量两两） */
export const CONFLICT_MAX_PAIRS_PER_FILE = 8;
/** ASCII 词最短长度：短于此的多为噪声（a / of / to），不进集合 */
export const CONFLICT_MIN_ASCII_TERM_LENGTH = 3;
/** 连续汉字串同时并入整串的最大长度：超过则只取 bigram（控制长句的集合规模） */
export const CONFLICT_MAX_CJK_WHOLE_LENGTH = 4;

/**
 * 反向词表：命中即视为「这条在否决/改口径」。
 * 集中管理，后续按真实误报补词。注意「别」是宽词（"识别" / "特别" 也会命中），
 * 所以它只是**辅助信号**——必须同时满足「剔除后仍高度重叠」才报「表述可能反向」。
 */
export const NEGATION_WORDS: readonly string[] = [
  "不要",
  "不用",
  "别用",
  "别",
  "不再",
  "改用",
  "换成",
  "改为",
  "去掉",
  "删掉",
  "停用",
  "废弃",
  "不得",
  "勿",
  "避免",
  "严禁",
  "绝不",
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 长词优先，避免「别用」被「别」先吃掉一半（集中词表变动也不会改变剔除口径） */
const NEGATION_PATTERN = new RegExp(
  [...NEGATION_WORDS].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|"),
  "g",
);

/**
 * 分词：小写化；非字母数字/汉字整体作为分隔。
 *  - ASCII 数字词：len ≥ 3 才取（`CONFLICT_MIN_ASCII_TERM_LENGTH`），整词入集合；
 *  - 连续汉字串：取 bigram 集合；len ≤ 4 的串同时并入整串（短句整串比碎 bigram 更有辨识度）。
 */
export function terms(text: string): Set<string> {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  // 每次新建正则：带 g 的 exec 有 lastIndex 状态，复用会跨调用串味
  const pattern = /[a-z0-9]+|[\u3400-\u4dbf\u4e00-\u9fff]+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(lower)) !== null) {
    const token = match[0];
    if (/^[a-z0-9]+$/.test(token)) {
      if (token.length >= CONFLICT_MIN_ASCII_TERM_LENGTH) out.add(token);
      continue;
    }
    if (token.length <= CONFLICT_MAX_CJK_WHOLE_LENGTH) out.add(token);
    for (let i = 0; i + 1 < token.length; i += 1) out.add(token.slice(i, i + 2));
  }
  return out;
}

/** 集合 Jaccard：|A∩B| / |A∪B|；任一空集 = 0 */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const term of a) if (b.has(term)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** 是否含反向词（未剔除前判） */
export function hasNegation(text: string): boolean {
  return NEGATION_WORDS.some((word) => text.includes(word));
}

/** 剔除反向词后的文本（只用于算反向 tag 的 overlap，不写回任何文件） */
export function stripNegationWords(text: string): string {
  return text.replace(NEGATION_PATTERN, " ");
}

/**
 * 在**同一份文件**的条目里找疑似重复 / 相反的候选对。
 * 每对按 score 降序返回，最多 `CONFLICT_MAX_PAIRS_PER_FILE` 对；没有任何候选 → `[]`。
 */
export function findMemoryConflicts(entries: readonly MemoryConflictEntry[]): MemoryConflictPair[] {
  const prepared = entries.map((entry) => {
    const text = normalizeOriginEntryText(entry.text);
    return {
      text,
      created: entry.created,
      termSet: terms(text),
      strippedSet: terms(stripNegationWords(text)),
      negated: hasNegation(text),
    };
  });

  const pairs: MemoryConflictPair[] = [];
  for (let i = 0; i < prepared.length; i += 1) {
    for (let j = i + 1; j < prepared.length; j += 1) {
      const a = prepared[i];
      const b = prepared[j];
      const score = jaccard(a.termSet, b.termSet);
      if (score < CONFLICT_CANDIDATE_THRESHOLD) continue;

      const reasons: MemoryConflictReason[] = [
        score >= CONFLICT_DUPLICATE_THRESHOLD ? "高度重复（建议合并）" : "明显相关",
      ];
      // 恰有一方含反向词（双方都含或都不含时不报，避免「两条都在说不要 X」被误标为反向）
      if (
        a.negated !== b.negated &&
        jaccard(a.strippedSet, b.strippedSet) >= CONFLICT_NEGATION_OVERLAP_THRESHOLD
      ) {
        reasons.push("表述可能反向");
      }

      pairs.push({
        aText: a.text,
        bText: b.text,
        aCreated: a.created,
        bCreated: b.created,
        score,
        reasons,
      });
    }
  }

  // 同分时保持输入顺序（V8 sort 稳定），保证同一份文件两次跑结果一致
  pairs.sort((x, y) => y.score - x.score);
  return pairs.slice(0, CONFLICT_MAX_PAIRS_PER_FILE);
}
