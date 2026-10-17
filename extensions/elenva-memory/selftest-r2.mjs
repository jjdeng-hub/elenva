/**
 * elenva-memory R2r1 自检：写路径闭环（近满预警 / 满额引导 / 复盘预算感知）。
 *
 * 三块（对应任务书 §验证）：
 *   1) 水位矩阵：fresh(<85%) / near(≥85%) / full(>100%) × add/replace/remove 返回文案断言；
 *   2) 引导回路 E2E：隔离 agentDir 造 ~90%+ 文件 → add 触发引导 → 脚本执行合并 → 重试 add
 *      成功 → 水位回落有数字断言；
 *   3) 复盘输入断言：构造含水位字段的输入 → 生成 prompt 含水位与「必须合并」规则。
 *
 * 跑法：node extensions/elenva-memory/selftest-r2.mjs
 * 全绿输出 SELFTEST-R2: OK；有失败输出 SELFTEST-R2: FAILED 并以退出码 1 结束。
 *
 * 注意：必须在 import 任何 vendor 模块**之前**设好 PI_CODING_AGENT_DIR——vendor 的
 * `paths.ts` 在模块加载期就把 AGENT_ROOT 定死了。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "elenva-memory-r2-"));
const agentRoot = path.join(tmpRoot, "agent");
fs.mkdirSync(agentRoot, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentRoot;

const jiti = createJiti(import.meta.url, { moduleCache: false, interopDefault: true });

let pass = 0;
let fail = 0;
const check = (name, condition, extra = "") => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
  condition ? (pass += 1) : (fail += 1);
};

const { MemoryStore } = await jiti.import("./vendor/pi-hermes-memory/src/store/memory-store.ts");
const { loadConfig } = await jiti.import("./vendor/pi-hermes-memory/src/config.ts");
const constants = await jiti.import("./vendor/pi-hermes-memory/src/constants.ts");
const storesModule = await jiti.import("./stores.ts");
const reviewModule = await jiti.import("./vendor/pi-hermes-memory/src/handlers/background-review.ts");
const {
  DEFAULT_NEAR_FULL_THRESHOLD,
  MEMORY_BUDGET_MERGE_THRESHOLD_PERCENT,
  buildMemoryBudgetSection,
  COMBINED_REVIEW_PROMPT,
  DIRECT_REVIEW_SYSTEM_PROMPT,
  CONSOLIDATION_PROMPT,
  DIRECT_CONSOLIDATION_SYSTEM_PROMPT,
} = constants;

const LIMIT = 1000;
const DELIMITER = "\n§\n";

/** 定长（width 个 UTF-16 code unit）且互不相同的填充条目；不带元数据，charCount 可直接算。 */
const filler = (i, width = 100) => {
  const head = `filler-${String(i).padStart(2, "0")} `;
  return head + "字".repeat(width - head.length);
};
const seeds = (n) => Array.from({ length: n }, (_, i) => filler(i));

/** 造一个隔离的 store：文件直写（模拟真实落盘形态），cap 强制开启（policy-only 下 capEnforced=false）。 */
async function storeWith(dirName, texts, opts = {}) {
  const dir = path.join(tmpRoot, dirName);
  fs.mkdirSync(dir, { recursive: true });
  if (texts) fs.writeFileSync(path.join(dir, "MEMORY.md"), texts.join(DELIMITER), "utf8");
  const config = {
    ...loadConfig(),
    memoryMode: "legacy-inject", // 强制 capEnforced=true，复现 reject/引导路径
    memoryCharLimit: LIMIT,
    userCharLimit: LIMIT,
    nearFullThreshold: DEFAULT_NEAR_FULL_THRESHOLD,
    memoryDir: dir,
    ...opts,
  };
  const store = new MemoryStore(config);
  await store.loadFromDisk();
  return { store, dir, config };
}

// ── 1. 水位矩阵 ──────────────────────────────────────────────────────────────

// fresh(<85%)：成功、无预警、getUsage 数字自洽
{
  const { store } = await storeWith("fresh-add", seeds(3));
  const before = store.getUsage("memory");
  check("fresh(<85%)：起点 <85%", before.percent < 85, `${before.percent}%`);
  const res = await store.add("memory", "fresh 下的一条小写入。");
  const after = store.getUsage("memory");
  check("fresh add：成功", res.success === true, res.error);
  check("fresh add：成功语义不变（message 为 Entry added）", res.message === "Entry added.", res.message);
  check("fresh add：无近满预警", !/水位/.test(res.message ?? "") && !res.warning);
  check("getUsage 字段与写入一致", typeof res.usage === "string" && res.entry_count === after.entryCount && after.charCount > before.charCount);
}

