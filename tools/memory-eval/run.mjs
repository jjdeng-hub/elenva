#!/usr/bin/env node
/**
 * 记忆系统评估 —— pi-hermes-memory 的「真实跑一遍」评估夹具。
 *
 * ## 依据（为什么长这样）
 *
 * 《深入理解 AI Agent》ch3 L43「记忆能力的评估：三层次框架」把记忆能力分三层：
 * 基础回忆（L1，单会话直接事实）/ 多会话检索（L2，跨会话检索并推理）/ 主动服务（L3，
 * 综合久远信息做预见性提醒）。ch3 实验 3-1 给了可操作流程：
 * **先用会话生成记忆 → 再在「只能访问记忆、不可回看原始对话」的前提下回答新问题 → LLM-as-a-judge 打分。**
 * 本夹具照此执行，另加一层 **L4 容量压力**：四份记忆文件长期贴顶（实测 99%），
 * 「贴顶时写入 / 整理后关键事实是否还在」是当前最真实的摩擦，不测就看不到。
 *
 * ## 与线上的一致性
 *
 * · 跑的是**真会话**：项目自带的 pi CLI（0.85.1，与网页内核同版本）以 `-p` 一次性模式启动，
 *   加载的扩展/包来自沙箱 settings.json（`npm:pi-hermes-memory`），与网页侧同一套包。
 * · 只换两件事：`PI_CODING_AGENT_DIR` 指向**沙箱**（记忆、会话、配置全在沙箱内），
 *   提问期前删掉 `sessions.db*`（书要求「不可回看原始对话」，同时也防 session_search 兜底）。
 *
 * ## 隔离与安全（硬约束）
 *
 * 1. 沙箱记忆目录**不能**叫 `<agentRoot>/memory` —— 那个名字是扩展的 legacy 根，
 *    会被 `migrateExtensionRoot` 合并进 `<agentRoot>/pi-hermes-memory`（实测踩过）。
 *    这里用 `<sandbox>/store`。
 * 2. 运行前后各取一次真实 `~/.pi/agent/pi-hermes-memory/*.md` 的 mtime+size 快照，
 *    只要变了就判夹具失败（FAIL）——评估绝不允许写进真实记忆。
 * 3. 报告落 `.audit/memory-eval/reports/`（本地数据，不进仓库）。
 *
 * ## 口径（读分数前先读这里）
 *
 * · **生成期**每个会话额外附一句「请把值得长期记住的用户信息写入记忆，然后回复 SAVED」。
 *   这是实验 3-1 的「记忆生成」步骤，测的是**流水线**（写入 → 存储 → 注入 → 检索 → 整理），
 *   不测 agent 主动记录的自发性；换句话：这一版分数偏低只会说明流水线问题，不会冤枉模型。
 * · **提问期**只问一句原话，不加任何「请先检索记忆」的暗示（否则会掩盖「该检索却没检索」的问题）。
 * · **判分**由另一个 LLM（默认同模型）按用例自带 criteria 打 0-10 整数分，只看事实一致性，不看语气格式。
 * · 每条用例的分数受模型随机性影响；同一版本多次跑取平均才有意义（本夹具不做重复采样，保持单次可读）。
 *
 * ## 用法
 *
 *   node .audit/memory-eval/run.mjs                     # 全部用例
 *   node .audit/memory-eval/run.mjs --layer L1          # 只跑某层（L1/L2/L3/L4）
 *   node .audit/memory-eval/run.mjs --case l1-account   # 只跑一条
 *   node .audit/memory-eval/run.mjs --keep              # 保留沙箱（出问题好排查）
 *   node .audit/memory-eval/run.mjs --model X --judge-model Y
 *
 * 退出码：0 = 全部用例跑完；1 = 夹具自身出错（真实记忆被动过 / 沙箱起不来）；
 *        2 = 有用例没跑完（超时/崩溃）——分数本身不设通过线，它是度量不是门禁。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const REAL_AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const REAL_STORE_DIR = path.join(REAL_AGENT_DIR, "pi-hermes-memory");

// ── 参数 ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { layers: null, caseId: null, keep: false, model: null, judgeModel: null, cli: null, repeat: 1, memoryLayer: "layered" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--layer" || arg === "--layers") {
      out.layers = String(next()).split(",").map((s) => s.trim().toUpperCase());
    } else if (arg === "--case") out.caseId = next();
    else if (arg === "--repeat") out.repeat = Math.max(1, Number.parseInt(next(), 10) || 1);
    else if (arg === "--keep") out.keep = true;
    else if (arg === "--memory-layer") out.memoryLayer = String(next()).trim().toLowerCase();
    else if (arg === "--model") out.model = next();
    else if (arg === "--judge-model") out.judgeModel = next();
    else if (arg === "--cli") out.cli = next();
    else if (arg === "--help" || arg === "-h") {
      console.log("用法见文件头注释：node .audit/memory-eval/run.mjs [--layer L1] [--case id] [--keep]");
      process.exit(0);
    } else {
      console.error(`未知参数：${arg}`);
      process.exit(1);
    }
  }
  return out;
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

const log = (...parts) => console.log(...parts);
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function defaultModel() {
  try {
    const settings = readJson(path.join(REAL_AGENT_DIR, "settings.json"));
    const provider = settings.defaultProvider;
    const model = settings.defaultModel;
    if (provider && model) return `${provider}/${model}`;
  } catch {
    /* 落到下面报错 */
  }
  throw new Error("读不到默认模型：~/.pi/agent/settings.json 缺 defaultProvider/defaultModel，请用 --model 指定");
}

