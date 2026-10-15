// lib/turn-trends.ts 的自检（观测栏「近 N 轮」数据源）。
// 运行：node tools/turn-trends-selftest.mjs
//
// 为什么走 jiti 而不是 --experimental-strip-types：与本目录其它自测一致，
// jiti 能解析 .ts 与 `@/` 别名（turn-trends.ts 目前只引 types，但保持同一套写法）。
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const { computeTurnTrends } = await jiti.import("../lib/turn-trends.ts");

let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
  if (!ok) fail++;
};

/* ---------- 全虚构数据的构造器 ---------- */
const usage = (total) => ({
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});
const user = (text, timestamp) => ({ role: "user", content: text, timestamp });
const assistant = (blocks, cost = 0, timestamp) => ({
  role: "assistant",
  content: blocks,
  model: "fake/model",
  provider: "fake",
  timestamp,
  usage: usage(cost),
});
const text = (t) => ({ type: "text", text: t });
const toolCall = (id) => ({ type: "toolCall", toolCallId: id, toolName: "bash", input: {} });
const toolResult = (id, isError = false, cost = 0) => ({
  role: "toolResult",
  toolCallId: id,
  content: [text("ok")],
  isError,
  usage: usage(cost),
});
const bash = (exitCode, timestamp) => ({
  role: "bashExecution",
  command: "false",
  output: "",
  exitCode,
  timestamp,
});

// ① 空数组
{
  const r = computeTurnTrends([]);
  check("① 空数组 → rounds 为空", r.rounds.length === 0);
  check("① 空数组 → totals 全 0", r.totals.cost === 0 && r.totals.toolCalls === 0 && r.totals.failures === 0);
}

// ② 单轮 cost / toolCalls 汇总（assistant 与 toolResult 的 usage 都计入）
{
  const r = computeTurnTrends([
    user("帮我跑一下"),
    assistant([text("好"), toolCall("t1"), toolCall("t2")], 0.3),
    toolResult("t1", false, 0.02),
    assistant([text("完成")], 0.1),
  ]);
  check("② 单轮 → 1 轮", r.rounds.length === 1, `rounds=${r.rounds.length}`);
  check("② cost = 0.42", Math.abs(r.rounds[0].cost - 0.42) < 1e-9, `cost=${r.rounds[0].cost}`);
  check("② toolCalls = 2", r.rounds[0].toolCalls === 2, `toolCalls=${r.rounds[0].toolCalls}`);
  check("② totals = 单轮值", Math.abs(r.totals.cost - 0.42) < 1e-9 && r.totals.toolCalls === 2);
  check("② index 从 1 起", r.rounds[0].index === 1);
}

// ③ 多轮按 user 消息正确切分（轮前孤立消息忽略）
{
  const r = computeTurnTrends([
    assistant([text("（会话开头的孤立消息）")], 9), // 无 user 在前：忽略
    user("第一问"),
    assistant([toolCall("a1")], 0.1),
    toolResult("a1"),
    user("第二问"),
    assistant([toolCall("b1"), toolCall("b2")], 0.2),
    toolResult("b1"),
    user("第三问"),
    assistant([text("答")], 0.3),
  ]);
  check("③ 切出 3 轮", r.rounds.length === 3, `rounds=${r.rounds.length}`);
  check("③ 轮前孤立消息不计入任何轮", Math.abs(r.totals.cost - 0.6) < 1e-9, `cost=${r.totals.cost}`);
  check("③ 各轮 toolCalls 独立", r.rounds.map((x) => x.toolCalls).join(",") === "1,2,0");
  check("③ label 对应各轮首条用户消息", r.rounds.map((x) => x.label).join("|") === "第一问|第二问|第三问");
}

// ④ toolResult.isError 计数
{
  const r = computeTurnTrends([
    user("跑三条"),
    assistant([toolCall("x1"), toolCall("x2"), toolCall("x3")]),
    toolResult("x1", true),
    toolResult("x2", false),
    toolResult("x3", true),
  ]);
  check("④ isError 计数 = 2", r.rounds[0].failures === 2, `failures=${r.rounds[0].failures}`);
  check("④ 非失败结果不计", r.totals.failures === 2);
}

