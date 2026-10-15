// 记忆冲突候选（lib/memory-conflicts.ts）的自检：分词 / 阈值 / 反向 tag / 排序 / 上限 / 确定性。
// 运行：node tools/memory-conflicts-selftest.mjs
//
// 全用**虚构**数据（ASCII 单词与自造中文句），不碰真实记忆文件。
// lib/*.ts 是纯 TS（无 JSX），jiti 可直载（.tsx 不行，见记忆 F1）。
import { createJiti } from "jiti";
import assert from "node:assert/strict";

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const lib = await jiti.import("../lib/memory-conflicts.ts");
const {
  findMemoryConflicts,
  terms,
  jaccard,
  hasNegation,
  stripNegationWords,
  NEGATION_WORDS,
  CONFLICT_CANDIDATE_THRESHOLD,
  CONFLICT_DUPLICATE_THRESHOLD,
  CONFLICT_NEGATION_OVERLAP_THRESHOLD,
  CONFLICT_MAX_PAIRS_PER_FILE,
} = lib;

let fail = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
};

const entry = (text, created = null) => ({ text, created });
const find = (entries) => findMemoryConflicts(entries);
const only = (entries) => {
  const pairs = find(entries);
  assert.equal(pairs.length, 1, `期望恰好 1 对，实得 ${pairs.length}`);
  return pairs[0];
};

/* ============================ 常量与词表 ============================ */

check("① 阈值与上限常量导出且取任务书定稿值", () => {
  assert.equal(CONFLICT_CANDIDATE_THRESHOLD, 0.25);
  assert.equal(CONFLICT_DUPLICATE_THRESHOLD, 0.33);
  assert.equal(CONFLICT_NEGATION_OVERLAP_THRESHOLD, 0.3);
  assert.equal(CONFLICT_MAX_PAIRS_PER_FILE, 8);
  for (const word of ["不要", "不用", "别用", "别", "不再", "改用", "换成", "改为", "去掉", "删掉", "停用", "废弃", "不得", "勿", "避免", "严禁", "绝不"]) {
    assert.ok(NEGATION_WORDS.includes(word), `反向词表缺 ${word}`);
  }
});

/* ============================ 分词 ============================ */

check("② 分词：ASCII 词 len≥3、连续汉字取 bigram、短串并入整串", () => {
  assert.deepEqual([...terms("a of to alpha")], ["alpha"], "len<3 的 ASCII 词应被丢掉");
  assert.deepEqual([...terms("Memory MEMORY")], ["memory"], "应小写化并去重");
  // 4 字串：整串 + 3 个 bigram
  assert.deepEqual([...terms("记忆条目")].sort(), ["忆条", "条目", "记忆", "记忆条目"].sort());
  // 5 字串：只有 4 个 bigram，不含整串
  assert.equal(terms("记忆条目库").size, 4);
  assert.equal(terms("！！！").size, 0, "非字母数字/汉字不算词");
});

/* ============================ 阈值两侧 ============================ */

/** 造确定长度的 ASCII 词表（len≥3，不会被分词丢掉），用于精确构造 Jaccard 边界值 */
const words = (prefix, count) => Array.from({ length: count }, (_, i) => `${prefix}${i}`);

check("③ 高度重复门槛 0.33 恰好命中（33/100 → 「高度重复（建议合并）」）", () => {
  // 交 33 / 并 100 = 0.33（共享 33 词，各自独有 33 / 34 词）
  const shared = words("common", 33);
  const pair = only([
    entry([...shared, ...words("aonly", 33)].join(" ")),
    entry([...shared, ...words("bonly", 34)].join(" ")),
  ]);
  assert.equal(pair.score, 0.33);
  assert.deepEqual(pair.reasons, ["高度重复（建议合并）"]);
});

check("④ 低于 0.33（8/25 = 0.32）只判「明显相关」", () => {
  // 交 8 / 并 25 = 0.32（共享 8 词，各自独有 8 / 9 词）
  const shared = words("common", 8);
  const pair = only([
    entry([...shared, ...words("aonly", 8)].join(" ")),
    entry([...shared, ...words("bonly", 9)].join(" ")),
  ]);
  assert.equal(pair.score, 0.32);
  assert.deepEqual(pair.reasons, ["明显相关"]);
});

check("⑤ 候选门槛 0.25 恰好命中、略低（0.222）不命中", () => {
  // 交 2 / 并 8 = 0.25
  const on = only([entry("alpha bravo charlie delta echo"), entry("delta echo foxtrot golf hotel")]);
  assert.equal(on.score, 0.25);
  assert.deepEqual(on.reasons, ["明显相关"]);
  // 交 2 / 并 9 ≈ 0.222 < 0.25
  assert.deepEqual(find([entry("alpha bravo charlie delta echo"), entry("delta echo foxtrot golf hotel india")]), []);
});