function resolveCli(explicit) {
  const candidates = [
    explicit,
    path.join(REPO, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
    path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("找不到 pi CLI（--cli 指定，或确认项目内 @earendil-works/pi-coding-agent 已安装）");
}

/** 真实记忆目录快照：用来断言评估没有污染线上数据。 */
function snapshotRealStore() {
  const snap = {};
  if (!fs.existsSync(REAL_STORE_DIR)) return snap;
  for (const name of fs.readdirSync(REAL_STORE_DIR)) {
    if (!name.endsWith(".md")) continue;
    const stat = fs.statSync(path.join(REAL_STORE_DIR, name));
    snap[name] = `${stat.mtimeMs}:${stat.size}`;
  }
  return snap;
}

function diffSnapshots(before, after) {
  const changed = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[key] !== after[key]) changed.push(`${key} (${before[key] ?? "缺失"} → ${after[key] ?? "缺失"})`);
  }
  return changed;
}

// ── 沙箱 ────────────────────────────────────────────────────────────────────

function createSandbox({ model, layer }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "elenva-memory-eval-"));
  const agentDir = path.join(root, "agent");
  const storeDir = path.join(agentDir, "store"); // 绝不能叫 agentDir/memory（见文件头）
  const workDir = path.join(root, "work");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(storeDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });

  for (const file of ["auth.json", "models-store.json"]) {
    const source = path.join(REAL_AGENT_DIR, file);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(agentDir, file));
  }

  const settings = readJson(path.join(REAL_AGENT_DIR, "settings.json"));
  settings.packages = ["npm:pi-hermes-memory"]; // 评估只装载记忆扩展，去掉无关包（更快更干净）
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(settings, null, 2), "utf8");

  // 双层模式：pi-hermes-memory 只留工具与策略提示词（policy-only），常驻内容交给我们的索引层。
  const layered = layer !== "legacy";
  fs.writeFileSync(
    path.join(agentDir, "hermes-memory-config.json"),
    JSON.stringify(
      {
        memoryMode: layered ? "policy-only" : "legacy-inject",
        memoryPolicyStyle: "full",
        memoryCharLimit: 4000,
        userCharLimit: 2500,
        projectCharLimit: 3000,
        memoryDir: storeDir.split(path.sep).join("/"),
        nudgeInterval: 1,
        nudgeToolCalls: 1,
        reviewEnabled: true,
        correctionDetection: true,
        flushOnShutdown: true,
        flushOnCompact: true,
      },
      null,
      2,
    ),
    "utf8",
  );

  if (layered) installExtensionInto(agentDir);

  return { root, agentDir, storeDir, workDir, model, layered };
}