// ⑤ bashExecution 非 0 退出计入失败，且与 toolResult 不双计
{
  const r = computeTurnTrends([
    user("直接敲命令 + 模型调用"),
    assistant([toolCall("y1")]),
    toolResult("y1", true), // 模型 bash 工具的失败（toolResult 路径）
    bash(1), // 用户 !命令 的失败（bashExecution 路径，无 toolCallId，不与上面同一失败）
    bash(0), // 成功命令不计
    bash(undefined), // 被取消（exitCode undefined）不计
  ]);
  check("⑤ 失败数 = 2（toolResult 1 + bashExecution 1，不双计）", r.rounds[0].failures === 2, `failures=${r.rounds[0].failures}`);
}

// ⑥ maxRounds 取最近 N 并影响 totals
{
  const messages = [];
  for (let i = 1; i <= 5; i++) {
    messages.push(user(`第 ${i} 问`));
    messages.push(assistant([toolCall(`c${i}`)], i / 100)); // 0.01 ... 0.05
    messages.push(toolResult(`c${i}`, i <= 2)); // 前两轮各一个失败
  }
  const r = computeTurnTrends(messages, 3);
  check("⑥ 只留最近 3 轮", r.rounds.length === 3, `rounds=${r.rounds.length}`);
  check("⑥ 保留的是第 3/4/5 问", r.rounds.map((x) => x.label).join("|") === "第 3 问|第 4 问|第 5 问");
  check("⑥ index 在截取后仍从 1 起", r.rounds[0].index === 1);
  check("⑥ totals 只统计保留轮 cost = 0.12", Math.abs(r.totals.cost - 0.12) < 1e-9, `cost=${r.totals.cost}`);
  check("⑥ totals.failures = 0（前两轮的失败被截掉）", r.totals.failures === 0, `failures=${r.totals.failures}`);
  check("⑥ maxRounds 大于总轮数时全保留", computeTurnTrends(messages, 99).rounds.length === 5);
}

// ⑦ label 多行折叠、24 字截断、空消息回退
{
  const long = "一二三四五六七八九十一二三四五六七八九十一二三四五六"; // 26 字
  const r = computeTurnTrends([
    user("第一行\n第二行\t第三行"),
    assistant([]),
    user(long),
    assistant([]),
    user("   "),
    assistant([]),
    user([{ type: "image", data: "x", mimeType: "image/png" }]),
    assistant([]),
  ]);
  check("⑦ 多行折成一行", r.rounds[0].label === "第一行 第二行 第三行", `label=${r.rounds[0].label}`);
  check("⑦ 超 24 字截断加省略号", r.rounds[1].label === `${long.slice(0, 24)}…`, `label=${r.rounds[1].label}`);
  check("⑦ 纯空白 →（空消息）", r.rounds[2].label === "（空消息）", `label=${r.rounds[2].label}`);
  check("⑦ 无文本块（纯图片）→（空消息）", r.rounds[3].label === "（空消息）", `label=${r.rounds[3].label}`);
}

// ⑧ 缺 usage / 缺 timestamp / content 非数组不炸
{
  let threw = false;
  let r;
  try {
    r = computeTurnTrends([
      { role: "user", content: "无 timestamp" }, // timestamp undefined
      { role: "assistant", content: [], model: "m", provider: "p" }, // 无 usage
      { role: "toolResult", toolCallId: "z1", content: [] }, // 无 usage、无 isError
      { role: "assistant", content: undefined, model: "m", provider: "p", usage: usage(0.5) }, // content 非数组
    ]);
  } catch (e) {
    threw = true;
    console.log(String(e));
  }
  check("⑧ 缺字段不抛错", !threw);
  check("⑧ startedAt 缺失 → undefined", r.rounds[0].startedAt === undefined);
  check("⑧ 缺 usage 当 0，非数组 content 的 toolCalls 记 0", r.rounds[0].toolCalls === 0 && Math.abs(r.rounds[0].cost - 0.5) < 1e-9);

  const withTs = computeTurnTrends([user("带时间", 1730000000000), assistant([])]);
  check("⑧ 有 timestamp 时透传", withTs.rounds[0].startedAt === 1730000000000);
}

console.log(fail === 0 ? "\nSELFTEST: OK" : `\nSELFTEST: ${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
