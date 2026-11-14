#!/usr/bin/env node
/**
 * 内核形态「运行期」升级门 —— 补 `tools/pi-surface-check.ts`（tsc，只看类型）看不见的那一半。
 *
 * 两组断言，都打在**真实返回值 / 真实模块导出**上：
 *
 *   ① 技能块解析：内核导出的 `parseSkillBlock`（`lib/skill-usage.ts` 的隐式依赖）
 *      · 标准形态 `<skill name="…" location="…">\nbody\n</skill>\n\nuser`
 *        → 各字段取值正确；
 *      · **不以技能块起始**的文本 → falsy（这正是「引用/讨论不算调用」的判据）；
 *      · **缺字段**的文本 → falsy；
 *      · 无尾随用户文本时 `userMessage === undefined`。
 *
 *   ② MCP 运行时形态：`lib/mcp-probe.ts` 走非公开面
 *      `getPackageDir()` + `dist/extensions/mcp/runtime.js`，依赖
 *      `McpServerConnection` / `createDefaultTransport` / `McpOAuthCredentialStore`。
 *      缺任一导出即红（探针会整体降级，是**静默**的能力损失，必须有人拦）。
 *
 * 为什么与 pi-surface-check.ts 分家：那个文件靠 **tsc 报错**当信号，只能守类型；
 * MCP 内部路径不在 package `exports` 里，tsc 根本解析不到；`parseSkillBlock` 的
 * 运行期行为（falsy 判定）也不在类型里。所以运行期断言单独成门，同样进 CI。
 *
 * 退出码 0 = 全绿；1 = 有断言失败（失败信息写明「内核形态漂移 → 请按 docs/pi-upgrade.md 复核」）。
 *
 * 运行：node tools/pi-surface-runtime-check.mjs
 */
import { getPackageDir, parseSkillBlock } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DRIFT = "内核形态漂移 → 请按 docs/pi-upgrade.md 复核";

let fail = 0;
const check = (name, fn) => {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return result.then(
        () => console.log(`PASS  ${name}`),
        (error) => {
          fail += 1;
          console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
        },
      );
    }
    console.log(`PASS  ${name}`);
    return undefined;
  } catch (error) {
    fail += 1;
    console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
};
const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};

console.log("① 技能块解析（parseSkillBlock，lib/skill-usage.ts 的隐式依赖）");

await check("导出形态：parseSkillBlock 是函数", () => {
  assert(typeof parseSkillBlock === "function", `${DRIFT}：内核不再导出 parseSkillBlock（函数）`);
});

await check("标准形态：返回 name / location / content / userMessage 且取值正确", () => {
  const block = parseSkillBlock(
    '<skill name="demo-skill" location="/tmp/demo/skills/demo-skill/SKILL.md">\nbody line 1\nbody line 2\n</skill>\n\nuser request',
  );
  assert(block, `${DRIFT}：标准形态未解析出技能块（返回 falsy）`);
  assert(block.name === "demo-skill", `${DRIFT}：name 字段漂移（实际 ${JSON.stringify(block.name)}）`);
  assert(
    block.location === "/tmp/demo/skills/demo-skill/SKILL.md",
    `${DRIFT}：location 字段漂移（实际 ${JSON.stringify(block.location)}）`,
  );
  assert(block.content === "body line 1\nbody line 2", `${DRIFT}：content 字段漂移（实际 ${JSON.stringify(block.content)}）`);
  assert(block.userMessage === "user request", `${DRIFT}：userMessage 字段漂移（实际 ${JSON.stringify(block.userMessage)}）`);
});

await check("非块起始：引用/讨论形态返回 falsy（位置不对即不是调用）", () => {
  const block = parseSkillBlock('引用一下 <skill name="demo-skill" location="/x">\nbody\n</skill>\n\n后面还有话');
  assert(!block, `${DRIFT}：不在文本起始的 skill 块不应被解析（引用被当成调用）`);
});

await check("缺字段：缺 location / 缺 name 均返回 falsy", () => {
  assert(
    !parseSkillBlock('<skill name="demo-skill">\nbody\n</skill>'),
    `${DRIFT}：缺 location 的块不应被解析`,
  );
  assert(
    !parseSkillBlock('<skill location="/x/SKILL.md">\nbody\n</skill>'),
    `${DRIFT}：缺 name 的块不应被解析`,
  );
});

await check("无尾随文本：userMessage 为 undefined（不是空串 / null）", () => {
  const block = parseSkillBlock('<skill name="demo-skill" location="/x/SKILL.md">\nbody\n</skill>');
  assert(block, `${DRIFT}：无尾随文本的标准块应能解析`);
  assert(block.userMessage === undefined, `${DRIFT}：userMessage 语义漂移（实际 ${JSON.stringify(block.userMessage)}）`);
});

console.log("② MCP 运行时形态（lib/mcp-probe.ts 的非公开依赖面）");

await check("dist/extensions/mcp/runtime.js 仍导出探针所需的三个符号", async () => {
  const url = pathToFileURL(join(getPackageDir(), "dist", "extensions", "mcp", "runtime.js")).href;
  let mod;
  try {
    mod = await import(url);
  } catch (error) {
    throw new Error(
      `${DRIFT}：内部路径 dist/extensions/mcp/runtime.js 已变动（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
  for (const name of ["McpServerConnection", "createDefaultTransport", "McpOAuthCredentialStore"]) {
    assert(typeof mod[name] === "function", `${DRIFT}：内核 MCP 运行时缺导出 ${name}（lib/mcp-probe.ts 依赖它）`);
  }
});

console.log(fail === 0 ? "\n全部通过" : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
