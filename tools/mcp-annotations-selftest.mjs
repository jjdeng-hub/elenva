// MCP annotations 进审批判定（lib/tool-risk.ts）的自检：
// 纯函数层「并集兜底」规则 —— 词段表先行、destructiveHint 收紧、readOnlyHint 放宽、
// 互不覆盖、只对 mcp__ 生效；外加 needsApproval 的档位联动。
// 运行：node tools/mcp-annotations-selftest.mjs
//
// 隔离：纯函数无 IO；仍按项目惯例把 PI_CODING_AGENT_DIR 指向 mkdtemp，全用虚构数据。
// lib/*.ts 是纯 TS（无 JSX），jiti 可直载（见记忆 F1/F3）。
import { createJiti } from "jiti";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "elenva-mcp-annotations-selftest-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const { classifyToolCall, needsApproval } = await jiti.import("../lib/tool-risk.ts");

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
const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};
const eq = (actual, expected, message) =>
  assert(
    actual === expected,
    `${message}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`,
  );

const ctx = (mcpAnnotations) => ({ cwd: "/home/demo/pi-workspace", mcpAnnotations });
const isWrite = (risk) => risk.mcpWrite === true;

// ── ① readOnlyHint 明确放宽 ─────────────────────────────────────────────
check("readOnlyHint + 词段未命中 → safe（任何档位都不弹卡）", () => {
  const risk = classifyToolCall("mcp__notes__search", {}, ctx({ readOnlyHint: true }));
  eq(risk.level, "safe", "level");
  eq(risk.ruleKey, "", "safe 不带 ruleKey");
  assert(!isWrite(risk), "不应标为 mcpWrite");
  for (const mode of ["off", "risky", "writes"]) {
    assert(!needsApproval(risk, mode), `mode=${mode} 不应弹卡`);
  }
});

// ── ② destructiveHint 明确收紧 ─────────────────────────────────────────
check("destructiveHint + 词段未命中 → 按写操作（risky 也弹卡）", () => {
  const risk = classifyToolCall("mcp__db__purge", {}, ctx({ destructiveHint: true }));
  eq(risk.level, "guarded", "level");
  eq(risk.mcpWrite, true, "标为 mcpWrite");
  eq(risk.ruleKey, "mcp-server:db", "ruleKey 落到服务器级");
  assert(needsApproval(risk, "risky"), "risky 档位必须弹卡");
  assert(needsApproval(risk, "writes"), "writes 档位必须弹卡");
  assert(!needsApproval(risk, "off"), "off 档位总闸优先");
});

check("destructiveHint 的理由写明是服务器标注（与词段命中可区分）", () => {
  const risk = classifyToolCall("mcp__db__purge", {}, ctx({ destructiveHint: true }));
  assert(risk.reason.includes("destructiveHint"), `理由应提到 destructiveHint：${risk.reason}`);
});

// ── ③ 词段表先行：annotations 不能把它放宽/覆盖 ──────────────────────
check("词段命中（delete）仍按写操作 —— readOnlyHint 不能放宽", () => {
  const withReadOnly = classifyToolCall("mcp__notes__delete_note", {}, ctx({ readOnlyHint: true }));
  eq(withReadOnly.level, "guarded", "level");
  eq(withReadOnly.mcpWrite, true, "标为 mcpWrite");
  const noAnnotations = classifyToolCall("mcp__notes__delete_note", {}, ctx(undefined));
  eq(withReadOnly.ruleKey, noAnnotations.ruleKey, "ruleKey 与纯词段判定一致");
  eq(withReadOnly.reason, noAnnotations.reason, "理由与纯词段判定一致");
});

check("词段命中（update）时 annotations 不影响原判定（互不覆盖）", () => {
  const base = classifyToolCall("mcp__notes__update_note", {}, ctx(undefined));
  const withHints = classifyToolCall("mcp__notes__update_note", {}, ctx({ readOnlyHint: false, destructiveHint: true }));
  eq(withHints.level, base.level, "level 不变");
  eq(withHints.reason, base.reason, "理由不变");
  eq(withHints.ruleKey, base.ruleKey, "ruleKey 不变");
});

// ── ④ 无 annotations：行为与既有默认一致 ─────────────────────────────
check("无 annotations + 词段未命中 → 默认 guarded（不标 mcpWrite、risky 不弹）", () => {
  const risk = classifyToolCall("mcp__notes__search", {}, ctx(undefined));
  eq(risk.level, "guarded", "level");
  assert(!isWrite(risk), "不应标为 mcpWrite");
  assert(!needsApproval(risk, "risky"), "risky 档位不应弹卡");
});

check("readOnlyHint=false / destructiveHint=false 不改变默认", () => {
  const risk = classifyToolCall(
    "mcp__notes__search",
    {},
    ctx({ readOnlyHint: false, destructiveHint: false }),
  );
  eq(risk.level, "guarded", "level");
  assert(!isWrite(risk), "不应标为 mcpWrite");
});

// ── ⑤ 矛盾的 annotations：以收紧为准 ────────────────────────────────
check("readOnlyHint + destructiveHint 同时 true → 以收紧为准（弹卡）", () => {
  const risk = classifyToolCall(
    "mcp__db__purge",
    {},
    ctx({ readOnlyHint: true, destructiveHint: true }),
  );
  assert(isWrite(risk), "应标为 mcpWrite");
  assert(needsApproval(risk, "risky"), "risky 档位必须弹卡");
});

// ── ⑥ 只对 mcp__ 工具有意义 ─────────────────────────────────────────
check("非 mcp__ 工具忽略 mcpAnnotations", () => {
  const without = classifyToolCall("read", {}, ctx(undefined));
  const withHints = classifyToolCall("read", {}, ctx({ destructiveHint: true, readOnlyHint: false }));
  eq(withHints.level, without.level, "level 不受影响");
  eq(withHints.reason, without.reason, "理由不受影响");
});

// ── ⑦ 服务器名规范化（mcp__<server>__<tool>）────────────────────────
check("annotations 判定下 ruleKey 仍按服务器名规范化", () => {
  const risk = classifyToolCall(
    "mcp__my_server__purge_all",
    {},
    ctx({ destructiveHint: true }),
  );
  eq(risk.ruleKey, "mcp-server:my-server", "下划线服务器名以短横落 key");
});

rmSync(root, { recursive: true, force: true });
console.log(fail === 0 ? "\n全部通过" : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
