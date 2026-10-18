// 只读子代理 shell 护栏（lib/subagent-readonly-guard.ts）的自检。
//
// 分两层：
//   · 纯函数层：判据（工具集不含 edit/write = 只读）+ 只读命令判定 + 钩子包裹的调用链保留；
//   · 集成层：**真实内核会话**（createAgentSessionServices / createAgentSessionFromServices）
//     + faux provider（pi-ai 的测试用 provider，无网络）+ 真实 bash 工具，跑两条命令，
//     断言证据取自会话 JSONL 里的 **toolResult**（不是模型自述）。
//
// 运行：node tools/subagent-readonly-guard-selftest.mjs
//
// 隔离：mkdtemp 出来的临时 agentDir（PI_CODING_AGENT_DIR）+ 临时 cwd，
// 夹具命令只写临时目录里的 marker，不碰真实 ~/.pi/agent 与真实工作区。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "elenva-subagent-readonly-selftest-"));
const agentDir = join(root, "agent");
const cwd = join(root, "work");
mkdirSync(agentDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

let fail = 0;
const check = (name, fn) => {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return result.then(
        () => console.log(`PASS  ${name}`),
        (error) => {
          fail += 1;
          console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message.split("\n")[0] : error}`);
        },
      );
    }
    console.log(`PASS  ${name}`);
    return undefined;
  } catch (error) {
    fail += 1;
    console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message.split("\n")[0] : error}`);
    return undefined;
  }
};

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const guard = await jiti.import("../lib/subagent-readonly-guard.ts");

// ---------------------------------------------------------------- 纯函数层
console.log("纯函数层（判据与钩子包裹）：");

check("判据：工具集不含 edit 且不含 write = 只读子代理", () => {
  assert.equal(guard.isReadOnlySubagentTools(["read", "grep", "find", "ls"]), true, "无 shell 的只读模板");
  assert.equal(guard.isReadOnlySubagentTools(["read", "grep", "find", "ls", "bash"]), true, "复核员：有 bash 无写工具");
  assert.equal(guard.isReadOnlySubagentTools(["read", "bash", "write"]), false, "含 write 不算只读");
  assert.equal(guard.isReadOnlySubagentTools(["read", "edit"]), false, "含 edit 不算只读");
  assert.equal(guard.isReadOnlySubagentTools([]), true, "空工具集不含写工具");
});

check("命令判定：只读放行 / 写命令拦下 / 非 shell 工具不插手", () => {
  assert.equal(guard.readOnlySubagentViolation("bash", { command: "git status" }), undefined, "git status 放行");
  assert.equal(guard.readOnlySubagentViolation("bash", { command: "rg -n foo ." }), undefined, "rg 放行");
  const mkdir = guard.readOnlySubagentViolation("bash", { command: "mkdir -p /tmp/x" });
  assert.equal(mkdir?.block, true, "mkdir 必须拦下");
  assert.match(mkdir.reason, /只读/, "拒绝理由要说明「只读」");
  assert.match(mkdir.reason, /mkdir -p \/tmp\/x/, "拒绝理由要回显被拒命令");
  const rm = guard.readOnlySubagentViolation("bash", { command: "rm -rf /tmp/x" });
  assert.equal(rm?.block, true, "rm -rf 必须拦下");
  const overwrite = guard.readOnlySubagentViolation("bash", { command: "echo hi > /tmp/x" });
  assert.equal(overwrite?.block, true, "重定向写必须拦下");
  assert.equal(guard.readOnlySubagentViolation("read", { command: "rm -rf /tmp/x" }), undefined, "非 shell 工具不看");
  // 已知缺口（有意）：powershell 不判，避免用 POSIX 白名单误伤 Windows 只读命令
  assert.equal(guard.readOnlySubagentViolation("powershell", { command: "Remove-Item x" }), undefined, "powershell 有意不判");
});

check("钩子包裹：保留原调用链，只读子代理才装，原钩子的 block 优先", async () => {
  const calls = [];
  const previous = async (context) => {
    calls.push(context.toolCall.name);
    if (context.toolCall.name === "upstream-blocked") return { block: true, reason: "上游拦截" };
    return undefined;
  };

  // 写工具在手 → 不装
  const writable = { beforeToolCall: previous };
  assert.equal(guard.installReadOnlySubagentGuard(writable, ["read", "bash", "write"]), false, "写工具在手不装护栏");
  assert.equal(writable.beforeToolCall, previous, "不装时必须原样保留钩子");

  // 只读 → 装，且原钩子仍被调用
  const readonlyAgent = { beforeToolCall: previous };
  assert.equal(guard.installReadOnlySubagentGuard(readonlyAgent, ["read", "bash"]), true, "只读子代理要装护栏");
  assert.notEqual(readonlyAgent.beforeToolCall, previous, "必须在原钩子外包一层");

  const pass = await readonlyAgent.beforeToolCall({ toolCall: { name: "bash" }, args: { command: "git status" }, assistantMessage: {}, context: {} });
  assert.equal(pass, undefined, "只读命令放行");
  assert.deepEqual(calls, ["bash"], "原钩子必须被调用");

  const blocked = await readonlyAgent.beforeToolCall({ toolCall: { name: "bash" }, args: { command: "rm -rf /tmp/x" }, assistantMessage: {}, context: {} });
  assert.equal(blocked?.block, true, "写命令被拦");

  const upstream = await readonlyAgent.beforeToolCall({ toolCall: { name: "upstream-blocked" }, args: {}, assistantMessage: {}, context: {} });
  assert.equal(upstream?.reason, "上游拦截", "原钩子已 block 时以它为准");
});

