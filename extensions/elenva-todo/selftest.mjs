/**
 * elenva-todo 纯函数自检（不装扩展、不起会话、不调模型）。
 *
 * 跑法：node extensions/elenva-todo/selftest.mjs
 * 全绿输出 SELFTEST: OK / n 通过；有失败输出 SELFTEST: FAILED 并以退出码 1 结束。
 */
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false, interopDefault: true });
const mod = await jiti.import("./state.ts");

let pass = 0;
let fail = 0;
const check = (name, condition, extra = "") => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
  condition ? (pass += 1) : (fail += 1);
};

// ── 1. 宽松解析（UI 路径）──────────────────────────────────────────────────
const good = [
  { text: "写代码", status: "completed" },
  { text: "跑测试", status: "in_progress" },
  { text: "写文档", status: "pending" },
];
check("coerce：合法数组解析", JSON.stringify(mod.coerceTodoItems(good)) === JSON.stringify(good));
check("coerce：非数组 → null", mod.coerceTodoItems("x") === null && mod.coerceTodoItems(undefined) === null);
check("coerce：坏状态 → null", mod.coerceTodoItems([{ text: "a", status: "doing" }]) === null);
check("coerce：空 text → null", mod.coerceTodoItems([{ text: "  ", status: "pending" }]) === null);
check("coerce：空数组合法", JSON.stringify(mod.coerceTodoItems([])) === "[]");

// ── 2. 严格校验（todo_write 路径）────────────────────────────────────────
check("validate：正常通过", mod.validateTodoWrite({ todos: good }).ok === true);
check("validate：空数组通过（清空）", mod.validateTodoWrite({ todos: [] }).ok === true);
const notArray = mod.validateTodoWrite({ todos: "x" });
check("validate：非数组报错", notArray.ok === false && notArray.error.includes("数组"));
const twoActive = mod.validateTodoWrite({
  todos: [{ text: "a", status: "in_progress" }, { text: "b", status: "in_progress" }],
});
check("validate：双 in_progress 报错", twoActive.ok === false && twoActive.error.includes("只能一项"));
const many = mod.validateTodoWrite({ todos: Array.from({ length: 21 }, (_, i) => ({ text: `t${i}`, status: "pending" })) });
check("validate：超过 20 项报错", many.ok === false && many.error.includes("超过上限"));
const longText = mod.validateTodoWrite({ todos: [{ text: "长".repeat(161), status: "pending" }] });
check("validate：超长文本报错", longText.ok === false && longText.error.includes("161"));
const noText = mod.validateTodoWrite({ todos: [{ status: "pending" }] });
check("validate：缺 text 报错", noText.ok === false && noText.error.includes("第 1 项"));
const badStatus = mod.validateTodoWrite({ todos: [{ text: "a", status: "wip" }] });
check("validate：坏状态报错", badStatus.ok === false && badStatus.error.includes("status 无效"));
const trimmed = mod.validateTodoWrite({ todos: [{ text: "  a  ", status: "pending" }] });
check("validate：文本被 trim", trimmed.ok === true && trimmed.todos[0].text === "a");

// ── 3. 进度与渲染 ─────────────────────────────────────────────────────────
const progress = mod.todoProgress(good);
check("progress：完成数 / 进行中", progress.done === 1 && progress.total === 3 && progress.active.text === "跑测试");
check("summary：含进行中", mod.todoSummaryLine(good).includes("进行中：跑测试"));
check(
  "summary：全完成",
  mod.todoSummaryLine([{ text: "a", status: "completed" }]).includes("全部完成"),
);
const checklist = mod.renderTodoChecklist(good);
check("渲染：含三行标记", checklist.includes("[x] 写代码") && checklist.includes("[>] 跑测试") && checklist.includes("[ ] 写文档"));
check("渲染：空清单提示", mod.renderTodoChecklist([]) === "任务清单已清空。");

// ── 4. 注入块（ch2 L912 / L924 / L955）────────────────────────────────────
const block = mod.buildTodoBlock(good, 400);
check("注入块：有标记包裹", typeof block === "string" && block.includes("<elenva_todos>") && block.includes("</elenva_todos>"));
check("注入块：含进度与进行中项", block.includes("1/3") && block.includes("跑测试"));
check("注入块：预算内", block.length <= 400, `(${block.length})`);
check("注入块：空清单 → null", mod.buildTodoBlock([], 400) === null);
check("注入块：budget=0 → null", mod.buildTodoBlock(good, 0) === null);
const tiny = mod.buildTodoBlock(good, 60);
check("注入块：小预算收缩而非超限", tiny === null || tiny.length <= 60, tiny ? `(${tiny.length})` : "(null)");
const manyItems = Array.from({ length: 20 }, (_, i) => ({ text: `步骤 ${i + 1}：做一件事然后验证结果是否正确`, status: "pending" }));
const bigBlock = mod.buildTodoBlock(manyItems, 400);
check("注入块：20 项收进 400 字（截断而不是放弃）", bigBlock !== null && bigBlock.length <= 400, bigBlock ? `(${bigBlock.length})` : "(null)");
check("注入块：截断时标出剩余条数", bigBlock !== null && bigBlock.includes("另"), bigBlock ? "" : "(null)");

// ── 5. 识别与摘除（实现一：每轮替换，ch2 L955）────────────────────────────
check(
  "识别注入标记",
  mod.isTodoText("<elenva_todos>\n…\n</elenva_todos>") === true && mod.isTodoText("普通用户消息") === false,
);
const messages = [
  { role: "user", content: "真实提问" },
  { role: "assistant", content: [{ type: "text", text: "回答" }] },
  { role: "user", content: "<elenva_todos>\n旧清单\n</elenva_todos>" },
  { role: "user", content: [{ type: "text", text: "<elenva_todos>数组形态</elenva_todos>" }] },
  { role: "user", content: "<agent_status>别的扩展的注入</agent_status>" },
  { role: "user", content: "请解释 <elenva_todos> 这个标记是干什么的" },
  { role: "user", content: "<elenva_todos> 是什么？" },
  { role: "user", content: "上面那段 <elenva_todos>…</elenva_todos> 是什么？" },
];
const stripped = mod.stripTodoMessages(messages);
check("摘掉旧清单（字符串与数组两种形态）", stripped.length === 6, `(剩 ${stripped.length})`);
check(
  "不碰真实消息与其它扩展的注入",
  stripped[0].content === "真实提问" && stripped.some((m) => String(m.content).includes("<agent_status>")),
);
check(
  "引用标记的真实消息不被误删",
  stripped.some((m) => String(m.content).includes("请解释")) &&
    stripped.some((m) => String(m.content).includes("是什么？")) &&
    stripped.some((m) => String(m.content).includes("上面那段")),
);

console.log(`\nSELFTEST: ${fail === 0 ? "OK" : "FAILED"} — ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exitCode = 1;