/* ============================ 反向 tag 三态 ============================ */

check("⑥ 恰一方含反向词 → 追加「表述可能反向」", () => {
  const pair = only([entry("不要 alpha bravo charlie delta"), entry("alpha bravo charlie delta")]);
  assert.deepEqual(pair.reasons, ["高度重复（建议合并）", "表述可能反向"]);
});

check("⑦ 双方都含反向词 → 不加（避免「两条都在说不要」被误标反向）", () => {
  const pair = only([entry("不要 alpha bravo charlie delta"), entry("绝不 alpha bravo charlie delta")]);
  assert.deepEqual(pair.reasons, ["高度重复（建议合并）"]);
});

check("⑧ 双方都不含反向词 → 不加", () => {
  const pair = only([entry("alpha bravo charlie"), entry("bravo charlie delta")]);
  assert.ok(!pair.reasons.includes("表述可能反向"));
});

check("⑨ 反向 tag 用的是「剔除反向词后」的 overlap（原始 0.273 不够、剔除后 0.3 达标）", () => {
  const a = "不要 alpha bravo charlie";
  const b = "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
  const rawOverlap = jaccard(terms(a), terms(b));
  const strippedOverlap = jaccard(terms(stripNegationWords(a)), terms(stripNegationWords(b)));
  assert.ok(rawOverlap < 0.3 && rawOverlap >= 0.25, `原始 overlap 应为候选内的 0.273，实得 ${rawOverlap}`);
  assert.ok(strippedOverlap >= 0.3, `剔除后 overlap 应达 0.3，实得 ${strippedOverlap}`);
  assert.equal(hasNegation(a), true);
  assert.equal(hasNegation(b), false);
  const pair = only([entry(a), entry(b)]);
  assert.ok(pair.reasons.includes("表述可能反向"), "剔除后达标但原始不达标 —— 证明用的是剔除后的 overlap");
});

/* ============================ 排序 / 上限 / 空输入 ============================ */

check("⑩ 按 score 降序返回", () => {
  const pairs = find([
    entry("alpha bravo charlie delta echo"),
    entry("alpha bravo charlie delta echo"),
    entry("alpha bravo charlie foxtrot golf"),
  ]);
  assert.equal(pairs.length, 3);
  assert.equal(pairs[0].score, 1);
  for (let i = 1; i < pairs.length; i += 1) {
    assert.ok(pairs[i - 1].score >= pairs[i].score, `第 ${i} 项未降序：${pairs[i - 1].score} < ${pairs[i].score}`);
  }
});

check("⑪ 每文件最多 8 对（C(10,2)=45 对截到 8）", () => {
  const many = Array.from({ length: 10 }, () => entry("重复条目示例文本内容一致"));
  const pairs = find(many);
  assert.equal(pairs.length, 8);
  assert.equal(pairs.length, CONFLICT_MAX_PAIRS_PER_FILE);
});

check("⑫ 空输入 / 单条 → []", () => {
  assert.deepEqual(find([]), []);
  assert.deepEqual(find([entry("alpha bravo charlie")]), []);
});

/* ============================ 中文路径 / 归一 / 确定性 ============================ */

check("⑬ 中文同题命中，且返回的正文已归一（剥掉尾部元数据注释）", () => {
  const clean = "记忆条目尾部会带一个创建时间注释";
  const entryA = entry(`${clean} <!-- created=2020-01-01, last=2020-01-01 -->`, "2020-01-01");
  const entryB = entry(`${clean}，用于展示`, "2021-02-02");
  const pair = only([entryA, entryB]);
  assert.ok(pair.score >= CONFLICT_DUPLICATE_THRESHOLD, `同题中文相似度应达高度重复，实得 ${pair.score}`);
  assert.deepEqual(pair.reasons, ["高度重复（建议合并）"]);
  assert.equal(pair.aText, clean, "aText 应是剥离元数据注释后的正文");
  assert.ok(!pair.aText.includes("<!--"), "正文里不应残留 created 注释");
  assert.equal(pair.bText, `${clean}，用于展示`);
  assert.equal(pair.aCreated, "2020-01-01");
  assert.equal(pair.bCreated, "2021-02-02");
});

check("⑭ 确定性：同一输入跑两次结果完全一致", () => {
  const input = [
    entry("不要 alpha bravo charlie delta"),
    entry("alpha bravo charlie delta"),
    entry("绝不 alpha bravo charlie delta"),
    entry("记忆条目尾部会带一个创建时间注释"),
    entry("记忆条目尾部会带一个创建时间注释，用于展示"),
  ];
  assert.deepEqual(find(input), find(input));
});

console.log(fail === 0 ? `\n全部通过（14 项）` : `\n失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
