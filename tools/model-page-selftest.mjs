// 模型页（变体 C：降噪 + 健康下沉）自检：
// ① 纯函数层 —— 健康数据 ↔ 模型库行的 id 匹配（`lib/model-health-match.ts`）
//    与行内故障标 / 错误摘要的文案口径；
// ② 静态接线层 —— 状态条 / 厂商只展开已配置 / 全宽单列 / 健康下沉模型行 / 高级折叠
//    是否真的落到源码里（改回去会变红）。
// 运行：node tools/model-page-selftest.mjs
//
// 隔离：全用**虚构**数据，纯函数层不读磁盘、不碰真实 ~/.pi/agent。
// lib/*.ts 是纯 TS（无 JSX、无 node 依赖），jiti 可直载。
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const lib = await jiti.import("../lib/model-health-match.ts");
const {
  modelHealthKey,
  lookupModelHealth,
  failingCallText,
  summarizeModelError,
  failingBadgeText,
  FAILING_BADGE_MAX,
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
const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};
const eq = (actual, expected, message) => {
  if (actual !== expected) {
    throw new Error(`${message}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
};

/* ---------------- 1. id 匹配（本轮最容易错的地方） ---------------- */

// 本机实测的那对冤家（2026-10-19 取证）：健康区报 deepseek/deepseek-flash，
// 而模型库里同时存在 deepseek/deepseek-flash（provider=deepseek）与
// opencode-go/deepseek-v4-flash（provider=opencode-go）。
const HEALTH = {
  "deepseek/deepseek-flash": { status: "failing", calls: 2, failures: 2, successRate: 0, lastError: "402: {}" },
  "opencode-go/deepseek-v4-flash": { status: "ok", calls: 10, failures: 0, successRate: 1, lastError: null },
  "opencode-go/cat-jam-free": { status: "failing", calls: 1, failures: 1, successRate: 0, lastError: "403: {}" },
};

check("key 规范化：两侧拼接规则唯一，空白被裁掉", () => {
  eq(modelHealthKey(" deepseek ", " deepseek-flash "), "deepseek/deepseek-flash", "key 应 trim 两侧");
});

check("精确命中：同 provider + 同 id 才算同一个模型", () => {
  const hit = lookupModelHealth(HEALTH, "deepseek", "deepseek-flash");
  eq(hit?.status, "failing", "deepseek/deepseek-flash 应命中");
  eq(lookupModelHealth(HEALTH, "opencode-go", "cat-jam-free")?.calls, 1, "opencode-go/cat-jam-free 应命中");
});

check("跨 provider 同名 id 不得串标（opencode-go/deepseek-v4-flash ≠ deepseek/deepseek-flash）", () => {
  const ok = lookupModelHealth(HEALTH, "opencode-go", "deepseek-v4-flash");
  eq(ok?.status, "ok", "应拿到 opencode-go 自己那条");
  assert(ok !== lookupModelHealth(HEALTH, "deepseek", "deepseek-flash"), "两条不能是同一对象");
  eq(lookupModelHealth(HEALTH, "some-other-provider", "deepseek-flash"), undefined, "换 provider 就不该命中");
});

check("相似 id 不猜：deepseek-flash 不得标到 deepseek-v4-flash 上", () => {
  const onlyV4 = { "opencode-go/deepseek-v4-flash": HEALTH["opencode-go/deepseek-v4-flash"] };
  eq(
    lookupModelHealth(onlyV4, "opencode-go", "deepseek-flash"),
    undefined,
    "缺一段版本号的 id 匹配不上就不标（宁可漏标）",
  );
});

check("大小写不敏感但要求唯一；精确命中优先、有歧义就不标", () => {
  const cased = { "opencode-go/GPT-5.6-Luna": { status: "failing", calls: 1, failures: 1, successRate: 0 } };
  eq(lookupModelHealth(cased, "opencode-go", "gpt-5.6-luna")?.calls, 1, "只差大小写应命中");
  const both = {
    "opencode-go/gpt-5.6-luna": { status: "ok", calls: 1, failures: 0, successRate: 1 },
    "OpenCode-Go/GPT-5.6-Luna": { status: "failing", calls: 1, failures: 1, successRate: 0 },
  };
  eq(lookupModelHealth(both, "opencode-go", "gpt-5.6-luna")?.status, "ok", "有完全一致的那条时以它为准");
  const ambiguous = {
    "OpenCode-Go/GPT-5.6-Luna": { status: "ok", calls: 1, failures: 0, successRate: 1 },
    "OPENCODE-GO/gpt-5.6-LUNA": { status: "failing", calls: 1, failures: 1, successRate: 0 },
  };
  eq(lookupModelHealth(ambiguous, "opencode-go", "gpt-5.6-luna"), undefined, "折叠后有多条 = 有歧义，不标");
});

check("空 provider / 空 id / 空索引：一律取不到（不能撞上 \"/\" 这类野键）", () => {
  eq(lookupModelHealth({ "/deepseek-flash": { status: "failing", calls: 1, failures: 1, successRate: 0 } }, "", "deepseek-flash"), undefined, "空 provider 不命中");
  eq(lookupModelHealth(HEALTH, "deepseek", "  "), undefined, "空 id 不命中");
  eq(lookupModelHealth(undefined, "deepseek", "deepseek-flash"), undefined, "索引缺失不抛错");
});

check("模型库里没有的 id：不命中（历史会话留下的旧 id 不该标到别的模型上）", () => {
  eq(lookupModelHealth(HEALTH, "deepseek", "deepseek-v4.1-flash"), undefined, "模型库 id 是 v4.1-flash，健康侧是 flash，不匹配");
});

/* ---------------- 2. 行内故障标文案 ---------------- */

check("调用数那段：全失败说全失败，部分失败给比例", () => {
  eq(failingCallText({ calls: 4, failures: 4 }), "4 次调用全失败", "全失败");
  eq(failingCallText({ calls: 9, failures: 2 }), "失败 2/9 次", "部分失败");
});

check("错误摘要：三种真实原文都能压成短摘要，且不做中文改写", () => {
  eq(
    summarizeModelError('400: {"type":"server_error","message":"Upstream request failed: Model is unavailable."}'),
    "400 Model is unavailable",
    "冒号前缀噪声应剥掉，取最后一段",
  );
  eq(
    summarizeModelError('402: {"message":"Insufficient Balance (request_id: b18a3c81-ea2f)","type":"unknown_error"}'),
    "402 Insufficient Balance",
    "request_id 这类噪声应剥掉",
  );
  eq(summarizeModelError("opencode-go API error (502): {}"), "502", "只剩状态码时也要给码");
  eq(summarizeModelError("Request timed out."), "Request timed out", "无 JSON 时原文直接用");
  eq(summarizeModelError(null), "", "没有错误信息就返回空串");
});

check("故障标：`有故障 · N 次调用全失败 · 400 …`，且总长有上限", () => {
  eq(
    failingBadgeText({ calls: 4, failures: 4, lastError: '400: {"message":"Upstream request failed: Model is unavailable."}' }),
    "有故障 · 4 次调用全失败 · 400 Model is unavailable",
    "标准形态",
  );
  const long = failingBadgeText({
    calls: 1,
    failures: 1,
    lastError: '403: {"type":"RegionError","message":"This model is not available in your country"}',
  });
  assert(long.length <= FAILING_BADGE_MAX, `超长应被截断（${long.length} > ${FAILING_BADGE_MAX}）`);
  assert(long.endsWith("…"), "截断要有省略号");
  assert(long.startsWith("有故障 · 1 次调用全失败 ·"), "截断不能吃掉前半段的次数信息");
  const noError = failingBadgeText({ calls: 3, failures: 3, lastError: null });
  eq(noError, "有故障 · 3 次调用全失败", "没有错误信息时不留尾巴");
});

/* ---------------- 3. 静态接线核对 ---------------- */

const readSource = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

check("模型页：状态条存在且数据来自模型库汇报（不重复请求 /api/models）", () => {
  const source = readSource("components/ModelsPage.tsx");
  assert(/function ModelStatusBar\(/.test(source), "应有状态条组件");
  assert(/data-testid="model-status-bar"/.test(source), "状态条应有稳定选择器（布局断言用）");
  assert(/<ModelStatusBar[\s\S]{0,200}summary=\{library\}/.test(source), "状态条应消费模型库汇报的摘要");
  assert(/onSummary=\{setLibrary\}/.test(source), "模型库应把摘要汇报上来");
  assert(!/fetch\("\/api\/models"/.test(source), "模型页不得自己再拉一遍 /api/models");
});

check("模型页：全宽单列（双列 grid 已拆），且留了可断言的容器", () => {
  const source = readSource("components/ModelsPage.tsx");
  assert(!/xl:grid-cols-2/.test(source), "双列 grid 应已移除（变体 C 是纵向单列）");
  assert(/data-testid="models-page-stack"/.test(source), "应有布局容器选择器");
  assert(/grid grid-cols-1 gap-5/.test(source), "单列 grid 要写成显式一列，gridTemplateColumns 才能被断言");
});

check("模型页：厂商与密钥常态只列已配置的，未配置靠搜索", () => {
  const source = readSource("components/ModelsPage.tsx");
  assert(/sorted\.filter\(\(p\) => p\.auth \|\| p\.envSet\)/.test(source), "常态列表应只含已配置厂商");
  assert(/data-testid="provider-collapsed-note"/.test(source), "应有「其余 N 个未配置厂商已收起」说明");
  assert(/searching && "max-h-\[26rem\] overflow-y-auto"/.test(source), "固定 max-h 只允许出现在搜索态");
});

check("模型页：健康区退成一行摘要 + 可展开明细", () => {
  const source = readSource("components/ModelsPage.tsx");
  assert(/data-testid="model-health-toggle"/.test(source), "健康区应有展开/收起入口");
  assert(/故障已标在对应模型行/.test(source), "折叠态应说明故障标去哪了");
  assert(/data-testid="model-health-detail"/.test(source), "展开态应有明细容器");
  assert(/if \(expanded && !loaded && !loading\) void load\(\)/.test(source), "明细应懒加载（折叠时不请求）");
  assert(/fetch\("\/api\/model-health"/.test(source), "仍走既有 /api/model-health，不新造统计口径");
});

check("模型页：两张高级卡常态折成一行", () => {
  const source = readSource("components/ModelsPage.tsx");
  assert(/data-testid="custom-provider-toggle"/.test(source), "自定义 Provider 应有折叠开关");
  assert(/data-testid="catalog-toggle"/.test(source), "从模型目录添加应有折叠开关");
  assert(/data-testid="custom-provider-collapsed"/.test(source) && /data-testid="catalog-collapsed"/.test(source), "两卡都应有折叠态文案");
});

check("模型库：故障标下沉到模型行，且匹配走 lookupModelHealth（不再直接下标）", () => {
  const source = readSource("components/ModelScopeEditor.tsx");
  assert(/import \{ failingBadgeText, lookupModelHealth \} from "@\/lib\/model-health-match"/.test(source), "应复用匹配层");
  assert(/lookupModelHealth\(health, m\.provider, m\.id\)/.test(source), "行内匹配应带 provider");
  assert(!/health\[ref\]/.test(source), "不得再用 health[ref] 直接下标（id 来源不同，会静默漏标）");
  assert(/data-testid="model-row"/.test(source) && /data-failing=/.test(source), "模型行应有稳定选择器与故障标记");
  assert(/data-testid="model-failing-badge"/.test(source), "行内故障标应有选择器");
  assert(/\{failingBadgeText\(failingSummary\)\}/.test(source), "故障标文案应来自纯函数（可单测）");
});

check("模型库：只看有故障的过滤 + 醒目摘要汇报", () => {
  const source = readSource("components/ModelScopeEditor.tsx");
  assert(/onlyFailing \? models\.filter/.test(source), "应支持只看有故障的行");
  assert(/export type ModelScopeSummary/.test(source), "应导出摘要类型");
  assert(/failing: failingRefs\.size/.test(source), "摘要里的故障数应来自匹配得上的行");
  assert(/没有标出故障的模型/.test(source), "过滤后空态要有说明");
});

check("选择器：健康匹配同样走 lookupModelHealth", () => {
  const source = readSource("components/ModelPicker.tsx");
  assert(/lookupModelHealth\(health, m\.provider, m\.id\)/.test(source), "选择器应复用同一匹配层");
  assert(!/health\[key\]/.test(source), "不得再直接下标");
});

check(".gitignore 白名单包含本自测（随仓库分发，非本机夹具）", () => {
  const source = readSource(".gitignore");
  assert(/!tools\/model-page-selftest\.mjs/.test(source), "应加入白名单");
});

check("gates.yml 登记了本自测", () => {
  const source = readSource(".github/workflows/gates.yml");
  assert(/node tools\/model-page-selftest\.mjs/.test(source), "CI 应跑本自测");
});

console.log(fail === 0 ? "\n全部通过" : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
