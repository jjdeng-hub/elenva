// 预算护栏（lib/budget-guard.ts）的自检：
// 纯函数层（不限 / 单侧超 / 双侧超 / 精确等于边界 / 负值与 NaN 容错 / note 文案 / 去重档位）
// + 磁盘层（读写容错 / 整条替换语义）+ 路由层（setBudgets 校验链路：合法落盘 / 非法 400 不落盘）
// + 调用点静态核对（agent-runtime / 观测栏 / 设置页）。
// 运行：node tools/budget-guard-selftest.mjs
//
// 隔离：PI_CODING_AGENT_DIR 指向 mkdtemp 出来的临时目录，全用**虚构**数据，
// 不碰真实 ~/.pi/agent。lib/*.ts 是纯 TS（无 JSX），jiti 可直载（见记忆 F1/F3）。
import { createJiti } from "jiti";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "elenva-budget-guard-selftest-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const gulib = await jiti.import("../lib/budget-guard.ts");
const { parseBudgets, parseBudgetsInput, checkBudgets, formatBudgetNote, budgetBucket, approachingBudgets, formatApproachNote } = gulib;

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
/** 异步用例（路由层）：同样的 PASS/FAIL 口径 */
const checkAsync = async (name, fn) => {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
};
const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};
const eq = (actual, expected, message) =>
  assert(
    actual === expected,
    `${message}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`,
  );
const deepEq = (actual, expected, message) =>
  eq(JSON.stringify(actual), JSON.stringify(expected), message);

const settingsPath = () => join(agentDir, "elenva-guardrails.json");

/* ---------------- 1. checkBudgets：不限 / 命中 / 边界 ---------------- */

check("不限（缺省 / 空对象 / null / undefined）→ 永不命中", () => {
  for (const budgets of [{}, null, undefined]) {
    const r = checkBudgets({ dailySpent: 999, sessionSpent: 999, budgets });
    eq(r.exceeded.length, 0, `exceeded 应为空（budgets=${JSON.stringify(budgets)}）`);
    eq(r.note, null, "note 应为 null");
  }
});

check("只有上限、花费为 0 → 不命中（0 > 正值 为假）", () => {
  const r = checkBudgets({ dailySpent: 0, sessionSpent: 0, budgets: { dailyUsd: 1, sessionUsd: 1 } });
  eq(r.exceeded.length, 0, "exceeded 应为空");
  eq(r.note, null, "note 应为 null");
});

check("单侧超（日）→ exceeded 一项 + 人话 note", () => {
  const r = checkBudgets({ dailySpent: 1.23, sessionSpent: 0.1, budgets: { dailyUsd: 1 } });
  deepEq(r.exceeded, [{ scope: "daily", spent: 1.23, limit: 1 }], "exceeded");
  eq(r.note, "今日已花费 $1.23，超过设定上限 $1.00", "note");
});

check("单侧超（会话）→ exceeded 一项 + 人话 note", () => {
  const r = checkBudgets({ dailySpent: 0.1, sessionSpent: 2, budgets: { sessionUsd: 1.5 } });
  deepEq(r.exceeded, [{ scope: "session", spent: 2, limit: 1.5 }], "exceeded");
  eq(r.note, "本会话已花费 $2.00，超过设定上限 $1.50", "note");
});

check("双侧超 → 两项固定顺序（daily → session）+ 一句话说清", () => {
  const r = checkBudgets({
    dailySpent: 3.2,
    sessionSpent: 4.5,
    budgets: { dailyUsd: 3, sessionUsd: 4 },
  });
  deepEq(r.exceeded, [
    { scope: "daily", spent: 3.2, limit: 3 },
    { scope: "session", spent: 4.5, limit: 4 },
  ], "exceeded 顺序与内容");
  eq(
    r.note,
    "今日已花费 $3.20，超过设定上限 $3.00；本会话已花费 $4.50，超过设定上限 $4.00",
    "note",
  );
});