/** 把仓库里的 elenva-memory 扩展拷进沙箱（与线上同一份源码）。 */
function installExtensionInto(agentDir) {
  const source = path.join(REPO, "extensions", "elenva-memory");
  const target = path.join(agentDir, "extensions", "elenva-memory");
  fs.mkdirSync(target, { recursive: true });
  for (const name of fs.readdirSync(source)) {
    if (name.endsWith(".ts")) fs.copyFileSync(path.join(source, name), path.join(target, name));
  }
}

function resetStore(sandbox) {
  fs.rmSync(sandbox.storeDir, { recursive: true, force: true });
  fs.mkdirSync(sandbox.storeDir, { recursive: true });
  fs.rmSync(path.join(sandbox.agentDir, "projects-memory"), { recursive: true, force: true });
  fs.rmSync(path.join(sandbox.agentDir, "elenva-memory"), { recursive: true, force: true });
}

/** 直接写记忆文件（模拟「已经积累了一堆记忆」的历史状态，不经过模型）。 */
const PAD_TEMPLATES = [
  "备忘 #N：备份盘放在书桌第二格，标签写的是「归档」，别当成空盘格掉。",
  "备忘 #N：打印机墨盒囤了两套，在储物间上层，先拆旧的用。",
  "备忘 #N：常用酒店的会员等级今年保级还差两晚，年底前补上。",
  "备忘 #N：健身房储物柜租到年底，锁是自己带的那把，别换。",
  "备忘 #N：厨房定时器电池型号 LR44，备用电池在抽屉里。",
  "备忘 #N：小区门禁卡补办要去物业前台，工作日到 18 点。",
  "备忘 #N：常去的书店会员积分年底清零，记得先兑换。",
  "备忘 #N：备用路由器收在纸箱里，复位孔要用针顶住 10 秒。",
  "备忘 #N：体检报告纸质版按年份装订，放在书房文件夹里。",
  "备忘 #N：冬季轮胎存放在汽修店，换季前一天预约就行。",
];

function renderEntries(entries, ageDaysDefault) {
  return entries
    .map((item) => {
      const entry = typeof item === "string" ? { text: item } : item;
      const ageDays = Number.isFinite(entry.ageDays) ? entry.ageDays : ageDaysDefault;
      const created = new Date(Date.now() - ageDays * 86400000).toISOString().slice(0, 10);
      return `${entry.text} <!-- created=${created}, last=${created} -->`;
    })
    .join("\n§\n");
}

/** 补到指定字符数（用通用备忘模板循环补，保证真能形成容量压力）。 */
function padEntries(entries, padToChars, ageDaysDefault) {
  const all = [...entries];
  for (let i = 0; padToChars > 0 && renderEntries(all, ageDaysDefault).length < padToChars && i < 400; i += 1) {
    const template = PAD_TEMPLATES[i % PAD_TEMPLATES.length];
    all.push(template.replace("#N", `#${i + 100}`));
  }
  return all;
}

/**
 * 把一份记忆文件写到贴顶（模拟长期使用后的满仓状态，不经模型）。
 * 条目可以是字符串，也可以是 { text, ageDays } —— 单独控制某条的老化天数，
 * 用来把「陈旧条目」精确地放在它会被整理盯上的位置。
 */
function prefillFile(file, spec, ageDaysDefault) {
  const entries = padEntries(spec.entries ?? [], Number.isFinite(spec.padToChars) ? spec.padToChars : 0, ageDaysDefault);
  const body = renderEntries(entries, ageDaysDefault);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
  return { chars: body.length, entries: entries.length };
}

/**
 * 预填记忆。支持两种写法：
 *   setup.prefill = ["条目", ...]                      → 只填 MEMORY.md
 *   setup.prefill = { memory: {entries,padToChars}, user: {...}, project: {...} }
 * 三份都填才有真实压力 —— 只填 MEMORY.md 时 agent 会把新事实写进空着的 USER.md，压力根本不会触发（实测踩过）。
 */