// near(≥85%)：成功但带 advisory
{
  const { store } = await storeWith("near-add", seeds(9)); // 9×100 + 8×3 = 924 → 92%
  const before = store.getUsage("memory");
  check("near(≥85%)：起点 ≥85%", before.percent >= 85, `${before.percent}%`);
  const res = await store.add("memory", "近满时的一条小写入。");
  const after = store.getUsage("memory");
  check("near add：仍成功（不改变成功语义）", res.success === true, res.error);
  check("near add：返回文本附水位预警", res.success && /⚠ .*水位 \d+%（\d+\/1000）/.test(res.message ?? ""), res.message);
  check("near add：预警含示例对象 + 字符数", /示例对象：.*filler-.*（100 字符）/.test(res.message ?? ""));
  check("near add：预警也进 warnings 字段", Array.isArray(res.warnings) && res.warnings.some((w) => /水位/.test(w)));
  check("near add：机器可读部分未变", typeof res.usage === "string" && typeof res.entry_count === "number");
  check("near add：水位确实上升", after.charCount > before.charCount, `${before.percent}%→${after.percent}%`);
}

// full(>100%) × add：拒绝 + 结构化引导
{
  const { store } = await storeWith("full-add", seeds(11)); // 11×100 + 10×3 = 1130 → 113%
  const before = store.getUsage("memory");
  check("full(>100%)：起点 >100%", before.percent > 100, `${before.percent}%`);
  const res = await store.add("memory", "满额时写入的一条内容。");
  check("full add：被拒且带 overflow 标记", res.success === false && res.overflow === true);
  check("full add：含水位/限额数字", /水位 \d+%（\d+\/1000 字符）/.test(res.error ?? ""));
  check("full add：含需腾出字符数", /需先腾出约 \d+ 字符/.test(res.error ?? ""));
  check("full add：含 memory_replace 合并配方", /用 memory_replace 先合并两条最长的/.test(res.error ?? ""));
  check("full add：含 memory_remove 配方", /用 memory_remove 淘汰/.test(res.error ?? ""));
  check("full add：候选对象带摘要 + 字符数", /最长候选对象（3 条/.test(res.error ?? "") && /- 100 字符：「filler-0/.test(res.error ?? ""));
  check("full add：明示不自动截断/删除", /不会自动截断/.test(res.error ?? "") && /不会自动删除/.test(res.error ?? ""));
  check("full add：entries 原文列表仍在（机器可读未变）", Array.isArray(res.entries) && res.entries.length === 11 && res.usage === `${before.charCount}/${LIMIT} chars`);
}

// full(>100%) × replace：替换后仍超限 → 拒绝 + 引导
{
  const { store } = await storeWith("full-replace", seeds(11));
  const res = await store.replace("memory", "filler-00", "更长的替换内容".repeat(30));
  check("full replace（仍超限）：被拒 + overflow", res.success === false && res.overflow === true);
  check("full replace：含替换后水位 + 腾出数字", /替换放不下/.test(res.error ?? "") && /需先腾出约 \d+ 字符/.test(res.error ?? ""));
  check("full replace：含合并配方", /memory_replace/.test(res.error ?? "") && /memory_remove/.test(res.error ?? ""));
}

// full(>100%) × remove：成功；水位下降有数字断言；仍 ≥85% 时继续预警
{
  const { store } = await storeWith("full-remove", seeds(11));
  const before = store.getUsage("memory");
  const res = await store.remove("memory", "filler-00");
  const after = store.getUsage("memory");
  check("full remove：成功", res.success === true, res.error);
  check("full remove：水位回落（数字断言）", after.charCount < before.charCount && after.percent < before.percent, `${before.percent}%→${after.percent}%`);
  check("full remove：仍 ≥85% 时带预警", /水位/.test(res.message ?? ""), res.message);
}

// 阈值可配置：0 关闭、百分比写法等价
{
  const { store } = await storeWith("threshold-off", seeds(9), { nearFullThreshold: 0 });
  const res = await store.add("memory", "关闭预警后的写入。");
  check("nearFullThreshold=0：关闭预警", res.success === true && !/水位/.test(res.message ?? ""));
}