check("精确等于边界 → 不算超（spent > limit 才超，测试钉死）", () => {
  const r = checkBudgets({ dailySpent: 1, sessionSpent: 2, budgets: { dailyUsd: 1, sessionUsd: 2 } });
  eq(r.exceeded.length, 0, "等于上限不算超");
  eq(r.note, null, "note 应为 null");
  // 只比边界多一分钱就算超
  const over = checkBudgets({ dailySpent: 1.01, sessionSpent: 2, budgets: { dailyUsd: 1, sessionUsd: 2 } });
  eq(over.exceeded.length, 1, "多 0.01 即超");
  eq(over.exceeded[0].scope, "daily", "超的是 daily");
});

check("上限 0：花费 0 不超、花费 >0 必超（0 是合法非负上限）", () => {
  eq(checkBudgets({ dailySpent: 0, sessionSpent: 0, budgets: { dailyUsd: 0 } }).exceeded.length, 0, "0 花费");
  const r = checkBudgets({ dailySpent: 0.01, sessionSpent: 0, budgets: { dailyUsd: 0 } });
  deepEq(r.exceeded, [{ scope: "daily", spent: 0.01, limit: 0 }], "有花费即超");
});

check("负值与 NaN 容错：非法上限视为不限，非法花费视为 0", () => {
  for (const bad of [-1, -0.01, NaN, Infinity, -Infinity, "1", true, {}, []]) {
    const r = checkBudgets({ dailySpent: 100, sessionSpent: 100, budgets: { dailyUsd: bad, sessionUsd: bad } });
    eq(r.exceeded.length, 0, `非法上限 ${String(bad)} 应视为不限`);
  }
  // 花费为 NaN / 负数 → 归一为 0，不误报
  const spentBad = checkBudgets({ dailySpent: NaN, sessionSpent: -5, budgets: { dailyUsd: 0, sessionUsd: 0 } });
  eq(spentBad.exceeded.length, 0, "非法花费归一为 0，不应超 0 上限");
});

/* ---------------- 2. parseBudgets / parseBudgetsInput ---------------- */

check("parseBudgets（读盘容错）：非负有限数才收，其余逐键丢弃", () => {
  deepEq(parseBudgets({ dailyUsd: 1.5, sessionUsd: 2 }), { dailyUsd: 1.5, sessionUsd: 2 }, "合法全收");
  deepEq(parseBudgets({ dailyUsd: -1, sessionUsd: 2 }), { sessionUsd: 2 }, "负数丢弃");
  deepEq(parseBudgets({ dailyUsd: NaN }), {}, "NaN 丢弃");
  deepEq(parseBudgets({ dailyUsd: 0 }), { dailyUsd: 0 }, "0 保留");
  for (const bad of [null, undefined, 42, "x", [], true]) {
    deepEq(parseBudgets(bad), {}, `非对象 ${JSON.stringify(bad)} → {}`);
  }
});

check("parseBudgetsInput（写入校验）：合法 → ok；非法 → error", () => {
  const ok = parseBudgetsInput({ dailyUsd: 1.5, sessionUsd: null });
  eq(ok.ok, true, "null 是合法的「不限」");
  deepEq(ok.budgets, { dailyUsd: 1.5 }, "只留合法键");
  deepEq(parseBudgetsInput(null).budgets, {}, "null 整体 → 空");
  deepEq(parseBudgetsInput(undefined).budgets, {}, "undefined 整体 → 空");
  deepEq(parseBudgetsInput({ dailyUsd: 0 }).budgets, { dailyUsd: 0 }, "0 合法");

  for (const [key, bad] of [
    ["dailyUsd", -1],
    ["dailyUsd", NaN],
    ["dailyUsd", Infinity],
    ["sessionUsd", -0.01],
    ["sessionUsd", "1"],
    ["sessionUsd", true],
  ]) {
    const r = parseBudgetsInput({ [key]: bad });
    eq(r.ok, false, `${key}=${String(bad)} 应被拒`);
    assert(typeof r.error === "string" && r.error.length > 0, "应给出错误文案");
  }
  eq(parseBudgetsInput("nope").ok, false, "非对象应被拒");
  eq(parseBudgetsInput([]).ok, false, "数组应被拒");
});

