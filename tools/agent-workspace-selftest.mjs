// Agent 工作台（views / blocks / 数据契约 / 写入通道）自检。
//
// 覆盖四层：
//   1) 声明层 lib/agents/workspace.ts —— views 解析、老 panels 退化、坏块跳过、越界路径丢弃
//   2) 契约层 lib/agents/data-schema.ts —— schema 解析 + 数据校验（多类反例）
//   3) 动作层 lib/agents/action.ts —— 中文占位符、缺值报错、超长拒绝
//   4) 写入层 lib/agents/data-store.ts —— 路径逃逸、revision 冲突、备份、变更记录
//
// 运行：node tools/agent-workspace-selftest.mjs
// 隔离：全在 mkdtemp 出来的临时应用包里造**虚构**数据，不碰 ~/.elenva。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const workspace = await jiti.import("../lib/agents/workspace.ts");
const schemaLib = await jiti.import("../lib/agents/data-schema.ts");
const actionLib = await jiti.import("../lib/agents/action.ts");
const store = await jiti.import("../lib/agents/data-store.ts");
const manifestLib = await jiti.import("../lib/agents/manifest.ts");

let fail = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message.split("\n")[0] : error}`);
  }
};

const root = mkdtempSync(join(tmpdir(), "elenva-agent-workspace-selftest-"));
const pkg = join(root, "demo-agent");
mkdirSync(join(pkg, "data", "drafts"), { recursive: true });
mkdirSync(join(pkg, "schemas"), { recursive: true });
writeFileSync(join(pkg, "data", "todo.json"), JSON.stringify({ items: [{ title: "样例待办", meta: "公众号", status: "待写" }] }, null, 2));
writeFileSync(join(pkg, "data", "topics.json"), JSON.stringify({ columns: ["选题", "状态"], rows: [["样例选题", "待写"]] }, null, 2));
writeFileSync(join(pkg, "data", "drafts", "样例.md"), "# 样例\n正文\n");
writeFileSync(join(pkg, "schemas", "todo.json"), JSON.stringify({ kind: "items", fields: { title: "string", meta: "string", status: "string" }, required: ["title"] }));
writeFileSync(join(pkg, "schemas", "topics.json"), JSON.stringify({ kind: "table", columns: ["选题", "状态"] }));

/* ---------------- 1. 声明层 ---------------- */

check("views：解析导航项、块、动作、可改字段", () => {
  const views = workspace.parseViews([
    {
      id: "today",
      title: "今天",
      blocks: [
        { id: "todo", type: "queue", title: "待办", source: "data/todo.json", schema: "schemas/todo.json", actions: [{ id: "draft", label: "起草", prompt: "写：{title}" }] },
        { id: "body", type: "doc", title: "正文", source: "data/drafts" },
      ],
    },
    { id: "topics", title: "选题库", blocks: [{ id: "t", type: "table", source: "data/topics.json", editable: ["状态"] }] },
  ]);
  assert.equal(views.length, 2);
  assert.equal(views[0].blocks.length, 2);
  assert.equal(views[0].blocks[0].id, "today-todo", "块 id 必须带视图前缀（全局唯一）");
  assert.equal(views[0].blocks[0].actions[0].prompt, "写：{title}");
  assert.deepEqual(views[1].blocks[0].editable, ["状态"]);
});

check("views：省略 views 时由 panels 退化成单视图（老包零改动）", () => {
  const views = workspace.parseViews(undefined, [{ id: "budget", title: "预算", type: "table", source: "data/budget.json" }]);
  assert.equal(views.length, 1);
  assert.equal(views[0].id, "overview");
  assert.equal(views[0].blocks[0].source, "data/budget.json");
});

check("views：坏视图/坏块/重复 id 跳过，不炸整包", () => {
  const views = workspace.parseViews([
    { id: "Bad Id", blocks: [] },
    { id: "ok", blocks: [{ id: "x", type: "不存在" }, { id: "y", type: "cards", source: "data/todo.json" }] },
    { id: "ok", blocks: [] },
  ]);
  assert.equal(views.length, 1);
  assert.equal(views[0].blocks.length, 1);
});

check("views：越界 source / 绝对路径被丢弃", () => {
  const views = workspace.parseViews([
    { id: "v", blocks: [{ id: "a", type: "cards", source: "../../etc/passwd" }, { id: "b", type: "cards", source: "/etc/passwd" }] },
  ]);
  assert.equal(views[0].blocks[0].source, undefined);
  assert.equal(views[0].blocks[1].source, undefined);
});

check("manifest：views 与 panels 并存时都保留（后者给旧接口）", () => {
  const parsed = manifestLib.parseAgentManifest(
    {
      id: "demo-agent",
      name: "样例",
      runtime: "hermes",
      panels: [{ id: "budget", type: "table", source: "data/topics.json" }],
      views: [{ id: "today", blocks: [{ id: "t", type: "table", source: "data/topics.json" }] }],
    },
    "demo-agent",
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.manifest.views.length, 1);
  assert.equal(parsed.manifest.panels.length, 1);
});

/* ---------------- 2. 契约层 ---------------- */

const itemsSchema = schemaLib.parseSchema({ kind: "items", fields: { title: "string", n: "number" }, required: ["title"] });
const tableSchema = schemaLib.parseSchema({ kind: "table", columns: ["A", "B"] });

check("schema：合法契约可解析，坏契约给中文原因", () => {
  assert.equal(itemsSchema.ok, true);
  assert.equal(tableSchema.ok, true);
  const bad = schemaLib.parseSchema({ kind: "items", fields: {} });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /fields/);
});

check("schema：items 校验（通过 / 未知字段 / 缺必填 / 类型错）", () => {
  assert.equal(schemaLib.validateData(itemsSchema.schema, { items: [{ title: "a", n: 1 }] }).ok, true);
  const unknown = schemaLib.validateData(itemsSchema.schema, { items: [{ title: "a", extra: "x" }] });
  assert.equal(unknown.ok, false);
  assert.match(unknown.errors.join(), /未声明的字段/);
  const missing = schemaLib.validateData(itemsSchema.schema, { items: [{ n: 1 }] });
  assert.match(missing.errors.join(), /缺必填/);
  const wrongType = schemaLib.validateData(itemsSchema.schema, { items: [{ title: "a", n: "1" }] });
  assert.match(wrongType.errors.join(), /应为 number/);
});

check("schema：table 校验（列不一致 / 行长不一致 / 通过）", () => {
  assert.equal(schemaLib.validateData(tableSchema.schema, { columns: ["A", "B"], rows: [["1", "2"]] }).ok, true);
  const cols = schemaLib.validateData(tableSchema.schema, { columns: ["A", "C"], rows: [] });
  assert.match(cols.errors.join(), /columns 必须与契约一致/);
  const len = schemaLib.validateData(tableSchema.schema, { columns: ["A", "B"], rows: [["1"]] });
  assert.match(len.errors.join(), /契约要求 2 格/);
});

/* ---------------- 3. 动作层 ---------------- */

check("action：中文占位符可替换", () => {
  const res = actionLib.renderActionPrompt("按「{选题}」列提纲（{平台}）", { 选题: "预算表", 平台: "公众号" });
  assert.equal(res.ok, true);
  assert.equal(res.text, "按「预算表」列提纲（公众号）");
});

check("action：缺值报错（不静默留空）", () => {
  const res = actionLib.renderActionPrompt("写：{title}", { meta: "x" });
  assert.equal(res.ok, false);
  assert.match(res.error, /title/);
});

check("action：超长拒绝", () => {
  const res = actionLib.renderActionPrompt("写：{title}", { title: "字".repeat(5000) });
  assert.equal(res.ok, false);
});

/* ---------------- 4. 写入层 ---------------- */

check("存储：路径逃逸 / 绝对路径 / 非白名单扩展名被拒", () => {
  for (const bad of ["../secret.json", "/etc/passwd", "data/todo.sh", "a/../../x.json"]) {
    const res = store.resolveInside(pkg, bad);
    assert.equal(res.ok, false, `${bad} 应被拒`);
  }
  assert.equal(store.resolveInside(pkg, "data/todo.json").ok, true);
});

check("存储：读 → 改 → 写回，revision 变化且备份/变更记录留下", () => {
  const before = store.readAgentFile(pkg, "data/todo.json");
  assert.equal(before.ok, true);
  const next = JSON.stringify({ items: [{ title: "改过", meta: "公众号", status: "待写" }] }, null, 2);
  const written = store.writeAgentFile(pkg, "data/todo.json", next, { expectedRevision: before.revision });
  assert.equal(written.ok, true);
  assert.notEqual(written.revision, before.revision);
  assert.equal(JSON.parse(readFileSync(join(pkg, "data", "todo.json"), "utf8")).items[0].title, "改过");
  const backups = readdirSync(join(pkg, "data", ".backup"));
  assert.ok(backups.length >= 1, "覆盖前必须留备份");
  const changes = readFileSync(join(pkg, "data", ".changes.jsonl"), "utf8").trim().split("\n");
  assert.ok(changes.length >= 1);
  assert.equal(JSON.parse(changes.at(-1)).path, "data/todo.json");
});

check("存储：revision 过期 → 409 且不写盘", () => {
  const current = store.readAgentFile(pkg, "data/todo.json");
  const rejected = store.writeAgentFile(pkg, "data/todo.json", "{}", { expectedRevision: "deadbeefdeadbeef" });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, 409);
  assert.equal(store.readAgentFile(pkg, "data/todo.json").revision, current.revision, "冲突时文件不能被改");
});

check("存储：超 256KB 拒绝", () => {
  const big = JSON.stringify({ items: [{ title: "x".repeat(300 * 1024) }] });
  const res = store.writeAgentFile(pkg, "data/todo.json", big, {});
  assert.equal(res.ok, false);
  assert.equal(res.status, 413);
});

check("存储：doc 目录只列 .md，且能按路径读回", () => {
  const files = store.listMarkdownFiles(pkg, "data/drafts");
  assert.equal(files.length, 1);
  assert.equal(files[0].name, "样例.md");
  assert.equal(files[0].path, "data/drafts/样例.md");
  const read = store.readAgentFile(pkg, "data/drafts/样例.md");
  assert.equal(read.ok, true);
  assert.match(read.content, /正文/);
});

check("存储：新建文件也要父目录存在（不隐式造目录）", () => {
  const res = store.writeAgentFile(pkg, "data/不存在/x.json", "{}", {});
  assert.equal(res.ok, false);
  assert.equal(existsSync(join(pkg, "data", "不存在")), false);
});

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
