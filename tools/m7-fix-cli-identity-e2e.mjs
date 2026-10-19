// 模块 7 修复轮 ②：CLI / 飞书侧身份段「同源装配」的端到端取证。
//
// 证明：改 <agentDir>/elenva-identity.json → **新建真实内核会话**（无 appendSystemPrompt）时，
//       扩展 before_agent_start 钩子把文件最新身份装配进**真实模型请求**的系统消息，
//       并就地替换 APPEND_SYSTEM.md 受管段里的安装期种子；文件缺失时保留种子兜底；
//       ELENVA_WEB_HOST=1 时扩展静默（差分行为不变）。
//
// 两个读点各取所长：
//   · 注入了文件身份的会话 → 读**出站请求上下文**（faux 响应工厂拿到的系统消息）；
//   · 未注入（文件缺失 / web 宿主）→ 读 `session.agent.state.systemPrompt`（基座渲染，含 APPEND_SYSTEM）。
//     `state.systemPrompt` 在 run 结束会被重置，看不到 forceSystemPrompt，故不用于注入场景。
//
// 隔离：全部在 mkdtemp 出的 agentDir 内；不碰真实 ~/.pi/agent、不装扩展、不重启服务。
// 运行：node tools/m7-fix-cli-identity-e2e.mjs
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_SRC = join(HERE, "..", "extensions", "elenva-host-guard");

const root = mkdtempSync(join(tmpdir(), "m7-fix-cli-identity-"));
const agentDir = join(root, "agent");
const cwd = join(root, "work");
mkdirSync(agentDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.ELENVA_WEB_HOST;
delete process.env.ELENVA_HOST_GUARD_DISABLE;

// ① 安装扩展到隔离 agentDir（镜像 install.mjs 的文件集），并写入 APPEND_SYSTEM 种子受管段
const extDir = join(agentDir, "extensions", "elenva-host-guard");
mkdirSync(extDir, { recursive: true });
for (const name of readdirSync(EXT_SRC)) {
  if (name.endsWith(".ts") || name === "README.md") copyFileSync(join(EXT_SRC, name), join(extDir, name));
}
const sync = await import("../extensions/elenva-host-guard/sync-identity.mjs");
sync.syncIdentity({ agentRoot: agentDir });
const appendPath = join(agentDir, "APPEND_SYSTEM.md");
assert.match(readFileSync(appendPath, "utf8"), /elenva-host:begin/, "安装期种子应写进 APPEND_SYSTEM.md");
/** 种子短版里独有的一句（用来判断种子是否被替换） */
const SEED_MARK = "并登记到 ELENVA 工作台";

// ② 身份编辑器写入的身份文件（哨兵 A / B）
const identityPath = join(agentDir, "elenva-identity.json");
const writeIdentity = (marker) =>
  writeFileSync(
    identityPath,
    JSON.stringify({ version: 1, updatedAt: "2026-10-19T00:00:00.000Z", sections: [{ id: "persona", title: "自我认知", body: `CLI 同源身份。${marker}` }] }),
    "utf8",
  );
const MARK_A = "【CLI-同源-A】";
const MARK_B = "【CLI-同源-B】";
writeIdentity(MARK_A);

const { createFauxCore, fauxAssistantMessage } = await import("@earendil-works/pi-ai/providers/faux");
const { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager } = await import(
  "@earendil-works/pi-coding-agent"
);

const faux = createFauxCore({ api: "faux", provider: "faux-cli-identity", models: [{ id: "faux-1" }] });
writeFileSync(join(agentDir, "auth.json"), "{}", "utf8");
const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
modelRuntime.registerProvider("faux-cli-identity", {
  name: "Faux CLI Identity",
  api: "faux",
  baseUrl: "http://localhost:0",
  apiKey: "fixture-key",
  streamSimple: faux.streamSimple,
  models: [{ id: "faux-1", name: "Faux 1", contextWindow: 128000, maxTokens: 16384 }],
});
const model = modelRuntime.getModel("faux-cli-identity", "faux-1");

/** 起真实内核会话（不传 appendSystemPrompt）；返回出站请求系统消息 + 基座渲染的系统提示词 */
async function newSession() {
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    modelRuntime,
    settingsManager: SettingsManager.create(cwd, agentDir),
  });
  const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.create(cwd), model });
  let captured = null;
  faux.setResponses([
    (context) => {
      captured = context;
      return fauxAssistantMessage("ok");
    },
  ]);
  await session.prompt("就绪", { source: "rpc" });
  const messages = captured?.messages ?? [];
  const system = messages.find((message) => message.role === "system");
  const requestPrompt = typeof system?.content === "string" ? system.content : "";
  const statePrompt = session.agent?.state?.systemPrompt ?? "";
  return { session, requestPrompt, statePrompt };
}

const results = [];
const check = (name, ok, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
};

// ③ 新会话的真实请求：含身份文件最新值、安装期种子被替换（不重复注入）
const s1 = await newSession();
assert.ok(s1.requestPrompt.length > 0, "应捕获到出站请求的系统消息");
check("真内核新会话（出站请求）：含身份文件最新值（同源）", s1.requestPrompt.includes(MARK_A));
check("真内核新会话：APPEND_SYSTEM 安装期种子已被替换（不重复注入）", !s1.requestPrompt.includes(SEED_MARK) && s1.requestPrompt.includes("## 你是谁"));

// ④ 身份文件改一次 → 新会话跟着变（已开 s1 不回溯）
writeIdentity(MARK_B);
const s2 = await newSession();
check("身份文件改后新会话：跟着变（B）", s2.requestPrompt.includes(MARK_B));
check("身份文件改后新会话：不再含 A", !s2.requestPrompt.includes(MARK_A));
check("已开会话 s1 不回溯：仍是 A", s1.requestPrompt.includes(MARK_A) && !s1.requestPrompt.includes(MARK_B));

// ⑤ 文件缺失 → 钩子不注入，基座 APPEND_SYSTEM 种子原样生效
rmSync(identityPath, { force: true });
const s3 = await newSession();
check("身份文件缺失：不注入文件身份、保留种子兜底", !s3.statePrompt.includes(MARK_B) && s3.statePrompt.includes(SEED_MARK));

// ⑥ 差分行为：ELENVA_WEB_HOST=1 → 扩展静默，身份钩子不生效（基座种子原样）
process.env.ELENVA_WEB_HOST = "1";
writeIdentity(MARK_A);
const s4 = await newSession();
check("web 宿主：扩展静默，身份钩子不注入", !s4.statePrompt.includes(MARK_A) && s4.statePrompt.includes(SEED_MARK));
delete process.env.ELENVA_WEB_HOST;

rmSync(root, { recursive: true, force: true });
console.log(`\n${results.every(Boolean) ? "ALL PASS" : "有失败"}`);
process.exit(results.every(Boolean) ? 0 : 1);