/* ---------------- 3. formatBudgetNote / budgetBucket ---------------- */

check("formatBudgetNote：空 / null → null；有项 → 拼接", () => {
  eq(formatBudgetNote([]), null, "空数组");
  eq(formatBudgetNote(null), null, "null");
  eq(formatBudgetNote([{ scope: "session", spent: 1, limit: 0.5 }]), "本会话已花费 $1.00，超过设定上限 $0.50", "单项");
});

check("budgetBucket：刚超 vs 再超 50%", () => {
  eq(budgetBucket(1.0, 1), "over", "等于上限 → over（不会出现在 exceeded 里，仅兜底）");
  eq(budgetBucket(1.4, 1), "over", "1.4× → over");
  eq(budgetBucket(1.5, 1), "far", "1.5× → far");
  eq(budgetBucket(2, 1), "far", "2× → far");
  // 上限 0 的除零保护：不给 far
  eq(budgetBucket(10, 0), "over", "limit=0 时应落 over");
});

check("approachingBudgets：达 80% 但未超才命中（借鉴 LiteLLM 80% 分级）", () => {
  const near = approachingBudgets({ dailySpent: 0.79, sessionSpent: 0.8, budgets: { dailyUsd: 1, sessionUsd: 1 } });
  // 0.79 < 80% 不命中；0.8 恰好到 80% 命中
  deepEq(near.map((n) => [n.scope, Math.round(n.ratio * 100)]), [["session", 80]], "80% 边界");
  // 已超的 scope 不进这里（避免与 checkBudgets 重复）
  const over = approachingBudgets({ dailySpent: 1.2, sessionSpent: 0.9, budgets: { dailyUsd: 1, sessionUsd: 1 } });
  deepEq(over.map((n) => n.scope), ["session"], "已超的 daily 不算 near");
  // 上限 0 / 负数 / 缺省：无「接近」语义
  eq(approachingBudgets({ dailySpent: 0, sessionSpent: 0, budgets: { dailyUsd: 0, sessionUsd: -1 } }).length, 0, "0 / 负上限不报 near");
  eq(approachingBudgets({ dailySpent: 0, sessionSpent: 0, budgets: {} }).length, 0, "不限不报 near");
});

check("formatApproachNote：文案与「超过」区分（说「已达 …%」）", () => {
  eq(formatApproachNote([]), null, "空数组");
  eq(
    formatApproachNote([{ scope: "daily", spent: 0.85, limit: 1, ratio: 0.85 }]),
    "今日已花费 $0.85，已达设定上限 $1.00 的 85%",
    "near 文案",
  );
});

/* ---------------- 4. 磁盘层 + 路由层（真实写盘 / 重读） ---------------- */

