/**
 * elenva-worklog 纯函数自检（不装扩展、不起会话、不调模型）。
 *
 * 跑法：node extensions/elenva-worklog/selftest.mjs
 * 全绿输出 SELFTEST: OK / n 通过；有失败输出 SELFTEST: FAILED 并以退出码 1 结束。
 */
import { createJiti } from "jiti";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const jiti = createJiti(import.meta.url, { moduleCache: false, interopDefault: true });
const storeMod = await jiti.import("./store.ts");
const statusMod = await jiti.import("./status.ts");

let pass = 0;
let fail = 0;
const check = (name, condition, extra = "") => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
  condition ? (pass += 1) : (fail += 1);
};

// ── 1. 解析与序列化往返 ────────────────────────────────────────────────────
const raw = [
  "# 工作记录 · demo",
  "",
  "## 2026-09-20 11:30 · 记忆页可编辑 · done",
  "目标：让用户直接改记忆条目",
  "做了什么：lib/agent-memory.ts 写入链路 + PUT /api/memory",
  "证据：tsc 0 输出；API 五步实测",
  "待办：整文件源码模式",
  "",
  "## 2026-09-20 10:20 · 容量提醒 · done",
  "目标：记忆贴顶时提醒模型整理",
  "证据：selftest 40/40",
].join("\n");

const entries = storeMod.parseWorklog(raw);
check("解析出 2 条", entries.length === 2);
check("最新在前", entries[0].title === "记忆页可编辑");
check("状态解析", entries[0].status === "done");
check("字段解析（目标/待办）", entries[0].goal === "让用户直接改记忆条目" && entries[0].todo === "整文件源码模式");
check("缺省字段为 undefined", entries[1].todo === undefined && entries[1].did === undefined);

const roundTrip = storeMod.parseWorklog(storeMod.serializeEntry(entries[0]));
check(
  "序列化→解析 往返一致",
  roundTrip.length === 1 && roundTrip[0].title === entries[0].title && roundTrip[0].evidence === entries[0].evidence,
);

const withDoing = storeMod.parseWorklog(storeMod.serializeEntry({ at: "2026-09-20 12:00", title: "进行中", status: "doing" }));
check("doing / blocked 状态可解析", withDoing[0].status === "doing");

// ── 2. 状态栏构造（ch2 L855 / L902 / L914）─────────────────────────────────
const file = { path: "x.md", projectName: "pi-web-ui", entries };
const block = statusMod.buildStatusBlock(file, 320);
check("有记录 → 构造出状态块", typeof block === "string" && block.includes("<agent_status>"));
check("含项目名与最近一条标题", block.includes("pi-web-ui") && block.includes("记忆页可编辑"));
check("含待办", block.includes("整文件源码模式"));
check("在预算内", block.length <= 320, `(${block.length})`);
check("空记录 → 不注入", statusMod.buildStatusBlock({ path: "x.md", projectName: "p", entries: [] }, 320) === null);
check("budget=0 → 不注入", statusMod.buildStatusBlock(file, 0) === null);
const tiny = statusMod.buildStatusBlock(file, 130);
check("小预算下收缩而不是超限", tiny === null || tiny.length <= 130, tiny ? `(${tiny.length})` : "(null)");

// ── 3. 状态消息识别与摘除（实现一：每轮替换，ch2 L945）─────────────────────
check(
  "识别注入标记",
  statusMod.isStatusText("<agent_status>\n…\n</agent_status>") === true && statusMod.isStatusText("普通用户消息") === false,
);
const messages = [
  { role: "user", content: "真实提问" },
  { role: "assistant", content: [{ type: "text", text: "回答" }] },
  { role: "user", content: "<agent_status>\n旧状态\n</agent_status>" },
  { role: "user", content: [{ type: "text", text: "<agent_status>数组形态</agent_status>" }] },
];
const stripped = statusMod.stripStatusMessages(messages);
check("摘掉旧状态（字符串与数组两种形态）", stripped.length === 2, `(剩 ${stripped.length})`);
check("保留真实用户消息与助手消息", stripped[0].content === "真实提问" && stripped[1].role === "assistant");

// ── 4. 写入与滚动窗口（临时目录，不碰真实工作记录）─────────────────────────
const tmp = mkdtempSync(join(tmpdir(), "elenva-worklog-"));
const cwd = join(tmp, "demo-repo");
mkdirSync(cwd, { recursive: true });
const agentRoot = join(tmp, "agent");

for (let i = 1; i <= 4; i += 1) {
  storeMod.appendEntry(cwd, { at: `2026-09-20 10:0${i}`, title: `工作 ${i}`, status: "done" }, { keep: 3, agentRoot });
}
const written = storeMod.readWorklog(cwd, agentRoot);
check("写入后最新在前", written.entries[0].title === "工作 4");
check("滚动窗口只保留 3 条", written.entries.length === 3, `(${written.entries.length})`);
check("溢出条目进 archive/", existsSync(join(agentRoot, "worklog", "archive")));
check(
  "归档文件里有被移出的那条",
  readdirSync(join(agentRoot, "worklog", "archive")).length > 0,
);
check("项目名取自目录名", written.projectName === "demo-repo", `(${written.projectName})`);
check("没写过的目录 → 空记录不报错", storeMod.readWorklog(join(tmp, "another"), agentRoot).entries.length === 0);

const render = storeMod.renderWorklog(written, 2);
check("renderWorklog 只渲染 tail 条", render.includes("工作 4") && !render.includes("工作 1"));

rmSync(tmp, { recursive: true, force: true });

console.log(`\nSELFTEST: ${fail === 0 ? "OK" : "FAILED"} — ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exitCode = 1;
