// 内置扩展与技能目录（lib/builtin-catalog.ts）的自检：
// 纯函数（复制滤镜 / 逐文件差异 / 三态归并 / 白名单 / README 说明提取）
// + IO 层（枚举状态 / 同语义复制 / 白名单拒绝 / 依赖提示）
// + **一致性**：lib 的复制结果 == 直接跑真实 install.mjs 的复制结果（同一份源、两个目标目录）。
//
// 运行：node tools/builtin-catalog-selftest.mjs
//
// 隔离：全在 mkdtemp 出来的临时目录里造「仓库 + 两个 agent 目录」，用**虚构**数据，
// 不碰真实 ~/.pi/agent。lib/*.ts 是纯 TS（无 JSX），jiti 可直载（见记忆 F3）。
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createJiti } from "jiti";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "elenva-builtin-catalog-selftest-"));

let fail = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`FAIL  ${name}\n      ${e instanceof Error ? e.message.split("\n")[0] : e}`);
  }
};
const checkAsync = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`FAIL  ${name}\n      ${e instanceof Error ? e.message.split("\n")[0] : e}`);
  }
};

// ---------------------------------------------------------------- 造临时「仓库」
const repo = join(root, "repo");
// 扩展名必须与脚本里硬编码的目标名一致（真实 install.mjs 把它写死成 extensions/<本名>），
// 所以借 elenva-todo 的脚本 + 同名目录来验「lib 复制 == 脚本复制」。
const EXT_NAME = "elenva-todo";
const extDemo = join(repo, "extensions", EXT_NAME);
mkdirSync(extDemo, { recursive: true });
cpSync(join(REPO, "extensions", EXT_NAME, "install.mjs"), join(extDemo, "install.mjs"));
writeFileSync(join(extDemo, "index.ts"), "export const runtime = 1;\n");
writeFileSync(join(extDemo, "ledger.ts"), "export const ledger = 2;\n");
writeFileSync(join(extDemo, "README.md"), "# demo —— 演示扩展\n\n正文不该被当成说明\n");
writeFileSync(join(extDemo, "selftest.mjs"), "// 不该被装进去\n");

const skillsRoot = join(repo, "skills");
mkdirSync(join(skillsRoot, "alpha"), { recursive: true });
cpSync(join(REPO, "skills", "install.mjs"), join(skillsRoot, "install.mjs"));
writeFileSync(join(skillsRoot, "alpha", "SKILL.md"), "# alpha\n\n正文\n");
writeFileSync(join(skillsRoot, "alpha", "helper.md"), "辅助\n");
mkdirSync(join(skillsRoot, "beta"), { recursive: true });
writeFileSync(join(skillsRoot, "beta", "SKILL.md"), "# beta\n");

const agentA = join(root, "agent-install-mjs"); // 走真实脚本
const agentB = join(root, "agent-lib"); // 走 lib
const agentC = join(root, "agent-status"); // 只用来测状态迁移

// 两个目标目录都预置「幽灵文件」：扩展侧脚本会删、技能侧脚本不删 —— 两条语义都要对上
for (const agent of [agentA, agentB]) {
  mkdirSync(join(agent, "extensions", EXT_NAME), { recursive: true });
  writeFileSync(join(agent, "extensions", EXT_NAME, "ghost.ts"), "stale\n");
  mkdirSync(join(agent, "skills", "alpha"), { recursive: true });
  writeFileSync(join(agent, "skills", "alpha", "ghost.md"), "stale\n");
}

process.env.PI_CODING_AGENT_DIR = agentB; // lib 的缺省 agent 目录（注入 agentRoot 时被覆盖）
const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const lib = await jiti.import("../lib/builtin-catalog.ts");

// ---------------------------------------------------------------- 纯函数
console.log("纯函数：");

check("复制滤镜只认 *.ts 与 README.md", () => {
  assert.equal(lib.isRuntimeExtensionFile("index.ts"), true);
  assert.equal(lib.isRuntimeExtensionFile("README.md"), true);
  assert.equal(lib.isRuntimeExtensionFile("selftest.mjs"), false);
  assert.equal(lib.isRuntimeExtensionFile("tidy-cli.mjs"), false);
});

check("逐文件差异：缺失 / 不同 / 多余分别归位", () => {
  const src = { "a.ts": "1", "b.ts": "2", "c/README.md": "3" };
  const dst = { "a.ts": "1", "b.ts": "x", "d.ts": "4" };
  assert.deepEqual(lib.diffTree(src, dst), {
    missing: ["c/README.md"],
    different: ["b.ts"],
    extra: ["d.ts"],
  });
});

