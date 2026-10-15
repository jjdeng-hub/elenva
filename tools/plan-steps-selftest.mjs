// 计划步骤纯函数（lib/plan-steps.ts）的自检：
// 归一容错（非数组 / 非对象 / 空 title / trim / title 120 截断 / detail 400 截断 / cap 12 /
// 保序）与 stepsToMarkdown（空 → ""；单条 / 多条格式；detail 缺失行形态）。全用**虚构**数据。
// 运行：node tools/plan-steps-selftest.mjs
//
// lib/plan-steps.ts 是纯 TS（无相对导入、无 JSX），jiti 可直载（见记忆 F1/F3）。
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const { normalizePlanSteps, stepsToMarkdown, PLAN_STEP_TITLE_MAX, PLAN_STEP_DETAIL_MAX, PLAN_STEP_MAX } =
  await jiti.import("../lib/plan-steps.ts");

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
const eq = (actual, expected, message) =>
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`,
  );

/* ============================ normalizePlanSteps ============================ */

check("非数组（undefined / null / 字符串 / 对象）→ []", () => {
  eq(normalizePlanSteps(undefined), [], "undefined");
  eq(normalizePlanSteps(null), [], "null");
  eq(normalizePlanSteps("1. 做点什么"), [], "字符串");
  eq(normalizePlanSteps({ title: "x" }), [], "对象");
});

check("非对象项 / title 缺失或非字符串 → 丢弃", () => {
  eq(
    normalizePlanSteps([null, "字符串", 42, {}, { title: 123 }, { detail: "只有细节" }, { title: "   " }]),
    [],
    "全部无效",
  );
});

check("空 title 丢弃，合法项保留", () => {
  eq(
    normalizePlanSteps([{ title: "" }, { title: "留下" }, { title: "  " }]),
    [{ title: "留下" }],
    "只留一条",
  );
});

check("title / detail 去首尾空白", () => {
  eq(
    normalizePlanSteps([{ title: "  改 A  ", detail: "\n 细节 B \t" }]),
    [{ title: "改 A", detail: "细节 B" }],
    "trim 后",
  );
});

check("detail 为空串 / 非字符串时不产出 detail 字段", () => {
  eq(normalizePlanSteps([{ title: "A", detail: "   " }]), [{ title: "A" }], "空白 detail");
  eq(normalizePlanSteps([{ title: "A", detail: 7 }]), [{ title: "A" }], "非字符串 detail");
});

check(`title 截断到 ${PLAN_STEP_TITLE_MAX} 字`, () => {
  const long = "标".repeat(PLAN_STEP_TITLE_MAX + 30);
  const out = normalizePlanSteps([{ title: long }]);
  eq(out.length, 1, "保留一条");
  eq(out[0].title.length, PLAN_STEP_TITLE_MAX, "长度");
  eq(out[0].title, long.slice(0, PLAN_STEP_TITLE_MAX), "截断内容");
});

check(`detail 截断到 ${PLAN_STEP_DETAIL_MAX} 字`, () => {
  const long = "细".repeat(PLAN_STEP_DETAIL_MAX + 50);
  const out = normalizePlanSteps([{ title: "T", detail: long }]);
  eq(out[0].detail.length, PLAN_STEP_DETAIL_MAX, "长度");
  eq(out[0].detail, long.slice(0, PLAN_STEP_DETAIL_MAX), "截断内容");
});

check(`最多保留 ${PLAN_STEP_MAX} 条`, () => {
  const input = Array.from({ length: PLAN_STEP_MAX + 5 }, (_, i) => ({ title: `步骤 ${i + 1}` }));
  const out = normalizePlanSteps(input);
  eq(out.length, PLAN_STEP_MAX, "条数上限");
  eq(out[0].title, "步骤 1", "首条");
  eq(out[PLAN_STEP_MAX - 1].title, `步骤 ${PLAN_STEP_MAX}`, "末条");
});

check("合法数组原样保序（title + detail 完整保留）", () => {
  const input = [
    { title: "第一步", detail: "细节一" },
    { title: "第二步" },
    { title: "第三步", detail: "细节三" },
  ];
  eq(normalizePlanSteps(input), input, "原样");
});

/* ============================== stepsToMarkdown ============================== */

check("空数组 → \"\"", () => {
  eq(stepsToMarkdown([]), "", "空");
});

check("单条（有 detail）→ `1. **标题** —— 细节`", () => {
  eq(stepsToMarkdown([{ title: "改 A", detail: "细节 B" }]), "1. **改 A** —— 细节 B", "单条带细节");
});

check("多条 → 按序编号 + 换行连接", () => {
  eq(
    stepsToMarkdown([{ title: "一" }, { title: "二", detail: "细节" }, { title: "三" }]),
    "1. **一**\n2. **二** —— 细节\n3. **三**",
    "多条格式",
  );
});

check("detail 缺失时只留加粗标题（无 `——` 残留）", () => {
  const out = stepsToMarkdown([{ title: "只有标题" }]);
  eq(out, "1. **只有标题**", "行形态");
  assert(!out.includes("——"), "不含分隔符");
});

console.log(`\n${fail === 0 ? "全部通过" : `${fail} 项失败`}（plan-steps-selftest）`);
process.exit(fail === 0 ? 0 : 1);