function prefillStore(sandbox, prefill, options = {}) {
  const ageDays = Number.isFinite(options.ageDays) ? options.ageDays : 0;
  const asSpec = (value) => (Array.isArray(value) ? { entries: value, padToChars: options.padToChars } : value ?? {});
  const specs = Array.isArray(prefill)
    ? { memory: { entries: prefill, padToChars: options.padToChars } }
    : prefill;
  const targets = {
    memory: path.join(sandbox.storeDir, "MEMORY.md"),
    user: path.join(sandbox.storeDir, "USER.md"),
    project: path.join(sandbox.agentDir, "projects-memory", path.basename(sandbox.workDir), "MEMORY.md"),
  };
  const filled = {};
  for (const key of ["memory", "user", "project"]) {
    const spec = specs[key];
    if (!spec) continue;
    filled[key] = prefillFile(targets[key], asSpec(spec), ageDays);
  }
  return filled;
}

/** 清掉会话索引：书要求「只能访问记忆、不可回看原始对话」。 */
function wipeSessionIndex(sandbox) {
  for (const name of fs.readdirSync(sandbox.storeDir)) {
    if (name.startsWith("sessions.db")) fs.rmSync(path.join(sandbox.storeDir, name), { force: true });
  }
}

/** 把三份记忆文件拼起来，用来核对关键事实是否真的落盘（确定性指标，不靠模型）。 */
function readStoreText(sandbox) {
  const files = [
    path.join(sandbox.storeDir, "MEMORY.md"),
    path.join(sandbox.storeDir, "USER.md"),
    path.join(sandbox.storeDir, "failures.md"),
    path.join(sandbox.agentDir, "projects-memory", path.basename(sandbox.workDir), "MEMORY.md"),
  ];
  return files
    .filter((file) => fs.existsSync(file))
    .map((file) => `<!-- ${path.basename(path.dirname(file))}/${path.basename(file)} -->\n${fs.readFileSync(file, "utf8")}`)
    .join("\n");
}

/**
 * 常驻注入成本：双层模式 = 索引层实际注入的字符数（扩展写的 index-log）；
 * legacy 模式 = 三份 md 的总长（近似值，legacy 下全文就是常驻内容）。
 */
function residentChars(sandbox) {
  if (sandbox.layered) {
    try {
      const logFile = path.join(sandbox.agentDir, "elenva-memory", "index-log.jsonl");
      const lines = fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean);
      const last = JSON.parse(lines[lines.length - 1]);
      if (Number.isFinite(last?.chars)) return { chars: last.chars, metric: "index-log" };
    } catch {
      /* 落到下面的 null */
    }
    return { chars: null, metric: "index-log（缺失：扩展可能没加载）" };
  }
  const md = storeUsage(sandbox);
  return { chars: Object.values(md).reduce((sum, n) => sum + n, 0), metric: "md-sum" };
}

function storeUsage(sandbox) {
  const out = {};
  const projectFile = path.join(sandbox.agentDir, "projects-memory", path.basename(sandbox.workDir), "MEMORY.md");
  for (const name of fs.readdirSync(sandbox.storeDir)) {
    if (name.endsWith(".md")) out[name] = fs.readFileSync(path.join(sandbox.storeDir, name), "utf8").length;
  }
  if (fs.existsSync(projectFile)) out["projects-memory/MEMORY.md"] = fs.readFileSync(projectFile, "utf8").length;
  return out;
}

// ── 跑 pi ───────────────────────────────────────────────────────────────────

