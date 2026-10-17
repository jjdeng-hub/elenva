// 记忆扩展「装没装」判定的回归自检（lib/agent-memory.ts 的 isPiHermesMemoryConfigured）。
//
// 背景（假警报）：记忆 2.0 收编后底座从 settings.packages 摘除（packages: []），
// 扩展自持在 <agentDir>/extensions/elenva-memory/。旧实现只看 packages，
// 于是记忆页一直误报「未检测到 pi-hermes-memory」。
//
// 覆盖三种情形 + 两条边界：
//   ① 仅自持扩展（packages 空）→ true
//   ② 仅旧装法（packages 挂 pi-hermes-memory，无自持扩展）→ true
//   ③ 都没有 → false
//   ④ 自持扩展存在但 settings.json 缺失 → true（不再依赖 settings）
//   ⑤ 什么都没装、settings.json 也不存在 → false
//
// 运行：node tools/memory-detection-selftest.mjs
// 隔离：PI_CODING_AGENT_DIR 指向 mkdtemp，全用虚构数据，不碰真实 agent 目录。
import { createJiti } from "jiti";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "elenva-memory-detection-selftest-"));
process.env.PI_CODING_AGENT_DIR = root;

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const { isPiHermesMemoryConfigured } = await jiti.import("../lib/agent-memory.ts");

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
const assertEqual = (actual, expected, message) => {
  if (actual !== expected) throw new Error(`${message}: 期望 ${expected}，实得 ${actual}`);
};

/** 造一个全新的 agent 目录（每次判定都从零开始，避免用例间互相污染） */
function makeAgentDir(name, { selfHosted, packages }) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  if (selfHosted) {
    // 自持扩展的真实形态：扩展目录 + vendored 底座
    mkdirSync(join(dir, "extensions", "elenva-memory", "vendor", "pi-hermes-memory"), { recursive: true });
  }
  if (packages !== undefined) {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ packages }, null, 2), "utf8");
  }
  return dir;
}

const withAgentDir = (dir, fn) => {
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    fn();
  } finally {
    process.env.PI_CODING_AGENT_DIR = prev;
  }
};

check("① 仅自持扩展（packages: []）→ true", () => {
  const dir = makeAgentDir("self-hosted", { selfHosted: true, packages: [] });
  withAgentDir(dir, () => assertEqual(isPiHermesMemoryConfigured(), true, "自持扩展应判为已装"));
});

check("② 仅旧装法（packages 挂 pi-hermes-memory）→ true", () => {
  const dir = makeAgentDir("legacy-packages", { selfHosted: false, packages: ["npm:pi-hermes-memory@2.0.0"] });
  withAgentDir(dir, () => assertEqual(isPiHermesMemoryConfigured(), true, "旧 packages 应判为已装（兼容回滚）"));
});

check("③ 都没有（packages: []，无自持扩展）→ false", () => {
  const dir = makeAgentDir("none", { selfHosted: false, packages: [] });
  withAgentDir(dir, () => assertEqual(isPiHermesMemoryConfigured(), false, "两者都无应判为未装"));
});

check("④ 自持扩展存在、settings.json 缺失 → true", () => {
  const dir = makeAgentDir("self-hosted-no-settings", { selfHosted: true });
  withAgentDir(dir, () => assertEqual(isPiHermesMemoryConfigured(), true, "自持扩展不应依赖 settings.json"));
});

check("⑤ 什么都没装、settings.json 也不存在 → false", () => {
  const dir = makeAgentDir("empty", {});
  withAgentDir(dir, () => assertEqual(isPiHermesMemoryConfigured(), false, "空目录应判为未装"));
});

rmSync(root, { recursive: true, force: true });
console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
