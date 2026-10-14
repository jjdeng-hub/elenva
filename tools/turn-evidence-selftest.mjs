// TurnEvidence 汇总的自检（lib/turn-evidence.ts）：项目声明的验证命令要能出「整体验证通过」。
// 运行：node tools/turn-evidence-selftest.mjs
//
// 为什么走 jiti 而不是 --experimental-strip-types：turn-evidence.ts 里是**无扩展名**的
// 相对导入（`./verification-kind`），Node 的 ESM 解析器要求写全扩展名，直载会
// ERR_MODULE_NOT_FOUND。jiti 能解析无扩展名 + `@/` 别名（该文件是纯 .ts，不含 JSX）。
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const { summarizeTurn } = await jiti.import("../lib/turn-evidence.ts");

let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
  if (!ok) fail++;
};

const TSC = "node ./node_modules/typescript/bin/tsc --noEmit";
const CONVERGE = "python3 tools/style-converge.py";
const cmd = (command, failed = false) => ({ command, failed });

// ① 标准命令（未声明）仍判 suite —— 修复不能改变既有判定
{
  const s = summarizeTurn(1, 0, [cmd(TSC)]);
  check("① 标准命令（无声明）→ suite", s.level === "suite", `level=${s.level} kind=${s.checks[0]?.kind}`);
  check("① 结论为「整体验证通过」", s.headline.startsWith("整体验证通过"), s.headline);
  check("① 已知工具种类未被覆盖", s.checks[0]?.kind === "typecheck", `kind=${s.checks[0]?.kind}`);
}

// ② 声明命中 → custom / suite → 汇总升级为「整体验证通过（命令）」
{
  const s = summarizeTurn(1, 0, [cmd(CONVERGE)], ["style-converge"]);
  check("② 声明命中 → level suite", s.level === "suite", `level=${s.level}`);
  check("② 判定为 custom/suite", s.checks[0]?.kind === "custom" && s.checks[0]?.scope === "suite", `kind=${s.checks[0]?.kind}/${s.checks[0]?.scope}`);
  check("② 结论带上了命令", s.headline === `整体验证通过（${CONVERGE}）`, s.headline);
  check("② 短句为「整体验证通过」", s.shortHeadline === "整体验证通过", s.shortHeadline);
  check("② tone=ok", s.tone === "ok", s.tone);
  // 大小写 / 前后空格无关（服务端声明契约）
  const loose = summarizeTurn(1, 0, [cmd(CONVERGE)], ["  STYLE-CONVERGE  "]);
  check("② 子串匹配大小写无关", loose.level === "suite", `level=${loose.level}`);
}

// ③ 声明未命中 → 仍算「未跑验证」
{
  const s = summarizeTurn(1, 0, [cmd(CONVERGE)], ["something-else"]);
  check("③ 声明未命中 → level none", s.level === "none", `level=${s.level}`);
  check("③ 结论文案保持原样", s.headline === "本轮未跑验证 · 结论未经核对", s.headline);
  check("③ 非验证命令不进 checks", s.checks.length === 0, `checks=${s.checks.length}`);
}

// ④ 声明命中但失败 → failed 计数与结论文案正确
{
  const s = summarizeTurn(1, 0, [cmd(CONVERGE, true)], ["style-converge"]);
  check("④ 失败 → level failed", s.level === "failed", `level=${s.level}`);
  check("④ failed 计数 = 1", s.failed === 1 && s.checks.filter((c) => c.failed === true).length === 1, `failed=${s.failed}`);
  check("④ 结论为「验证未通过（0/1）」", s.headline === "验证未通过（0/1）", s.headline);
  check("④ tone=danger", s.tone === "danger", s.tone);
}

// ⑤ 不变式：declaredPatterns 省略 / undefined / [] —— 输出逐字节一致
{
  const commands = [cmd(TSC), cmd("npm run build"), cmd(CONVERGE), cmd("git status")];
  const base = JSON.stringify(summarizeTurn(2, 1, commands));
  const withUndef = JSON.stringify(summarizeTurn(2, 1, commands, undefined));
  const withEmpty = JSON.stringify(summarizeTurn(2, 1, commands, []));
  check("⑤ undefined 与省略逐字节一致", base === withUndef);
  check("⑤ 空数组与省略逐字节一致", base === withEmpty);
}

// ⑥ 已知工具优先于声明（`npm test` 声明后仍是「测试」而非笼统的「项目检查」）
{
  const s = summarizeTurn(1, 0, [cmd("npm test")], ["npm test"]);
  check("⑥ 已知工具种类不被声明覆盖", s.checks[0]?.kind === "test", `kind=${s.checks[0]?.kind}`);
}

console.log(fail === 0 ? "\nSELFTEST: OK" : `\nSELFTEST: ${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