function runPi({ cli, agentDir, workDir, model, prompt, timeoutMs, extraArgs = [], thinking }) {
  const args = [
    cli,
    "-p",
    "--no-session",
    ...(model ? ["--model", model] : []),
    ...(thinking ? ["--thinking", thinking] : []),
    ...extraArgs,
    prompt,
  ];
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, args, {
      cwd: workDir,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_CODING_AGENT_SESSION_DIR: path.join(agentDir, "sessions"),
      },
      windowsHide: true,
      // stdin 必须关掉：`pi -p` 在 stdin 非 TTY 时会去读它，管道不关就永远等下去（实测挂到超时）。
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim(), ms: Date.now() - started, timedOut });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${String(error)}`, ms: Date.now() - started, timedOut });
    });
  });
}

/** 从 judge 输出里抠出最后一个 JSON 对象（模型爱加客套话）。 */
function extractJson(text) {
  const matches = text.match(/\{[\s\S]*\}/g);
  if (!matches) return null;
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(matches[i]);
    } catch {
      /* 继续往前找 */
    }
  }
  return null;
}

const SAVE_HINT = "（会话到这里结束。请把这次会话里值得长期记住的用户信息写入记忆，然后回复 SAVED。）";

async function judgeAnswer({ cli, agentDir, workDir, model, question, reference, criteria, answer, timeoutMs }) {
  const prompt = [
    "你是严格的评估员，只按事实一致性打分，不看语气、格式、长度。",
    "输出必须是严格 JSON：{\"score\": <0-10 整数>, \"reason\": \"<一句话，说明为什么不是满分或为什么满分>\"}",
    "评分档：完全正确且要点齐全 = 9-10；正确但有缺失/含糊 = 5-8；错误、矛盾、答非所问、没答出来 = 0-4。",
    "",
    `【问题】${question}`,
    `【参考答案 / 判分要点】${reference}`,
    `【补充评分细则】${criteria}`,
    `【候选回答】${answer || "(空)"}`,
  ].join("\n");
  const result = await runPi({
    cli,
    agentDir,
    workDir,
    model,
    prompt,
    timeoutMs,
    extraArgs: ["--no-extensions"],
    thinking: "off",
  });
  const parsed = extractJson(result.stdout);
  return {
    score: parsed && Number.isFinite(parsed.score) ? Math.max(0, Math.min(10, Math.round(parsed.score))) : null,
    reason: parsed?.reason ?? null,
    raw: result.stdout.slice(0, 500),
    ms: result.ms,
    failed: result.code !== 0 || !parsed,
  };
}

// ── 单条用例 ────────────────────────────────────────────────────────────────

async function runCase({ testCase, sandbox, cli, model, judgeModel, defaults }) {
  const sessionTimeoutMs = defaults.sessionTimeoutMs ?? 420000;
  const judgeTimeoutMs = defaults.judgeTimeoutMs ?? 180000;
  const thinking = defaults.thinking ?? "off";
  const record = { id: testCase.id, baseId: testCase.baseId ?? testCase.id, layer: testCase.layer, title: testCase.title, steps: [], problems: [] };

  resetStore(sandbox);

  if (testCase.setup?.prefill) {
    const filled = prefillStore(sandbox, testCase.setup.prefill, {
      ageDays: testCase.setup.prefillAgeDays,
      padToChars: testCase.setup.padToChars,
    });
    record.steps.push({ step: "prefill", filled });
    log(`   · 预填 ${Object.entries(filled).map(([k, v]) => `${k} ${v.entries}条/${v.chars}字`).join("、")}`);
  }

  // 生成期：每个会话一次 `-p`，会话之间只有「记忆」这条通道。
  for (const [index, session] of testCase.sessions.entries()) {
    const prompt = [...session.turns, SAVE_HINT].join("\n\n");
    const result = await runPi({
      cli,
      agentDir: sandbox.agentDir,
      workDir: sandbox.workDir,
      model,
      prompt,
      timeoutMs: sessionTimeoutMs,
      thinking,
    });
    record.steps.push({
      step: `session-${index + 1}`,
      ms: result.ms,
      code: result.code,
      timedOut: result.timedOut,
      reply: result.stdout.slice(0, 200),
    });
    if (result.code !== 0 || result.timedOut) {
      record.problems.push(`session-${index + 1} 未正常结束（code=${result.code} timeout=${result.timedOut}）：${result.stderr.slice(0, 300)}`);
    }
    log(`   · 会话 ${index + 1} 完成（${(result.ms / 1000).toFixed(0)}s, code=${result.code}）`);
  }

  record.storeAfterGeneration = storeUsage(sandbox);

  // 确定性指标：关键事实有没有真的落盘（与判分解耦 —— 容量/写入类改动靠它说话）。
  if (testCase.expectedInStore) {
    const text = readStoreText(sandbox);
    const needle = String(testCase.expectedInStore);
    const found = text.includes(needle);
    record.persisted = found;
    record.persistedDetail = found
      ? { needle, where: text.split("\n").filter((line) => line.includes(needle)).map((line) => line.slice(0, 140)) }
      : { needle };
    log(`   · 落盘检查「${needle}」：${found ? "✓ 已在记忆文件里" : "✗ 没有落盘"}`);
  }
  wipeSessionIndex(sandbox);

  // 提问期：干净会话 + 只剩记忆。
  const questions = testCase.questions ?? [
    { question: testCase.question, reference: testCase.reference, criteria: testCase.criteria },
  ];
  record.questions = [];
  for (const [index, item] of questions.entries()) {
    const question = await runPi({
      cli,
      agentDir: sandbox.agentDir,
      workDir: sandbox.workDir,
      model,
      prompt: item.question,
      timeoutMs: sessionTimeoutMs,
      thinking,
    });
    record.steps.push({ step: `question-${index + 1}`, ms: question.ms, code: question.code, timedOut: question.timedOut });
    const answer = question.stdout.slice(0, 1500);
    if (question.code !== 0 || question.timedOut) {
      record.problems.push(`提问 ${index + 1} 未正常结束（code=${question.code} timeout=${question.timedOut}）：${question.stderr.slice(0, 300)}`);
    }
    log(`   · 提问 ${index + 1}（${(question.ms / 1000).toFixed(0)}s）→ ${answer.replace(/\s+/g, " ").slice(0, 80)}`);

    const judged = await judgeAnswer({
      cli,
      agentDir: sandbox.agentDir,
      workDir: sandbox.workDir,
      model: judgeModel,
      question: item.question,
      reference: item.reference,
      criteria: item.criteria,
      answer,
      timeoutMs: judgeTimeoutMs,
    });
    if (judged.failed) record.problems.push(`判分失败（提问 ${index + 1}）：${judged.raw.slice(0, 200)}`);
    record.questions.push({ question: item.question, answer, score: judged.score, judgeReason: judged.reason });
    log(`     ⇒ ${judged.score ?? "?"}/10${judged.reason ? ` —— ${judged.reason}` : ""}`);
  }

  const scores = record.questions.map((q) => q.score).filter((s) => typeof s === "number");
  record.score = scores.length > 0 ? scores.reduce((sum, s) => sum + s, 0) / scores.length : null;
  record.storeAfterQuestion = storeUsage(sandbox);
  // 常驻注入成本：每轮系统提示词里要背的记忆字符数。
  // 双层模式 = 索引层注入的字符（扩展写 index-log）；legacy 模式 = 三份 md 总长。
  const resident = residentChars(sandbox);
  record.residentChars = resident.chars;
  record.residentMetric = resident.metric;
  return record;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const caseFile = path.join(HERE, "cases.json");
  const caseSet = readJson(caseFile);
  const defaults = caseSet.defaults ?? {};
  const model = args.model ?? caseSet.model ?? defaultModel();
  const judgeModel = args.judgeModel ?? caseSet.judgeModel ?? model;
  const cli = resolveCli(args.cli);

  let cases = caseSet.cases;
  if (args.layers) cases = cases.filter((c) => args.layers.includes(String(c.layer).toUpperCase()));
  if (args.caseId) cases = cases.filter((c) => c.id === args.caseId);
  if (cases.length === 0) {
    console.error("没有匹配的用例（检查 --layer / --case）");
    process.exit(1);
  }
  if (args.repeat > 1) {
    // 重复采样：贴顶/整理这类行为本身带随机性，单次分数说明不了问题，看成功率才有意义。
    const expanded = [];
    for (const testCase of cases) {
      for (let i = 0; i < args.repeat; i += 1) {
        expanded.push({ ...testCase, baseId: testCase.id, id: `${testCase.id}#${i + 1}` });
      }
    }
    cases = expanded;
  }

  const before = snapshotRealStore();
  const sandbox = createSandbox({ model, layer: args.memoryLayer });
  log(`记忆评估：${cases.length} 条用例｜模型 ${model}｜judge ${judgeModel}｜记忆层 ${sandbox.layered ? "双层（索引 + 检索）" : "legacy 全文注入"}`);
  log(`沙箱：${sandbox.root}`);
  log(`CLI：${cli}`);

  // 预热：第一次 `pi -p` 会在沙箱内装扩展（约十几秒），先跑掉，别算进用例耗时。
  const warmup = await runPi({
    cli,
    agentDir: sandbox.agentDir,
    workDir: sandbox.workDir,
    model,
    prompt: "回复：WARMUP",
    timeoutMs: 300000,
    thinking: "off",
  });
  if (warmup.code !== 0) {
    console.error(`预热失败（code=${warmup.code} timeout=${warmup.timedOut}）：stdout=${warmup.stdout.slice(0, 300)} / stderr=${warmup.stderr.slice(0, 500)}`);
    process.exit(1);
  }
  log(`预热完成（${(warmup.ms / 1000).toFixed(0)}s）\n`);

  const records = [];
  for (const testCase of cases) {
    log(`▶ ${testCase.id} [${testCase.layer}] ${testCase.title}`);
    const record = await runCase({ testCase, sandbox, cli, model, judgeModel, defaults });
    records.push(record);
    log(`   ⇒ 得分 ${record.score ?? "?"}/10${record.judgeReason ? ` —— ${record.judgeReason}` : ""}\n`);
  }

  const after = snapshotRealStore();
  const touched = diffSnapshots(before, after);
  if (touched.length > 0) {
    console.error(`❌ 真实记忆被改动（夹具必须零污染）：${touched.join("; ")}`);
  }

  const byLayer = {};
  for (const record of records) {
    const bucket = (byLayer[record.layer] ??= { count: 0, sum: 0, scored: 0 });
    bucket.count += 1;
    if (typeof record.score === "number") {
      bucket.sum += record.score;
      bucket.scored += 1;
    }
  }
  const scored = records.filter((r) => typeof r.score === "number");
  const avg = scored.length > 0 ? scored.reduce((sum, r) => sum + r.score, 0) / scored.length : null;

  log("──── 汇总 ────");
  for (const [layer, bucket] of Object.entries(byLayer).sort()) {
    const layerAvg = bucket.scored > 0 ? (bucket.sum / bucket.scored).toFixed(1) : "?";
    log(`  ${layer}: ${bucket.scored}/${bucket.count} 条有分，均分 ${layerAvg}`);
  }
  log(`  总体：${scored.length}/${records.length} 条有分，均分 ${avg === null ? "?" : avg.toFixed(1)}/10`);
  const resident = records.map((r) => r.residentChars).filter((n) => typeof n === "number");
  if (resident.length > 0) {
    const mean = resident.reduce((sum, n) => sum + n, 0) / resident.length;
    log(`  常驻注入成本（每轮注入上下文的记忆字符数）：均 ${Math.round(mean)}，最大 ${Math.max(...resident)}`);
  }
  if (args.repeat > 1) {
    const groups = new Map();
    for (const record of records) {
      const list = groups.get(record.baseId) ?? [];
      list.push(record.score);
      groups.set(record.baseId, list);
    }
    log(`  重复 ${args.repeat} 次（成功率 = 满分样例占比）：`);
    for (const [id, scores] of groups) {
      const full = scores.filter((s) => s === 10).length;
      const list = scores.map((s) => (s === null ? "?" : s)).join("/");
      log(`    ${id}: ${full}/${scores.length} 次满分（${list}）`);
    }
  }

  const reportsDir = path.join(HERE, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  const report = {
    ts: new Date().toISOString(),
    model,
    judgeModel,
    cli,
    memoryLayer: sandbox.layered ? "layered" : "legacy",
    sandbox: sandbox.root,
    realStoreTouched: touched,
    summary: { total: records.length, scored: scored.length, avg, byLayer },
    cases: records,
  };
  const reportPath = path.join(reportsDir, `report-${stamp()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  fs.writeFileSync(path.join(reportsDir, "latest.json"), JSON.stringify(report, null, 2), "utf8");
  log(`报告：${path.relative(REPO, reportPath)}`);

  if (args.keep) log(`沙箱保留：${sandbox.root}`);
  else fs.rmSync(sandbox.root, { recursive: true, force: true });

  if (touched.length > 0) process.exit(1);
  const unfinished = records.filter((r) => r.problems.length > 0);
  if (unfinished.length > 0) {
    log(`⚠️ 有 ${unfinished.length} 条用例未正常跑完：${unfinished.map((r) => r.id).join(", ")}`);
    process.exit(2);
  }
  log("MEMORY-EVAL: DONE");
}

await main();