// config 键解析：0..1 比值 / 0..100 百分比
{
  const cfgPath = path.join(tmpRoot, "cfg.json");
  fs.writeFileSync(cfgPath, JSON.stringify({ nearFullThreshold: 90 }), "utf8");
  check("config nearFullThreshold=90 视作 0.9", loadConfig(cfgPath).nearFullThreshold === 0.9);
  fs.writeFileSync(cfgPath, JSON.stringify({ nearFullThreshold: 0.8 }), "utf8");
  check("config nearFullThreshold=0.8 原样保留", loadConfig(cfgPath).nearFullThreshold === 0.8);
  fs.writeFileSync(cfgPath, JSON.stringify({}), "utf8");
  check("缺省 = 默认 0.85", loadConfig(cfgPath).nearFullThreshold === DEFAULT_NEAR_FULL_THRESHOLD);
}

// ── 2. 引导回路 E2E（隔离 agentDir；add 被引导 → 合并 → 重试成功）───────────
{
  const { store, dir } = await storeWith("loop", seeds(9)); // 924 → 92%
  const before = store.getUsage("memory");
  check("E2E 起点：水位 ≥85%", before.percent >= 85, `${before.percent}%`);

  // 这条足够长，加上元数据注释后必然超限（924 + 53 + 44 + 3 > 1000）。
  const pendingEntry = "引导回路新增的一条内容：" + "字".repeat(40);
  const blocked = await store.add("memory", pendingEntry);
  check("E2E ① add 触发引导（本条未写入）", blocked.success === false && blocked.overflow === true, blocked.message);
  check("E2E ① 引导给出候选对象", /filler-00/.test(blocked.error ?? "") && /filler-01/.test(blocked.error ?? ""));

  // 脚本执行一次 replace，把最长的两条合成一条，再淘汰被并入的那条。
  const merged = "合并条目：两条填充要点的汇总（唯一填充文本）。";
  const replaced = await store.replace("memory", "filler-01", merged);
  check("E2E ② replace 合并成功", replaced.success === true, replaced.error);
  const removed = await store.remove("memory", "filler-00");
  check("E2E ② 被并入的旧条目淘汰成功", removed.success === true, removed.error);

  const mid = store.getUsage("memory");
  check("E2E ② 合并后水位回落（数字断言）", mid.charCount < before.charCount && mid.percent < before.percent, `${before.percent}%→${mid.percent}%`);

  const retried = await store.add("memory", pendingEntry);
  check("E2E ③ 重试 add 成功", retried.success === true, retried.error);
  const after = store.getUsage("memory");
  check("E2E ③ 写入后仍低于起点水位", after.percent < before.percent, `${before.percent}%→${after.percent}%`);

  const onDisk = fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8");
  check("E2E ④ 合并内容确实落盘", onDisk.includes("合并条目") && onDisk.includes("引导回路新增"));
  check("E2E ④ 被并入的原文已消失", !onDisk.includes("filler-00") && !onDisk.includes("filler-01"));
}

// ── 3. 复盘输入断言（水位字段 → prompt 含水位 + 必须合并规则）───────────────
{
  const usage = { charCount: 4600, limit: 5000, percent: 92, entryCount: 12 };
  const budget = [{ label: "MEMORY.md", ...usage }];
  const section = buildMemoryBudgetSection(budget);
  check("预算段含 chars/limit/percent/entryCount", /MEMORY\.md: 4600\/5000 chars \(92%\), 12 entries/.test(section), section);
  check("预算段含 ≥85 必须合并规则", section.includes(`${MEMORY_BUDGET_MERGE_THRESHOLD_PERCENT}%`) && /MUST emit at least one merge\/condense\/remove/.test(section));

  const input = {
    parts: ["用户: 记住这个偏好", "助手: 好的"],
    currentMemory: "旧条目",
    currentUser: "",
    currentProject: null,
    budget,
  };
  const subprocessPrompt = reviewModule.buildSubprocessReviewPrompt(input);
  check("复盘 prompt 含每目标水位", /MEMORY\.md: 4600\/5000 chars \(92%\), 12 entries/.test(subprocessPrompt));
  check("复盘 prompt 含「≥85% 必须产出合并」", subprocessPrompt.includes("85%") && /merge\/condense\/remove/.test(subprocessPrompt));
  check("复盘 prompt 含好记忆三标准", /applicable/.test(subprocessPrompt) && /durable/.test(subprocessPrompt) && /legible/.test(subprocessPrompt));

  const directPrompt = reviewModule.buildDirectReviewUserPrompt(input);
  check("direct 复盘 prompt 同样带水位", /92%/.test(directPrompt) && /12 entries/.test(directPrompt));

  check("review system prompt 含规则", DIRECT_REVIEW_SYSTEM_PROMPT.includes("85%") && /merge\/condense\/remove/.test(DIRECT_REVIEW_SYSTEM_PROMPT));
  check("review prompt 模板含规则", COMBINED_REVIEW_PROMPT.includes("85%") && /merge\/condense\/remove/.test(COMBINED_REVIEW_PROMPT));
  check("巩固 prompt 含「必须收缩」", /MUST shrink/.test(CONSOLIDATION_PROMPT) && /MUST shrink/.test(DIRECT_CONSOLIDATION_SYSTEM_PROMPT));
}

