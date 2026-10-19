// extension-integrity-check.mjs 的自检：
//  ① 纯函数（抽相对 import / .js→.ts 解析）
//  ② 隔离夹具（一个「有 vendor 且完整」的扩展 + 一个「缺 vendor」的扩展）跑真实 CLI
//  ③ 负向验证：缺失文件必须被点名、exit 1；补回后 exit 0
//  ④ agentDir 不存在时也报缺失（不静默通过）
//
// 运行：node tools/extension-integrity-selftest.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkAgentDir,
  extractRelativeImports,
  resolveRelativeSpecifier,
} from "./extension-integrity-check.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECK = join(HERE, "extension-integrity-check.mjs");
const root = mkdtempSync(join(tmpdir(), "elenva-ext-integrity-selftest-"));

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

const run = (agentDir) => {
  try {
    const stdout = execFileSync(process.execPath, [CHECK, agentDir], { encoding: "utf8" });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ""}${e.stderr || ""}` };
  }
};

// ---------------------------------------------------------------- 纯函数
console.log("纯函数：");

check("抽相对 import：静态 / 动态 / 副作用 / require，忽略裸包与 node:", () => {
  const code = [
    'import a from "./a.js";',
    'import type { T } from "../types.js";',
    'export { b } from "./b.js";',
    'const c = await import("./c.js");',
    'import "./side.js";',
    'const d = require("./d.js");',
    'import typebox from "typebox";',
    'import fs from "node:fs";',
    'import { x } from "@earendil-works/pi-coding-agent";',
  ].join("\n");
  assert.deepEqual(
    extractRelativeImports(code).map((i) => i.spec),
    ["./a.js", "../types.js", "./b.js", "./c.js", "./side.js", "./d.js"],
  );
  assert.equal(extractRelativeImports(code)[0].line, 1);
});

check("注释里的 import 不算依赖", () => {
  const code = '// import x from "./ghost.js"\n/* import y from "./ghost2.js" */\nimport z from "./real.js";\n';
  assert.deepEqual(
    extractRelativeImports(code).map((i) => i.spec),
    ["./real.js"],
  );
});

check(".js → .ts 映射 / index 兜底 / 扩展名兜底", () => {
  const dir = join(root, "resolve");
  mkdirSync(join(dir, "pkg"), { recursive: true });
  writeFileSync(join(dir, "pkg", "index.ts"), "");
  writeFileSync(join(dir, "pkg", "deep.ts"), "");
  writeFileSync(join(dir, "pkg", "legacy.mjs"), "");
  writeFileSync(join(dir, "types.d.ts"), "");
  const from = join(dir, "entry.ts");
  writeFileSync(from, "");
  assert.equal(resolveRelativeSpecifier(from, "./pkg/index.js"), join(dir, "pkg", "index.ts"));
  assert.equal(resolveRelativeSpecifier(from, "./pkg/deep.js"), join(dir, "pkg", "deep.ts"));
  assert.equal(resolveRelativeSpecifier(from, "./pkg/legacy.js"), join(dir, "pkg", "legacy.mjs"));
  assert.equal(resolveRelativeSpecifier(from, "./pkg"), join(dir, "pkg", "index.ts"));
  assert.equal(resolveRelativeSpecifier(from, "./types.js"), join(dir, "types.d.ts"));
  assert.equal(resolveRelativeSpecifier(from, "./nope.js"), null);
});

// ---------------------------------------------------------------- 隔离夹具（真实 CLI）
console.log("隔离夹具（真实 CLI）：");

const agent = join(root, "agent");
const goodExt = join(agent, "extensions", "with-vendor");
mkdirSync(join(goodExt, "vendor", "pkg"), { recursive: true });
writeFileSync(join(goodExt, "index.ts"), 'import pkg from "./vendor/pkg/index.js";\nimport "./vendor/pkg/legacy.mjs";\n');
writeFileSync(join(goodExt, "README.md"), "# with-vendor —— 夹具（虚构）\n");
writeFileSync(join(goodExt, "vendor", "pkg", "index.ts"), 'import { deep } from "./deep.js";\n');
writeFileSync(join(goodExt, "vendor", "pkg", "deep.ts"), "export const deep = 1;\n");
writeFileSync(join(goodExt, "vendor", "pkg", "legacy.mjs"), "export default 1;\n");

const badExt = join(agent, "extensions", "missing-vendor");
mkdirSync(badExt, { recursive: true });
writeFileSync(join(badExt, "index.ts"), 'import base from "./vendor/base.js";\n');

check("静态巡检：完整扩展 OK、缺 vendor 扩展被点名（含缺失文件与引用位置）", () => {
  const result = checkAgentDir(agent);
  const good = result.extensions.find((e) => e.name === "with-vendor");
  const bad = result.extensions.find((e) => e.name === "missing-vendor");
  assert.deepEqual(good.missing, []);
  assert.equal(bad.missing.length, 1);
  assert.equal(bad.missing[0].spec, "./vendor/base.js");
  assert.equal(bad.missing[0].file, "index.ts");
  assert.equal(bad.missing[0].line, 1);
});

check("CLI：有缺失 → exit 1，输出含扩展名 / 缺失 spec / 源码位置 / 摘要行", () => {
  const r = run(agent);
  assert.equal(r.code, 1);
  assert.match(r.out, /OK {4}with-vendor/);
  assert.match(r.out, /MISS {2}missing-vendor/);
  assert.match(r.out, /✗ \.\/vendor\/base\.js {2}← index\.ts:1/);
  assert.match(r.out, /\[extension-integrity\].*缺失 1 个 \/ 缺失引用 1 处/);
});

check("负向验证：补回缺失文件后 → exit 0（证明上一条的 exit 1 是缺文件导致）", () => {
  mkdirSync(join(badExt, "vendor"), { recursive: true });
  writeFileSync(join(badExt, "vendor", "base.ts"), "export default 1;\n");
  const r = run(agent);
  assert.equal(r.code, 0, `补回后应 exit 0，实际 ${r.code}：${r.out}`);
  assert.match(r.out, /OK {4}missing-vendor/);
  assert.match(r.out, /\[extension-integrity\].*缺失 0 个 \/ 缺失引用 0 处/);
});

check("负向验证：再度删掉被引用文件 → 必须重新变红（exit 1）", () => {
  rmSync(join(badExt, "vendor", "base.ts"));
  const r = run(agent);
  assert.equal(r.code, 1);
  assert.match(r.out, /MISS {2}missing-vendor/);
});

check("agentDir 不存在 → 报缺失并 exit 1（不静默通过）", () => {
  const r = run(join(root, "no-such-agent"));
  assert.equal(r.code, 1);
  assert.match(r.out, /找不到扩展目录/);
});

check("PI_CODING_AGENT_DIR 兜底（不传参数时用它）", () => {
  // 上一条负向验证把 base.ts 删了，先补回，保证这里只测「env 兜底」这一件事
  mkdirSync(join(badExt, "vendor"), { recursive: true });
  writeFileSync(join(badExt, "vendor", "base.ts"), "export default 1;\n");
  const r = execFileSync(process.execPath, [CHECK], {
    encoding: "utf8",
    env: { ...process.env, PI_CODING_AGENT_DIR: agent },
  });
  assert.match(r, /OK {4}with-vendor/);
});

// ---------------------------------------------------------------- 收尾
rmSync(root, { recursive: true, force: true });
if (fail > 0) {
  console.log(`\n${fail} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");