check("三态归并：空目标=missing，有差异=outdated，干净=installed", () => {
  const opts = { extraIsOutdated: true };
  assert.equal(lib.statusFromDiff({ missing: [], different: [], extra: [] }, { targetFileCount: 0, ...opts }), "missing");
  assert.equal(lib.statusFromDiff({ missing: ["a"], different: [], extra: [] }, { targetFileCount: 3, ...opts }), "outdated");
  assert.equal(lib.statusFromDiff({ missing: [], different: ["a"], extra: [] }, { targetFileCount: 3, ...opts }), "outdated");
  assert.equal(lib.statusFromDiff({ missing: [], different: [], extra: ["ghost"] }, { targetFileCount: 3, ...opts }), "outdated");
  assert.equal(lib.statusFromDiff({ missing: [], different: [], extra: [] }, { targetFileCount: 3, ...opts }), "installed");
});

check("多余文件对 skills 不算 outdated（脚本不删，一键也装不掉）", () => {
  const diff = { missing: [], different: [], extra: ["alpha/ghost.md"] };
  assert.equal(lib.statusFromDiff(diff, { targetFileCount: 2, extraIsOutdated: false }), "installed");
  assert.equal(lib.statusFromDiff(diff, { targetFileCount: 2, extraIsOutdated: true }), "outdated");
});

check("白名单只认显式列出的项", () => {
  const allowed = [`extensions/${EXT_NAME}`, "skills"];
  assert.equal(lib.isAllowedBuiltinPath(`extensions/${EXT_NAME}`, allowed), true);
  assert.equal(lib.isAllowedBuiltinPath("skills", allowed), true);
  assert.equal(lib.isAllowedBuiltinPath("extensions/../etc", allowed), false);
  assert.equal(lib.isAllowedBuiltinPath("/etc/passwd", allowed), false);
});

check("README 说明取「—— 后面那句」，取不到用兜底", () => {
  assert.equal(lib.descriptionFromReadme("# demo —— 演示扩展\n\n正文", "fallback"), "演示扩展");
  assert.equal(lib.descriptionFromReadme("# 就一个标题\n", "fallback"), "fallback");
  assert.equal(lib.descriptionFromReadme("没有标题\n", "fallback"), "fallback");
});

check("状态文案三态齐全", () => {
  assert.equal(lib.statusLabel("missing"), "未安装");
  assert.equal(lib.statusLabel("installed"), "已安装");
  assert.equal(lib.statusLabel("outdated"), "可更新");
});

// ---------------------------------------------------------------- IO 层：状态迁移 / 白名单 / 依赖
console.log("IO 层：");

await checkAsync("枚举仓库：扩展逐项 + 技能整体一项，说明取自 README 首行", async () => {
  const { items } = await lib.computeBuiltinCatalog(repo, agentC);
  assert.deepEqual(items.map((i) => i.path), [`extensions/${EXT_NAME}`, "skills"]);
  const demo = items[0];
  assert.equal(demo.kind, "extension");
  assert.equal(demo.description, "演示扩展");
  assert.equal(demo.status, "missing"); // 还没装
  assert.equal(demo.restartRequired, true);
  assert.equal(demo.installCommand, `node extensions/${EXT_NAME}/install.mjs`);
  assert.equal(items[1].kind, "skills");
  assert.equal(items[1].status, "missing");
  assert.equal(items[1].restartRequired, false);
  assert.equal(items[1].installCommand, "node skills/install.mjs");
});

await checkAsync("白名单：越界路径与不存在的项都被拒", async () => {
  for (const bad of ["extensions/../../etc", "extensions/nope", "skills/alpha", "/etc/passwd", ".."]) {
    const r = await lib.installBuiltin(repo, bad, agentC);
    assert.equal(r.ok, false, `${bad} 应被拒`);
  }
});

await checkAsync("装扩展：状态 missing→installed，只落 *.ts + README，幽灵文件被清", async () => {
  mkdirSync(join(agentC, "extensions", EXT_NAME), { recursive: true });
  writeFileSync(join(agentC, "extensions", EXT_NAME, "ghost.ts"), "stale\n");
  const r = await lib.installBuiltin(repo, `extensions/${EXT_NAME}`, agentC);
  assert.equal(r.ok, true);
  assert.equal(r.item.status, "installed");
  const tree = await lib.snapshotTree(join(agentC, "extensions", EXT_NAME));
  assert.deepEqual(Object.keys(tree).sort(), ["README.md", "index.ts", "ledger.ts"]);
  assert.equal(tree["selftest.mjs"], undefined, "selftest 不该被装");
});