// ---------------------------------------------------------------- 集成层（真实内核会话）
console.log("集成层（真实内核会话 + 真实 bash 工具，证据取会话 JSONL）：");

const { createFauxCore, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
const {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} = await import("@earendil-works/pi-coding-agent");

const faux = createFauxCore({ api: "faux", provider: "faux-readonly-selftest", models: [{ id: "faux-1" }] });
writeFileSync(join(agentDir, "auth.json"), "{}", "utf8");
const modelRuntime = await ModelRuntime.create({
  authPath: join(agentDir, "auth.json"),
  modelsPath: null,
  refreshOnCreate: false,
});
modelRuntime.registerProvider("faux-readonly-selftest", {
  name: "Faux Readonly Selftest",
  api: "faux",
  baseUrl: "http://localhost:0",
  apiKey: "fixture-key",
  streamSimple: faux.streamSimple,
  models: [{ id: "faux-1", name: "Faux 1", contextWindow: 128000, maxTokens: 16384 }],
});
const model = modelRuntime.getModel("faux-readonly-selftest", "faux-1");
assert.ok(model, "faux 模型必须注册成功");

/** 跑一个场景：真实会话 + 真实 bash 工具 + 护栏；返回会话 JSONL 里的 toolResult 列表 */
async function runBashScenario(tools, command) {
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    modelRuntime,
    settingsManager: SettingsManager.create(cwd, agentDir),
  });
  const sessionManager = SessionManager.create(cwd);
  const { session } = await createAgentSessionFromServices({ services, sessionManager, model, tools });
  const installed = guard.installReadOnlySubagentGuard(session.agent, tools);
  await session.prompt("run it", { source: "rpc" });
  const lines = readFileSync(session.sessionFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const toolResults = lines
    .filter((entry) => entry.message?.role === "toolResult")
    .map((entry) => ({
      toolName: entry.message.toolName,
      isError: entry.message.isError === true,
      text: (entry.message.content ?? []).map((block) => block.text ?? "").join("\n"),
    }));
  return { installed, toolResults };
}

await check("放行：只读子代理跑 `git status`，toolResult 不是错误", async () => {
  execFileSync("git", ["init", "-q"], { cwd });
  const { installed, toolResults } = await runBashScenario(["read", "bash"], "git status");
  assert.equal(installed, true, "只读子代理必须装上护栏");
  assert.equal(toolResults.length, 1, `应有一条 toolResult，实际 ${JSON.stringify(toolResults)}`);
  assert.equal(toolResults[0].toolName, "bash");
  assert.equal(toolResults[0].isError, false, `只读命令不该被拦：${toolResults[0].text}`);
});

await check("拒绝：只读子代理跑 `mkdir -p <marker>`，toolResult 是错误且带拒绝文案", async () => {
  const marker = join(root, "blocked-marker");
  rmSync(marker, { recursive: true, force: true });
  const { toolResults } = await runBashScenario(["read", "bash"], `mkdir -p ${JSON.stringify(marker)}`);
  assert.equal(toolResults.length, 1, `应有一条 toolResult，实际 ${JSON.stringify(toolResults)}`);
  assert.equal(toolResults[0].isError, true, `写命令必须被拦：${toolResults[0].text}`);
  assert.match(toolResults[0].text, /只读/, "拒绝理由要说明「只读」");
  assert.ok(toolResults[0].text.includes(marker), "拒绝理由要回显被拒命令");
  assert.equal(existsSync(marker), false, "被拦的命令绝不能真的执行（marker 不应存在）");
});

await check("对照组：含 write 的子代理（非只读）跑同一条写命令 → 不被护栏拦（证明拦截来自只读判据）", async () => {
  const marker = join(root, "control-marker");
  rmSync(marker, { recursive: true, force: true });
  const { installed, toolResults } = await runBashScenario(["read", "bash", "write"], `mkdir -p ${JSON.stringify(marker)}`);
  assert.equal(installed, false, "含 write 的子代理不该装护栏");
  assert.equal(toolResults.length, 1, "应有一条 toolResult");
  assert.equal(toolResults[0].isError, false, `对照组的写命令不该被拦：${toolResults[0].text}`);
  assert.equal(existsSync(marker), true, "对照组命令确实执行了（marker 存在）");
  rmSync(marker, { recursive: true, force: true });
});

rmSync(root, { recursive: true, force: true });
console.log(fail === 0 ? "\n全部通过" : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
