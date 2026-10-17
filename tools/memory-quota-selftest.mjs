// 记忆配额视图（lib/agent-memory.ts 的 listAgentMemoryFiles 补 chars / limit）的自检。
// 运行：node tools/memory-quota-selftest.mjs
//
// 隔离：PI_CODING_AGENT_DIR / PI_HERMES_MEMORY_DIR 都指向 mkdtemp 出来的临时目录，
// 全用**虚构**数据（不碰真实 ~/.pi/agent，也不读本机 hermes-memory-config.json，
// 因此配额取默认值：memory 5000 / user 5000 / project 5000 / failures 10000
// 〔R2 口径统一〕默认值与 vendor 常量同源（DEFAULT_*_CHAR_LIMIT）。
// lib/*.ts 是纯 TS（无 JSX），jiti 可直载。
import { createJiti } from "jiti";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "elenva-memory-quota-selftest-"));
const agentDir = join(root, "agent");
const memoryDir = join(agentDir, "pi-hermes-memory");
mkdirSync(memoryDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_HERMES_MEMORY_DIR = memoryDir;

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const memory = await jiti.import("../lib/agent-memory.ts");

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

const list = () => memory.listAgentMemoryFiles();
const find = (id) => list().files.find((f) => f.id === id);
const writeFixed = (file, content) => writeFileSync(join(memoryDir, file), content, "utf8");
const resetFixed = (file) => rmSync(join(memoryDir, file), { force: true });

/* ============================ 隔离自证 ============================ */

check("① 临时目录隔离生效（不碰真实记忆目录 / 配置）", () => {
  assert.equal(memory.getHermesMemoryDir(), resolve(memoryDir));
  assert.ok(memory.getHermesProjectsDir().startsWith(agentDir), "项目记忆目录必须落在临时 agentDir 内");
  // 隔离没生效的话本机 hermes-memory-config.json 会把上限改成别的值
  assert.equal(memory.getHermesMemoryLimits().memory, 5000, "应为默认上限（隔离配置未生效？）");
});

/* ============================ 固定文件 chars / limit ============================ */

check("② 固定文件带 chars / limit，且 chars 与详情卡同口径（含元数据注释）", () => {
  const userText = "用户是虚构角色，偏好简洁回复。";
  // 模拟扩展落盘：条目尾部带 <!-- created=… --> 元数据；raw.length 把它算进去
  const userRaw = `${userText} <!-- created=2020-01-01, last=2020-01-01 -->`;
  writeFixed("USER.md", userRaw);
  writeFixed("MEMORY.md", "A".repeat(123));
  resetFixed("failures.md");

  const user = find("user");
  assert.equal(user.exists, true);
  assert.equal(user.chars, userRaw.length, "chars 应等于磁盘原文长度（含元数据）");
  assert.ok(userRaw.length > userText.length, "夹具应保证元数据确实被计入");
  assert.equal(user.limit, memory.limitForMemoryKind("user"));

  const core = find("memory");
  assert.equal(core.chars, 123);
  assert.equal(core.limit, memory.limitForMemoryKind("memory"));

  // 清单里每份文件的 limit 都必须与 limitForMemoryKind 同口径
  for (const f of list().files) {
    assert.equal(f.limit, memory.limitForMemoryKind(f.kind), `${f.id} 的 limit 与 limitForMemoryKind 不一致`);
  }
});

check("③ failures 的 limit = memory 上限 × 2", () => {
  resetFixed("failures.md");
  const limits = memory.getHermesMemoryLimits();
  const failures = find("failures");
  assert.equal(failures.chars, 0, "文件不存在时 chars = 0");
  assert.equal(failures.exists, false);
  assert.equal(failures.limit, limits.memory * 2);
  assert.equal(failures.limit, limits.failure);
});

check("④ 不存在的固定文件 chars = 0，limit 仍给出", () => {
  resetFixed("MEMORY.md");
  const core = find("memory");
  assert.equal(core.exists, false);
  assert.equal(core.chars, 0);
  assert.ok(core.limit > 0, "文件不存在也要给出该 kind 的上限（供页面显示空条）");
});

/* ============================ 项目文件 ============================ */

check("⑤ 项目文件仅在磁盘上存在时出现，并带 chars / limit", () => {
  const projectsDir = memory.getHermesProjectsDir();
  const fake = "虚构项目记忆：这个项目的约定是……";
  mkdirSync(join(projectsDir, "demo-project"), { recursive: true });
  mkdirSync(join(projectsDir, "空项目"), { recursive: true }); // 目录在、MEMORY.md 不在
  writeFileSync(join(projectsDir, "demo-project", "MEMORY.md"), fake, "utf8");

  const projects = list().files.filter((f) => f.kind === "project");
  assert.deepEqual(
    projects.map((f) => f.id),
    ["project/demo-project"],
    "只有 MEMORY.md 存在的项目才进清单",
  );
  const entry = projects[0];
  assert.equal(entry.exists, true);
  assert.equal(entry.chars, fake.length);
  assert.equal(entry.limit, memory.limitForMemoryKind("project"));
  assert.equal(entry.limit, memory.getHermesMemoryLimits().project);
});

/* ============================ 回归：字段顺序 / 既有字段 ============================ */

check("⑥ 字段为 additive 追加：既有字段与顺序不变，chars/limit 在末尾", () => {
  const f = find("user");
  assert.deepEqual(Object.keys(f), [
    "id",
    "label",
    "kind",
    "path",
    "exists",
    "size",
    "modified",
    "chars",
    "limit",
  ]);
  // 既有字段值不回退
  assert.equal(typeof f.size, "number");
  assert.equal(typeof f.modified, "string");
  assert.equal(f.id, "user");
  assert.equal(f.label, "USER.md");
  assert.equal(f.kind, "user");
});

check("⑦ 空文件：exists = true 且 chars = 0（与详情卡 raw.length = 0 一致）", () => {
  writeFixed("failures.md", "");
  const f = find("failures");
  assert.equal(f.exists, true);
  assert.equal(f.size, 0);
  assert.equal(f.chars, 0);
});

console.log(fail === 0 ? `\n全部通过（7 项）` : `\n失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
