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
check("注入块：全部完成 → null（不再背着已完成的清单）", mod.buildTodoBlock([{ text: "a", status: "completed" }, { text: "b", status: "completed" }], 400) === null);
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

// ── 6. 钩子级：context 处理器 —— 无清单时摘除旧注入（与 worklog 对称）─────
const indexMod = await jiti.import("./index.ts");
const register = typeof indexMod === "function" ? indexMod : indexMod.default;
check("扩展入口加载（default 为注册函数）", typeof register === "function");

const registerHandlers = () => {
  const handlers = {};
  register(
    new Proxy(
      {},
      {
        get: (_target, key) =>
          key === "on" ? (name, fn) => { handlers[name] = fn; } : () => undefined,
      },
    ),
  );
  return handlers;
};

const staleMsg = { role: "user", content: "<elenva_todos>\n旧清单\n</elenva_todos>" };
const realMsg = { role: "user", content: "真实提问" };
const emptyCtx = { cwd: process.cwd(), sessionManager: { getBranch: () => [] } };

// A) 无清单 → 块为 null；旧注入仍应被摘除
let hookHandler = registerHandlers()["context"];
check("注册了 context 处理器", typeof hookHandler === "function");
let hookResult = await hookHandler({ messages: [realMsg, staleMsg] }, emptyCtx);
check(
  "无清单：不注入、但摘除旧注入",
  Array.isArray(hookResult?.messages) && hookResult.messages.length === 1 && hookResult.messages[0] === realMsg,
);
hookResult = await hookHandler({ messages: [realMsg] }, emptyCtx);
check("无旧注入且无清单 → 不返回", hookResult === undefined);

// B) 有清单（从会话分支重建）→ 摘旧注入 + 追加新块
const branchWithTodos = [
  {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "todo_write",
      details: { todos: [{ text: "步骤一", status: "in_progress" }, { text: "步骤二", status: "pending" }] },
    },
  },
];
hookHandler = registerHandlers()["context"];
hookResult = await hookHandler(
  { messages: [realMsg, staleMsg] },
  { cwd: process.cwd(), sessionManager: { getBranch: () => branchWithTodos } },
);
check(
  "有清单：摘旧注入并追加新块",
  Array.isArray(hookResult?.messages) && hookResult.messages.length === 2 &&
    hookResult.messages[0] === realMsg && String(hookResult.messages[1].content).includes("<elenva_todos>"),
);

// ── 7. 侧账本（ledger.ts）：首见保留 / 完成即移除 / 幂等 ─────────────────
const ledger = await jiti.import("./ledger.ts");
const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-05T00:00:00.000Z";
check(
  "账本：条目键归一（压缩空白 + trim）",
  ledger.normalizeItemKey("  写\t代码\n  并验证  ") === "写 代码 并验证",
);
check(
  "账本：条目键截断到 160 字",
  ledger.normalizeItemKey("长".repeat(200)).length === 160,
);
const ledgerA = ledger.observeLedger({ version: 1, sessions: {} }, "s1", good, T0);
const stamp0 = ledgerA.sessions.s1["跑测试"];
check("账本：首次观察盖 firstSeen / lastSeen", stamp0?.firstSeen === T0 && stamp0?.lastSeen === T0);
check(
  "账本：只记 open（completed 不入账）",
  ledgerA.sessions.s1["写代码"] === undefined && Object.keys(ledgerA.sessions.s1).length === 2,
);
const ledgerB = ledger.observeLedger(ledgerA, "s1", good, T1);
check(
  "账本：重复观察保留 firstSeen、刷新 lastSeen",
  ledgerB.sessions.s1["跑测试"].firstSeen === T0 && ledgerB.sessions.s1["跑测试"].lastSeen === T1,
);
check("账本：幂等（同一时刻两次观察结果一致）", JSON.stringify(ledger.observeLedger(ledgerA, "s1", good, T0)) === JSON.stringify(ledgerA));
const ledgerC = ledger.observeLedger(ledgerB, "s1", [{ text: "跑测试", status: "completed" }], T1);
check("账本：完成 / 消失的条目移除，会话空则整条删掉", ledgerC.sessions.s1 === undefined);

console.log(`\nSELFTEST: ${fail === 0 ? "OK" : "FAILED"} — ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exitCode = 1;