// ── 4. cap 解耦（enforceCharLimit）+ 口径统一 ───────────────────────────────
{
  // (a) policy-only + 默认 enforce=true → 拒绝路径可达且带引导
  const { store } = await storeWith("po-enforce", seeds(11), { memoryMode: "policy-only" });
  const res = await store.add("memory", "policy-only 下满额写入。");
  check("cap 解耦：policy-only + enforce 默认 → 满额被拒", res.success === false && res.overflow === true, res.message);
  check("cap 解耦：拒绝自带结构化引导", /memory_replace/.test(res.error ?? "") && /需先腾出约 \d+ 字符/.test(res.error ?? ""));
}
{
  // (b) policy-only + enforce=false → 回旧行为（cap 不设防）
  const { store } = await storeWith("po-old", seeds(11), { memoryMode: "policy-only", enforceCharLimit: false });
  const res = await store.add("memory", "policy-only 旧行为下满额写入。");
  const after = store.getUsage("memory");
  check("cap 解耦：enforce=false → 回旧行为（成功且可超限）", res.success === true && after.percent > 100, `${after.percent}%`);
  check("cap 解耦：旧行为下仍带近满预警", /水位/.test(res.message ?? ""));
}
{
  // (c) 键缺省（undefined）→ 按默认 true 执行
  const dir = path.join(tmpRoot, "po-missing");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "MEMORY.md"), seeds(11).join(DELIMITER), "utf8");
  const store = new MemoryStore({
    ...loadConfig(),
    memoryMode: "policy-only",
    enforceCharLimit: undefined,
    memoryCharLimit: LIMIT,
    memoryDir: dir,
  });
  await store.loadFromDisk();
  const res = await store.add("memory", "缺省键下满额写入。");
  check("cap 解耦：enforceCharLimit 缺省 → 默认执行（硬拒）", res.success === false && res.overflow === true);
}
{
  // (d) 口径统一：无显式配置时，索引侧默认 = vendor 常量
  const cfg = storesModule.readHermesConfig(agentRoot);
  check("口径统一：stores 默认 memory = vendor 常量", cfg.memoryCharLimit === constants.DEFAULT_MEMORY_CHAR_LIMIT, `${cfg.memoryCharLimit} vs ${constants.DEFAULT_MEMORY_CHAR_LIMIT}`);
  check("口径统一：stores 默认 user = vendor 常量", cfg.userCharLimit === constants.DEFAULT_USER_CHAR_LIMIT, `${cfg.userCharLimit} vs ${constants.DEFAULT_USER_CHAR_LIMIT}`);
  check("口径统一：stores 默认 project = vendor 常量", cfg.projectCharLimit === constants.DEFAULT_PROJECT_CHAR_LIMIT, `${cfg.projectCharLimit} vs ${constants.DEFAULT_PROJECT_CHAR_LIMIT}`);

  // (e) 显式配置时两处零行为变化（vendor 与索引侧读到同一个显式值）
  const configPath = path.join(agentRoot, "hermes-memory-config.json");
  fs.writeFileSync(configPath, JSON.stringify({ memoryCharLimit: 4321, userCharLimit: 3210, projectCharLimit: 2100 }), "utf8");
  const vendorCfg = loadConfig();
  const indexCfg = storesModule.readHermesConfig(agentRoot);
  check(
    "口径统一：显式配置时 vendor 与 stores 同读显式值",
    vendorCfg.memoryCharLimit === 4321 && indexCfg.memoryCharLimit === 4321 && indexCfg.userCharLimit === 3210 && indexCfg.projectCharLimit === 2100,
  );
  fs.rmSync(configPath, { force: true });
}

// ── 收尾 ─────────────────────────────────────────────────────────────────────
try {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch {
  /* 临时目录清理失败不影响结论 */
}

console.log(`\nSELFTEST-R2: ${fail === 0 ? "OK" : "FAILED"} — ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exitCode = 1;
