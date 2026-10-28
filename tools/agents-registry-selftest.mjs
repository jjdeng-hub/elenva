// Agent 注册表的自检：lib/agents/manifest.ts（纯函数）+ lib/agents/registry.ts（读盘）。
// 运行：node tools/agents-registry-selftest.mjs
//
// 隔离：ELENVA_AGENTS_DIR 指向 mkdtemp 出来的临时目录，全部用**虚构**应用包，
// 不碰真实 ~/.elenva/agents。lib/*.ts 是纯 TS（无 JSX），jiti 可直载（见记忆 F1/F3）。
import { createJiti } from "jiti";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "elenva-agents-selftest-"));
const agentsDir = join(root, "agents");
process.env.ELENVA_AGENTS_DIR = agentsDir;

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const manifestLib = await jiti.import("../lib/agents/manifest.ts");
const registryLib = await jiti.import("../lib/agents/registry.ts");
const panelsLib = await jiti.import("../lib/agents/panels.ts");
const panelsServerLib = await jiti.import("../lib/agents/panels-server.ts");

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

function writePackage(dirName, data) {
  const dir = join(agentsDir, dirName);
  mkdirSync(dir, { recursive: true });
  if (data !== undefined) writeFileSync(join(dir, "manifest.json"), JSON.stringify(data, null, 2));
  return dir;
}

// ---------------------------------------------------------------- 夹具（虚构）
writePackage("house", {
  id: "house",
  name: "装修 Agent",
  description: "预算、决策与施工阶段",
  icon: "🏠",
  runtime: "hermes",
  version: "0.1.0",
  panels: ["budget", "decisions", ""],
  capabilities: { growth: false, schedules: true, junk: "not-a-boolean" },
  dataDir: "data",
});
// id 与目录名不一致 → 整包应被拒绝，但不影响其它包
writePackage("broken", { id: "other", name: "坏包", runtime: "pi" });
// 目录存在但没有 manifest.json
writePackage("nomanifest", undefined);

// ---------------------------------------------------------------- 纯函数
check("合法 manifest 归一化：过滤空面板 / 只留布尔能力", () => {
  const parsed = manifestLib.parseAgentManifest(
    {
      id: "house",
      name: "装修 Agent",
      runtime: "hermes",
      panels: ["budget", "decisions", ""],
      capabilities: { growth: false, junk: "x" },
    },
    "house",
  );
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.manifest.panels.map((panel) => panel.id), ["budget", "decisions"]);
  assert.deepEqual(parsed.manifest.panels.map((panel) => panel.type), ["cards", "cards"]);
  assert.deepEqual(parsed.manifest.capabilities, { growth: false });
  assert.equal(parsed.manifest.runtime, "hermes");
});

check("runtime 缺省为 pi", () => {
  const parsed = manifestLib.parseAgentManifest({ id: "demo", name: "Demo" }, "demo");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.manifest.runtime, "pi");
});

check("拒绝：id 与目录名不一致", () => {
  const parsed = manifestLib.parseAgentManifest({ id: "a", name: "A" }, "b");
  assert.equal(parsed.ok, false);
});

check("拒绝：id 非法（大写 / 下划线）", () => {
  assert.equal(manifestLib.parseAgentManifest({ id: "House_1", name: "H" }, "House_1").ok, false);
});

check("拒绝：缺 name / runtime 不认识", () => {
  assert.equal(manifestLib.parseAgentManifest({ id: "x" }, "x").ok, false);
  assert.equal(manifestLib.parseAgentManifest({ id: "x", name: "X", runtime: "openai" }, "x").ok, false);
});

check("合并：内置优先、应用包按名称排序、冲突不覆盖", () => {
  const pkg = (id, name) => ({ id, name, runtime: "pi", source: "package", dir: `/tmp/${id}` });
  const { agents, conflicts } = manifestLib.mergeAgentRecords([pkg("zeta", "Zeta"), pkg("justin", "假 Justin"), pkg("alpha", "Alpha")]);
  assert.deepEqual(agents.map((a) => a.id), ["justin", "alpha", "zeta"]);
  assert.equal(conflicts.length, 1);
});

