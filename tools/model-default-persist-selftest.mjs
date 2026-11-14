// 启动默认模型「被粘」修复轮的回归夹具（模块 6 过审修复 · 2026-10-19）。
//
// 覆盖：A 复核 / 节律两条自动路径不再写全局默认（手选照写，正向锚）；B 写前备份 /
//      坏默认拦截 / provider 准入收紧 / 重置入口；C 健康度接进选型（接线静态核对）；
//      D 预算去重按会话 id 保留 + 组头数字表述。
//
// 关键设计：A 的两条自动路径**用真实调用方**验证，不是只看常量——
//   - 复核：直接 import `app/api/model-reviews/route.ts` 并调它的 POST handler；
//   - 节律：直接调 `lib/scheduler.ts` 的 runScheduleTaskNow（**不**注入假 launcher，
//     让真实的 session-launch 跑起来）。
// 两者都在隔离 agentDir + 本地 mock provider 上起真会话，再读 settings.json 里的默认。
// 回退实现（去掉路由/节律里的 `persistStartupPreferences: false`）→ 这两条变红。
//
// 隔离：PI_CODING_AGENT_DIR 指向 mkdtemp 出来的临时目录，全部**虚构**数据；
// 不碰真实 ~/.pi/agent、不占端口（mock 用 0 号端口）。
// 运行：node tools/model-default-persist-selftest.mjs
import http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const repoRoot = new URL("../", import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), "elenva-model-default-selftest-"));
const agentDir = join(root, "agent");
const settingsPath = join(agentDir, "settings.json");
const backupDir = join(agentDir, "backups", "settings");
const sessionsRoot = join(agentDir, "sessions");
mkdirSync(sessionsRoot, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

/* ---------- 本地 mock provider（openai-completions SSE） ---------- */
const seen = [];
const server = http.createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(404).end();
    return;
  }
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    try {
      seen.push(JSON.parse(raw));
    } catch {
      seen.push({ _raw: raw });
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const chunk = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    chunk({
      id: "mock",
      object: "chat.completion.chunk",
      created: 0,
      model: "mock",
      choices: [{ index: 0, delta: { role: "assistant", content: "就绪" }, finish_reason: null }],
    });
    chunk({
      id: "mock",
      object: "chat.completion.chunk",
      created: 0,
      model: "mock",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

writeFileSync(
  join(agentDir, "models.json"),
  JSON.stringify(
    {
      providers: {
        mock: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: "openai-completions",
          apiKey: "mock",
          models: [
            { id: "mock-orig", contextWindow: 100000, maxTokens: 4096 },
            { id: "mock-note", contextWindow: 100000, maxTokens: 4096 },
          ],
        },
      },
    },
    null,
    2,
  ),
);

function writeSettings(extra = {}) {
  writeFileSync(
    settingsPath,
    JSON.stringify(
      { defaultProvider: "mock", defaultModel: "mock-orig", enabledModels: ["mock/*"], ...extra },
      null,
      2,
    ),
  );
}
writeSettings();

function readSettings() {
  return JSON.parse(readFileSync(settingsPath, "utf8"));
}
function readDefault() {
  const data = readSettings();
  return data.defaultProvider && data.defaultModel ? `${data.defaultProvider}/${data.defaultModel}` : "(无)";
}

/* ---------- 加载被测模块（jiti 直载 .ts；脚本放仓库内才 resolve 到 jiti） ---------- */
const jiti = createJiti(import.meta.url, { alias: { "@": repoRoot } });
const { startNewAgentSession } = await jiti.import("../lib/session-launch.ts");
const schedules = await jiti.import("../lib/schedules.ts");
const scheduler = await jiti.import("../lib/scheduler.ts");
const piSettings = await jiti.import("../lib/pi-user-settings.ts");
const settingsBackup = await jiti.import("../lib/settings-backup.ts");
const modelHealth = await jiti.import("../lib/model-health.ts");
const agentRuntime = await jiti.import("../lib/agent-runtime.ts");
const piSettingsRoute = await jiti.import("../app/api/pi-settings/route.ts");
const modelReviewsRoute = await jiti.import("../app/api/model-reviews/route.ts");

let fail = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
};
const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};
const eq = (actual, expected, message) => {
  if (actual !== expected) throw new Error(`${message}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
};
const throws = (fn, pattern, message) => {
  try {
    fn();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (pattern && !pattern.test(text)) throw new Error(`${message}：抛错文案不符（${text}）`);
    return;
  }
  throw new Error(`${message}：应当抛错但没抛`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 起一条真实会话并等它建好（复核 / 节律之外的第三种：用户手选）。 */
async function startHandPickedSession(modelId) {
  const { session } = await startNewAgentSession(root, {
    initialModel: { provider: "mock", modelId },
  });
  return session;
}

/* ================= A. 三条路径 ================= */

// A-anchor（正向锚）：新建会话里用户手选 → 默认**要**变（防回归：别把三条路径一起关掉）
await check("A 正向锚：新建会话手选模型 → 全局默认随之改变", async () => {
  writeSettings();
  const before = readDefault();
  eq(before, "mock/mock-orig", "前置默认");
  await startHandPickedSession("mock-note");
  eq(readDefault(), "mock/mock-note", "手选后默认");
});

// A-复核：真实 `app/api/model-reviews/route.ts` 的 POST
await check("A 复核路径：换模型复核起会话 → 全局默认不变", async () => {
  writeSettings();
  const parentId = "selftest-parent-review";
  const parentDir = join(sessionsRoot, "fake-project");
  mkdirSync(parentDir, { recursive: true });
  const parentFile = join(parentDir, `1729000000000_${parentId}.jsonl`);
  writeFileSync(
    parentFile,
    [
      { type: "session", id: parentId, cwd: root, timestamp: new Date().toISOString() },
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: [{ type: "text", text: "原任务（虚构）：只回复就绪" }] },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n",
  );

  const response = await modelReviewsRoute.POST(
    new Request("http://127.0.0.1/api/model-reviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentSessionId: parentId, provider: "mock", modelId: "mock-note" }),
    }),
  );
  assert(response.status === 200, `复核路由应 200，实际 ${response.status}`);
  const payload = await response.json();
  eq(payload.review?.model?.modelId, "mock-note", "复核用的模型（会话确实带上了 requested model）");
  eq(readDefault(), "mock/mock-orig", "复核后默认");
});

// A-节律：真实 `lib/scheduler.ts` 的 runScheduleTaskNow（不注入假 launcher）
await check("A 节律路径：任务带 model 起会话 → 全局默认不变", async () => {
  writeSettings();
  const task = schedules.createScheduleTask({
    name: "selftest-rhythm-model",
    cwd: root,
    prompt: "只回复：就绪",
    schedule: { kind: "daily", at: "03:00" },
    safety: "standard",
    model: { provider: "mock", modelId: "mock-note" },
  });
  const result = await scheduler.runScheduleTaskNow(task.id);
  assert(result.started === true, `节律应启动，实际 ${JSON.stringify(result)}`);
  for (let i = 0; i < 80 && scheduler.isScheduleTaskRunning(task.id); i += 1) await sleep(250);
  await sleep(500);
  eq(readDefault(), "mock/mock-orig", "节律后默认");
});

/* ================= B. 护栏与还原入口 ================= */

await check("B1 写前备份：改默认前落地一份带时间的副本（内容是写前状态）", async () => {
  rmSync(backupDir, { recursive: true, force: true });
  writeSettings();
  piSettings.writeManagedSettings({ defaultProvider: "mock", defaultModel: "mock-note" }, settingsPath);
  const files = readdirSync(backupDir).filter((name) => name.endsWith(".json"));
  eq(files.length, 1, "备份份数");
  assert(/^\d{8}-\d{6}\d{3}-default\.json$/.test(files[0]), `备份命名应带时间：${files[0]}`);
  eq(JSON.parse(readFileSync(join(backupDir, files[0]), "utf8")).defaultModel, "mock-orig", "备份内容 = 写前");
  eq(readSettings().defaultModel, "mock-note", "settings.json 已写入新默认");
});

await check("B1b 备份容量有界：超出上限按时间丢最旧", async () => {
  rmSync(backupDir, { recursive: true, force: true });
  for (let i = 0; i < 25; i += 1) {
    writeSettings();
    piSettings.writeManagedSettings({ defaultModel: `mock-${i}` }, settingsPath);
  }
  const files = readdirSync(backupDir).filter((name) => name.endsWith(".json"));
  assert(
    files.length <= settingsBackup.SETTINGS_BACKUP_KEEP,
    `备份数应 ≤ ${settingsBackup.SETTINGS_BACKUP_KEEP}，实际 ${files.length}`,
  );
  assert(files.length > 0, "至少留一份");
});

await check("B1c 不写默认的设置变更不留备份（备份只针对启动默认）", async () => {
  rmSync(backupDir, { recursive: true, force: true });
  writeSettings();
  piSettings.writeManagedSettings({ steeringMode: "all" }, settingsPath);
  const count = existsSync(backupDir) ? readdirSync(backupDir).filter((n) => n.endsWith(".json")).length : 0;
  eq(count, 0, "备份份数");
});

await check("B2 形状与准入：拒绝不在已配置 provider 列表里的值，其余校验不放松", () => {
  const known = new Set(["mock", "deepseek"]);
  throws(
    () => piSettings.validateManagedPatch({ defaultProvider: "no-such-provider", defaultModel: "x" }, { knownProviders: known }),
    /不在已配置/,
    "未知 provider 应被拒",
  );
  eq(
    piSettings.validateManagedPatch({ defaultProvider: "mock", defaultModel: "mock-note" }, { knownProviders: known }).defaultProvider,
    "mock",
    "已配置 provider 照收",
  );
  // 不放松既有形状校验
  throws(() => piSettings.validateManagedPatch({ defaultProvider: "a/b" }), /不含空白/, "带分隔符应拒");
  throws(() => piSettings.validateManagedPatch({ defaultProvider: "has space" }), /不含空白/, "带空白应拒");
  throws(() => piSettings.validateManagedPatch({ defaultProvider: "" }), /不含空白/, "空串应拒");
  throws(() => piSettings.validateManagedPatch({ defaultProvider: "x".repeat(201) }), /不含空白/, "超长应拒");
  // null 仍可删键（重置入口依赖它）
  eq(piSettings.validateManagedPatch({ defaultProvider: null }).defaultProvider, undefined, "null = 删键");
});

function writeHealthFixture() {
  // 5 次调用 / 3 次失败 → successRate 0.4 + 近期失败 → failing（口径见 lib/model-health.ts）
  const dir = join(sessionsRoot, "health-project");
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const lines = [];
  for (let i = 0; i < 5; i += 1) {
    const failed = i < 3;
    lines.push(
      JSON.stringify({
        type: "message",
        id: `h${i}`,
        parentId: null,
        timestamp: new Date(now - i * 60000).toISOString(),
        message: {
          role: "assistant",
          content: failed ? [] : [{ type: "text", text: "虚构回复" }],
          provider: "mock",
          model: "mock-bad",
          stopReason: failed ? "error" : "stop",
          ...(failed ? { errorMessage: "虚构错误：402 额度不足" } : {}),
        },
      }),
    );
  }
  writeFileSync(join(dir, `1730000000000_health.jsonl`), lines.join("\n") + "\n");
  modelHealth.resetModelHealthCacheForTest();
}

function settingsRequest(body) {
  return new Request("http://127.0.0.1/api/pi-settings", {
    method: "PUT",
    headers: { "content-type": "application/json", host: "127.0.0.1" },
    body: JSON.stringify(body),
  });
}

await check("B3 坏默认拦截：failing 模型 409（不静默接受），带确认后放行", async () => {
  writeHealthFixture();
  const report = modelHealth.aggregateModelHealth();
  const bad = report.models.find((entry) => entry.model === "mock-bad");
  assert(bad && bad.status === "failing", `前置：mock-bad 应为 failing，实际 ${bad?.status}`);

  writeSettings();
  const rejected = await piSettingsRoute.PUT(settingsRequest({ defaultProvider: "mock", defaultModel: "mock-bad" }));
  eq(rejected.status, 409, "未确认时应 409");
  const payload = await rejected.json();
  eq(payload.code, "unhealthy_model", "错误码");
  assert(/成功率/.test(payload.error), `错误文案应带健康数据：${payload.error}`);
  eq(readDefault(), "mock/mock-orig", "被拒时不得写入");

  const confirmed = await piSettingsRoute.PUT(
    settingsRequest({ defaultProvider: "mock", defaultModel: "mock-bad", confirmUnhealthy: true }),
  );
  eq(confirmed.status, 200, "确认后应放行");
  eq(readDefault(), "mock/mock-bad", "确认后写入");
});

await check("B4 重置为自动选择：null 删键（服务端链路）", async () => {
  writeSettings({ defaultThinkingLevel: "high" });
  const response = await piSettingsRoute.PUT(
    settingsRequest({ defaultProvider: null, defaultModel: null, defaultThinkingLevel: null }),
  );
  eq(response.status, 200, "重置应 200");
  const data = readSettings();
  assert(!("defaultProvider" in data) && !("defaultModel" in data) && !("defaultThinkingLevel" in data), "三个键都应删除");
  eq(data.enabledModels.join(","), "mock/*", "其余键保留");
});

await check("B4b 设置页有「重置为自动选择」入口（接线核对）", () => {
  const source = readFileSync(join(repoRoot, "components/SettingsPage.tsx"), "utf8");
  assert(source.includes('data-testid="reset-startup-default"'), "缺少入口按钮");
  assert(/defaultProvider: null, defaultModel: null, defaultThinkingLevel: null/.test(source), "入口未传 null 删键");
});

/* ================= C. 健康度接进选型 ================= */

await check("C 选型侧接健康度：Picker / 模型库标记 failing，健康面板处理 409 确认", () => {
  const hook = readFileSync(join(repoRoot, "hooks/useModelHealth.ts"), "utf8");
  assert(hook.includes("/api/model-health"), "健康度必须复用既有数据源 /api/model-health");

  const picker = readFileSync(join(repoRoot, "components/ModelPicker.tsx"), "utf8");
  assert(picker.includes("useModelHealth"), "ModelPicker 未接健康度");
  assert(picker.includes("有故障"), "ModelPicker 未标出 failing");
  assert(/confirmUnhealthy/.test(picker), "ModelPicker 的「设为启动默认」未做确认");

  const scope = readFileSync(join(repoRoot, "components/ModelScopeEditor.tsx"), "utf8");
  assert(scope.includes("useModelHealth"), "ModelScopeEditor 未接健康度");
  assert(scope.includes("有故障"), "ModelScopeEditor 未标出 failing");

  const page = readFileSync(join(repoRoot, "components/ModelsPage.tsx"), "utf8");
  assert(page.includes("unhealthy_model"), "健康面板未处理 409 确认");
});

/* ================= D. 两个小修 ================= */

await check("D1 预算去重键按会话 id 保留（跨 wrapper 回收）+ 有界", () => {
  agentRuntime.__resetBudgetNotifiedKeysForTest();
  const first = agentRuntime.__budgetNotifiedKeysForTest("sess-origin");
  first.add("daily:over");
  const second = agentRuntime.__budgetNotifiedKeysForTest("sess-origin");
  assert(second === first, "同一会话应拿到同一份去重集合（回收重建后仍在）");
  assert(second.has("daily:over"), "已推档位应保留");
  for (let i = 0; i < 250; i += 1) agentRuntime.__budgetNotifiedKeysForTest(`sess-${i}`);
  assert(
    agentRuntime.__budgetNotifiedKeysSizeForTest() <= 200,
    `去重表应有界，实际 ${agentRuntime.__budgetNotifiedKeysSizeForTest()}`,
  );
});

await check("D2 组头数字表述：模型库「N/M 可选」 vs 厂商卡「内置 N 模型」", () => {
  const scope = readFileSync(join(repoRoot, "components/ModelScopeEditor.tsx"), "utf8");
  assert(/list\.length\} 可选/.test(scope), "模型库组头未标「可选」");
  const page = readFileSync(join(repoRoot, "components/ModelsPage.tsx"), "utf8");
  assert(/内置 \{p\.modelCount\} 模型/.test(page), "厂商卡未标「内置」");
});

/* ---------- 收尾 ---------- */
server.close();
rmSync(root, { recursive: true, force: true });
console.log(fail === 0 ? "\n全部通过" : `\n失败 ${fail} 条`);
process.exit(fail === 0 ? 0 : 1);