const settingsLib = await jiti.import("../lib/guardrail-settings.ts");
const { readGuardrailSettings, writeBudgets, DEFAULT_GUARDRAIL_SETTINGS } = settingsLib;
const route = await jiti.import("../app/api/guardrails/route.ts");
const postGuardrails = async (body) => {
  const res = await route.POST(new Request("http://localhost/api/guardrails", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: res.status, data: await res.json() };
};

check("默认设置含 budgets 且为空（不限）", () => {
  assert("budgets" in DEFAULT_GUARDRAIL_SETTINGS, "DEFAULT 应含 budgets");
  deepEq(DEFAULT_GUARDRAIL_SETTINGS.budgets, {}, "默认应为空 = 不限");
});

checkAsync("磁盘层：writeBudgets 整条替换（缺省键被清掉），读盘容错丢非法值", async () => {
  const path = settingsPath();
  rmSync(path, { force: true });

  writeBudgets({ dailyUsd: 1.5, sessionUsd: 3 }, path);
  deepEq(readGuardrailSettings(path).budgets, { dailyUsd: 1.5, sessionUsd: 3 }, "seed 落盘");

  // 只传日上限 → 会话上限应被清（整条替换，不是补丁）
  writeBudgets({ dailyUsd: 2 }, path);
  deepEq(readGuardrailSettings(path).budgets, { dailyUsd: 2 }, "缺省键应被清");

  // 直接往盘里塞脏值 → 读盘容错丢弃
  const { writeFileSync } = await import("node:fs");
  writeFileSync(path, JSON.stringify({ version: 1, budgets: { dailyUsd: -1, sessionUsd: NaN } }), "utf8");
  deepEq(readGuardrailSettings(path).budgets, {}, "脏值读盘应丢弃");
});

await checkAsync("路由集成：setBudgets 合法落盘 → 重读磁盘；GET 回读 budgets", async () => {
  const path = settingsPath();
  rmSync(path, { force: true });

  const save = await postGuardrails({ action: "setBudgets", dailyUsd: 1.5, sessionUsd: 3 });
  eq(save.status, 200, "保存状态码");
  deepEq(save.data.budgets, { dailyUsd: 1.5, sessionUsd: 3 }, "响应 budgets");
  deepEq(readGuardrailSettings(path).budgets, { dailyUsd: 1.5, sessionUsd: 3 }, "重读磁盘一致");

  // 清空 = 不限
  const clear = await postGuardrails({ action: "setBudgets", dailyUsd: null, sessionUsd: null });
  eq(clear.status, 200, "清空状态码");
  deepEq(clear.data.budgets, {}, "清空后为空");
  deepEq(readGuardrailSettings(path).budgets, {}, "磁盘也清空");

  // GET 回读
  const get = await route.GET(new Request("http://localhost/api/guardrails"));
  const body = await get.json();
  assert("budgets" in body, "GET 应返回 budgets 字段");
  deepEq(body.budgets, {}, "GET budgets 与磁盘一致");
});

await checkAsync("路由集成：非法上限 400 且不落盘（写前校验不能只挡一半）", async () => {
  const path = settingsPath();
  rmSync(path, { force: true });
  await postGuardrails({ action: "setBudgets", dailyUsd: 2, sessionUsd: 2 });

  for (const bad of [
    { dailyUsd: -1 },
    // NaN 经 JSON 会变 null（合法的「不限」），所以 HTTP 层改用字符串 / 布尔表达非法
    { dailyUsd: "abc" },
    { sessionUsd: -0.5 },
    { sessionUsd: true },
  ]) {
    const r = await postGuardrails({ action: "setBudgets", ...bad });
    eq(r.status, 400, `非法载荷 ${JSON.stringify(bad)} 应 400`);
  }
  // 400 之后磁盘仍是上一次的合法值，没被脏值污染
  deepEq(readGuardrailSettings(path).budgets, { dailyUsd: 2, sessionUsd: 2 }, "400 不落盘");
  // 未知 action 仍 400（回归保护）
  const unknown = await postGuardrails({ action: "nope" });
  eq(unknown.status, 400, "未知 action 400");
});

/* ---------------- 5. 调用点静态核对（防分层绿、链路断） ---------------- */

const readSource = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

check("纯函数模块无 node: / 运行时导入（客户端边界）", () => {
  const source = readSource("lib/budget-guard.ts");
  assert(!/from "node:/.test(source), "不得出现 node: 导入（会把 fs 拖进客户端包）");
  const imports = source.split("\n").filter((line) => /^\s*import\b/.test(line));
  eq(imports.length, 0, `纯函数模块不应有任何 import（实际 ${imports.length} 行）`);
});

check("guardrail-settings：budgets 结构 / 解析 / 写入入口都在", () => {
  const source = readSource("lib/guardrail-settings.ts");
  assert(/budgets: BudgetSettings;/.test(source), "接口应含 budgets");
  assert(/budgets: \{\},/.test(source), "默认值应为空");
  assert(/budgets: parseBudgets\(stored\.budgets\)/.test(source), "读盘应解析该字段");
  assert(/export function writeBudgets\(/.test(source), "应导出 writeBudgets");
});

check("路由：GET 带 budgets、POST 有 setBudgets 且写前用纯函数校验", () => {
  const source = readSource("app/api/guardrails/route.ts");
  assert(/budgets: settings\.budgets,/.test(source), "GET 应返回 budgets");
  assert(/case "setBudgets": \{/.test(source), "POST 应有 setBudgets");
  assert(/parseBudgetsInput\(/.test(source), "写入前应走纯函数校验");
});

check("agent-runtime：每轮结束检查 + 60s TTL 缓存 + 去重键 + notice 通道 + 80% 分级", () => {
  const source = readSource("lib/agent-runtime.ts");
  assert(/TODAY_COST_CACHE_TTL_MS = 60_000/.test(source), "应有 60s TTL 常量");
  assert(/getTodayCostCached\(/.test(source), "应有今日花费缓存层");
  assert(/aggregateUsage\(\)/.test(source), "缓存层应基于 aggregateUsage");
  assert(/async function runBudgetCheck\(/.test(source), "应有每轮预算检查");
  assert(/notifiedBudgetKeys/.test(source), "应有每会话去重键");
  assert(/checkBudgets\(spent\)/.test(source), "应调用 checkBudgets");
  assert(/approachingBudgets\(spent\)/.test(source), "应调用 approachingBudgets（80% 分级）");
  assert(/\$\{item\.scope\}:near/.test(source), "near 档应计去重键");
  assert(/session\.notify\(parts\.join\("；"\), "warning"\)/.test(source), "应走 notice 通道推 warning");
  assert(/onAgentRunComplete: \(completedSessionId\)/.test(source), "应挂在每轮结束回调上");
  assert(/void runBudgetCheck\(finished, notifiedBudgetKeys\)/.test(source), "回调应触发检查");
  // 只提示：不得出现任何拦截/拒绝路径的接线
  assert(!/budget.*abort|abort.*budget/i.test(source), "预算不得接入 abort/拒绝执行路径");
});

check("观测栏：运行统计在设了会话上限时附「 / 上限 $Y」，超出 danger / 达 80% warn", () => {
  const source = readSource("components/SessionObservatory.tsx");
  assert(/sessionLimit = budgets\?\.sessionUsd/.test(source), "应读取会话上限");
  assert(/\/ 上限 \$\{formatCost\(sessionLimit\)\}/.test(source), "摘要应附「 / 上限 $Y」");
  assert(/overSessionLimit \? "font-semibold text-danger"/.test(source), "超出应用 danger 色");
  assert(/nearSessionLimit && "font-semibold text-warn"/.test(source), "达 80% 应用 warn 色");
});

check("设置页：有「花费上限」小节，两个输入 + setBudgets 写入，且写明只提示不拦截", () => {
  const source = readSource("components/SettingsPage.tsx");
  assert(/花费上限/.test(source), "应有「花费上限」小节");
  assert(/只提示不拦截/.test(source), "应写明只提示不拦截");
  assert(/action: "setBudgets"/.test(source), "应调用 setBudgets");
  assert(/dailyDraft/.test(source) && /sessionDraft/.test(source), "应有日 / 会话两个输入");
});

check("ChatView：把 budgets 透传给观测栏", () => {
  const source = readSource("components/ChatView.tsx");
  assert(/budgets=\{budgets\}/.test(source), "应把 budgets 传给 SessionObservatory");
  assert(/setBudgets\(d\.budgets \?\? \{\}\)/.test(source), "应从 /api/guardrails 取 budgets");
});

rmSync(root, { recursive: true, force: true });

console.log(fail === 0 ? "\n全部通过" : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