check("图标：有 icon 用 icon，没有就取名字首字", () => {
  assert.equal(manifestLib.agentGlyph({ icon: "🏠", name: "装修" }), "🏠");
  assert.equal(manifestLib.agentGlyph({ name: "装修 Agent" }), "装");
});

// ---------------------------------------------------------------- 读盘
check("注册表：内置 Agent 在首位，坏包降级成 errors", () => {
  const snapshot = registryLib.listAgents();
  assert.equal(snapshot.dir, agentsDir);
  assert.deepEqual(snapshot.agents.map((a) => a.id), ["justin", "house"]);
  const house = snapshot.agents[1];
  assert.equal(house.source, "package");
  assert.equal(house.runtime, "hermes");
  assert.ok(house.dir && house.dir.endsWith("house"));
  assert.ok(snapshot.errors.some((e) => e.startsWith("broken")));
  assert.ok(snapshot.errors.some((e) => e.startsWith("nomanifest")));
});

check("注册表：目录不存在时只返回内置 Agent", () => {
  process.env.ELENVA_AGENTS_DIR = join(root, "not-created");
  const snapshot = registryLib.listAgents();
  assert.deepEqual(snapshot.agents.map((a) => a.id), ["justin"]);
  assert.deepEqual(snapshot.errors, []);
});

// ---------------------------------------------------------------- 面板
check("面板：字符串与对象都接受，非法类型/重复 id 跳过", () => {
  const panels = panelsLib.parsePanels([
    "budget",
    { id: "decisions", title: "决策", type: "cards", source: "data/decisions.json" },
    { id: "bad", title: "坏类型", type: "video" },
    { id: "decisions", title: "重复", type: "cards" },
    "",
  ]);
  assert.deepEqual(panels.map((panel) => panel.id), ["budget", "decisions"]);
  assert.equal(panels[0].type, "cards");
  assert.equal(panels[1].source, "data/decisions.json");
});

check("面板数据：表格行归一化，非数组行丢弃、单元格转字符串", () => {
  const data = panelsLib.normalizePanelData("table", { columns: ["A", 3], rows: [["x", 1], "bad", [null, "y"]] });
  assert.deepEqual(data.columns, ["A"]);
  assert.deepEqual(data.rows, [["x", "1"], ["", "y"]]);
});

check("面板数据：items 接受字符串与对象，缺 title 丢弃", () => {
  const data = panelsLib.normalizePanelData("queue", {
    items: ["随便", { title: "条目", status: "草稿" }, { meta: "无标题" }],
  });
  assert.deepEqual(data.items.map((item) => item.title), ["随便", "条目"]);
  assert.equal(data.items[1].status, "草稿");
});

check("面板数据：空/坏结构退化为空面板", () => {
  assert.deepEqual(panelsLib.normalizePanelData("cards", null), { items: [] });
  assert.deepEqual(panelsLib.normalizePanelData("table", "nope"), { columns: [], rows: [] });
  assert.equal(panelsLib.panelHasData("table", { columns: [], rows: [] }), false);
});

check("路径沙箱：包内 source 可读，越界拒绝", () => {
  const pkgDir = join(root, "pkg");
  mkdirSync(join(pkgDir, "data"), { recursive: true });
  writeFileSync(join(pkgDir, "data", "budget.json"), JSON.stringify({ columns: ["A"], rows: [["1"]] }));

  const inside = panelsServerLib.readPanelData(pkgDir, {
    id: "b",
    title: "B",
    type: "table",
    source: "data/budget.json",
  });
  assert.deepEqual(inside.data.rows, [["1"]]);
  assert.equal(inside.error, undefined);

  const escape = panelsServerLib.readPanelData(pkgDir, {
    id: "x",
    title: "X",
    type: "table",
    source: "../../etc/passwd",
  });
  assert.equal(escape.error, "source 越出应用包目录");

  const missing = panelsServerLib.readPanelData(pkgDir, {
    id: "m",
    title: "M",
    type: "table",
    source: "data/none.json",
  });
  assert.ok(missing.error);
});

rmSync(root, { recursive: true, force: true });
if (fail > 0) {
  console.log(`\n${fail} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");