await checkAsync("改源文件 → 状态转 outdated；再装回 installed", async () => {
  writeFileSync(join(extDemo, "ledger.ts"), "export const ledger = 3;\n");
  const before = await lib.computeBuiltinCatalog(repo, agentC);
  assert.equal(before.items.find((i) => i.path === `extensions/${EXT_NAME}`).status, "outdated");
  await lib.installBuiltin(repo, `extensions/${EXT_NAME}`, agentC);
  const after = await lib.computeBuiltinCatalog(repo, agentC);
  assert.equal(after.items.find((i) => i.path === `extensions/${EXT_NAME}`).status, "installed");
});

await checkAsync("装技能：整体复制进去；目标里多余的文件不被算作 outdated（也不删除）", async () => {
  const r = await lib.installBuiltin(repo, "skills", agentC);
  assert.equal(r.ok, true);
  const tree = await lib.snapshotTree(join(agentC, "skills"));
  assert.deepEqual(Object.keys(tree).sort(), ["alpha/SKILL.md", "alpha/helper.md", "beta/SKILL.md"]);
  // 预置一个多余文件：脚本语义不删，状态也应保持 installed
  writeFileSync(join(agentC, "skills", "alpha", "ghost.md"), "stale\n");
  const after = await lib.computeBuiltinCatalog(repo, agentC);
  assert.equal(after.items.find((i) => i.path === "skills").status, "installed");
  assert.equal(readFileSync(join(agentC, "skills", "alpha", "ghost.md"), "utf8"), "stale\n");
});

await checkAsync("依赖提示：elenva-memory 依赖 pi-hermes-memory（未装 needsDependency=true）", async () => {
  // 在临时仓库里补一个真名 elenva-memory 扩展（只为触发依赖规则）
  const memDir = join(repo, "extensions", "elenva-memory");
  mkdirSync(memDir, { recursive: true });
  cpSync(join(REPO, "extensions", "elenva-memory", "install.mjs"), join(memDir, "install.mjs"));
  writeFileSync(join(memDir, "index.ts"), "export const m = 1;\n");
  writeFileSync(join(memDir, "README.md"), "# elenva-memory —— 记忆索引\n");
  const before = await lib.computeBuiltinCatalog(repo, agentC);
  const mem = before.items.find((i) => i.path === "extensions/elenva-memory");
  assert.equal(mem.needsDependency, true);
  assert.equal(mem.dependencyName, "pi-hermes-memory");
  assert.match(mem.dependencyNote, /pi-hermes-memory/);
  // 让依赖"看起来已装"（agent 扩展目录里有它）→ 提示消失
  mkdirSync(join(agentC, "extensions", "pi-hermes-memory"), { recursive: true });
  const after = await lib.computeBuiltinCatalog(repo, agentC);
  assert.equal(after.items.find((i) => i.path === "extensions/elenva-memory").needsDependency, false);
  rmSync(join(agentC, "extensions", "pi-hermes-memory"), { recursive: true, force: true });
  rmSync(memDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 一致性：lib vs 真实 install.mjs
console.log("与 install.mjs 的一致性：");

execFileSync(process.execPath, [join(extDemo, "install.mjs")], {
  env: { ...process.env, PI_CODING_AGENT_DIR: agentA },
});
execFileSync(process.execPath, [join(skillsRoot, "install.mjs")], {
  env: { ...process.env, PI_CODING_AGENT_DIR: agentA },
});
await lib.installBuiltin(repo, `extensions/${EXT_NAME}`, agentB);
await lib.installBuiltin(repo, "skills", agentB);

await checkAsync("扩展：lib 复制结果 == install.mjs 复制结果（含幽灵文件都被清）", async () => {
  const a = await lib.snapshotTree(join(agentA, "extensions", EXT_NAME));
  const b = await lib.snapshotTree(join(agentB, "extensions", EXT_NAME));
  assert.deepEqual(b, a);
  assert.equal(a["ghost.ts"], undefined, "幽灵文件应被两边都清掉");
});

await checkAsync("技能：lib 复制结果 == install.mjs 复制结果（含多余文件都不删）", async () => {
  const a = await lib.snapshotTree(join(agentA, "skills"));
  const b = await lib.snapshotTree(join(agentB, "skills"));
  assert.deepEqual(b, a);
  assert.equal(readFileSync(join(agentA, "skills", "alpha", "ghost.md"), "utf8"), "stale\n");
  assert.equal(readFileSync(join(agentB, "skills", "alpha", "ghost.md"), "utf8"), "stale\n");
});

await checkAsync("默认 agent 根目录尊重 PI_CODING_AGENT_DIR（与 install.mjs 同口径）", async () => {
  assert.equal(await lib.resolveAgentRoot(), agentB);
});

// ---------------------------------------------------------------- 收尾
rmSync(root, { recursive: true, force: true });
if (fail > 0) {
  console.log(`\n${fail} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");
