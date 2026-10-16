// 「换模型复核」（模块 6 · 第 1 轮）的自检：
// 纯函数层（截断 / 标题 / 提示词 / 首条任务抽取 / 解析容错 / 合并去重 / 双向查询）
// + 磁盘层（读写往返 / 0600 / 损坏容错 / 200 FIFO / 状态流转）
// + 路由层（非法值 400 / 不存在会话 404 / 无可复核文本 400 / GET 双向查询）
// + 调用点静态核对（复核独立语义 / 观测栏入口 / 并排打开 / .gitignore 白名单）。
// 运行：node tools/model-review-selftest.mjs
//
// 隔离：PI_CODING_AGENT_DIR 指向 mkdtemp 出来的临时目录，全用**虚构**数据，
// 不碰真实 ~/.pi/agent。lib/*.ts 是纯 TS（无 JSX），jiti 可直载（见记忆 F1/F3）。
import { createJiti } from "jiti";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "elenva-model-review-selftest-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const lib = await jiti.import("../lib/model-review.ts");
const {
  MAX_MODEL_REVIEWS,
  truncateTaskPreview,
  buildReviewTitle,
  buildReviewPrompt,
  extractFirstUserTask,
  parseModelReviews,
  upsertModelReview,
  patchModelReview,
  findReviewRelations,
  readModelReviews,
  writeModelReviews,
  createModelReview,
  updateModelReview,
  getModelReviewsPath,
} = lib;

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
const checkAsync = async (name, fn) => {
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
const eq = (actual, expected, message) =>
  assert(
    actual === expected,
    `${message}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`,
  );
const deepEq = (actual, expected, message) =>
  eq(JSON.stringify(actual), JSON.stringify(expected), message);

const fixture = (overrides = {}) => ({
  id: "r-1",
  parentSessionId: "p-1",
  model: { provider: "demo-provider", modelId: "demo-model" },
  taskPreview: "修一个虚构的 bug",
  status: "running",
  createdAt: "2026-10-16T00:00:00.000Z",
  ...overrides,
});

/* ---------------- 1. 纯函数：任务文本与标题 ---------------- */

check("truncateTaskPreview：折叠空白 + 按上限截断 + 空文本", () => {
  eq(truncateTaskPreview("  a \n\n b\tc  "), "a b c", "空白折叠并去首尾");
  eq(truncateTaskPreview(""), "", "空文本 → 空串");
  eq(truncateTaskPreview("   "), "", "纯空白 → 空串");
  const long = "字".repeat(500);
  const cut = truncateTaskPreview(long, 10);
  eq(cut.length, 10, "截断到上限（含省略号）");
  assert(cut.endsWith("…"), "截断应以省略号收尾");
  eq(truncateTaskPreview("短", 10), "短", "不超上限原样保留");
});

check("buildReviewTitle：复核 · 模型 · 任务截断", () => {
  const title = buildReviewTitle({ provider: "p", modelId: "gpt-demo" }, "把登录改成 OAuth");
  eq(title, "复核 · gpt-demo · 把登录改成 OAuth", "标题格式");
  eq(buildReviewTitle({ provider: "p", modelId: "m" }, ""), "复核 · m", "无任务文本时省略尾段");
});

check("buildReviewPrompt：只带原任务原文 + 一行独立复核声明", () => {
  const prompt = buildReviewPrompt("请修复 A 与 B");
  eq(prompt, "请修复 A 与 B\n\n（独立复核对照：请按同一任务从零执行）", "提示词正文");
  assert(prompt.includes("从零执行"), "应声明从零执行");
});

/* ---------------- 2. 纯函数：首条用户任务抽取 ---------------- */

check("extractFirstUserTask：字符串内容 / 块数组 / 跳过非 user 与空文本", () => {
  eq(extractFirstUserTask([{ type: "message", message: { role: "user", content: "任务 A" } }]), "任务 A", "字符串内容");
  eq(
    extractFirstUserTask([
      { type: "message", message: { role: "assistant", content: "先说话" } },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "块任务" }] } },
    ]),
    "块任务",
    "跳过 assistant，取 user 块内容",
  );
  eq(
    extractFirstUserTask([
      { type: "message", message: { role: "user", content: [{ type: "image", data: "x" }] } },
      { type: "message", message: { role: "user", content: "真正的任务" } },
    ]),
    "真正的任务",
    "纯图片的首条消息跳过，取下一條有文字的",
  );
  eq(extractFirstUserTask([]), null, "空 entries → null");
  eq(extractFirstUserTask([{ type: "session_info", name: "x" }, null, 42]), null, "非消息条目跳过");
});

/* ---------------- 3. 纯函数：解析 / 合并 / 查询 ---------------- */

check("parseModelReviews：形状不全丢弃；兼容数组与 { reviews } 两种形态", () => {
  const good = fixture();
  deepEq(parseModelReviews([good]), [good], "数组形态");
  deepEq(parseModelReviews({ version: 1, reviews: [good] }), [good], "对象形态");
  eq(parseModelReviews(null).length, 0, "null → 空");
  eq(parseModelReviews({ version: 1, reviews: "nope" }).length, 0, "reviews 非数组 → 空");
  for (const bad of [
    { ...good, id: "" },
    { ...good, parentSessionId: "" },
    { ...good, model: { provider: "p" } },
    { ...good, status: "weird" },
  ]) {
    eq(parseModelReviews([bad]).length, 0, `坏条目应丢弃：${JSON.stringify(bad)}`);
  }
  // 非法 error / reviewSessionId 字段被丢掉，其余保留
  const cleaned = parseModelReviews([{ ...good, error: 42, reviewSessionId: "" }])[0];
  eq("error" in cleaned, false, "非法 error 丢弃");
  eq("reviewSessionId" in cleaned, false, "空 reviewSessionId 丢弃");
});

check("upsertModelReview：同 id 覆盖并提前；超出上限 FIFO 丢最旧", () => {
  const list = [fixture({ id: "a" }), fixture({ id: "b" })];
  const next = upsertModelReview(list, fixture({ id: "b", status: "done" }));
  deepEq(next.map((r) => r.id), ["b", "a"], "同 id 覆盖并提到最前");
  eq(next.find((r) => r.id === "b").status, "done", "覆盖的是新内容");

  const many = Array.from({ length: MAX_MODEL_REVIEWS }, (_, i) =>
    fixture({ id: `x${i}`, createdAt: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z` }),
  );
  const overflow = upsertModelReview(many, fixture({ id: "newest" }));
  eq(overflow.length, MAX_MODEL_REVIEWS, "长度封顶");
  eq(overflow[0].id, "newest", "新的在最前");
  eq(overflow.some((r) => r.id === `x${MAX_MODEL_REVIEWS - 1}`), false, "最旧的被挤掉");
});

check("patchModelReview：局部更新且不改 id / parentSessionId", () => {
  const list = [fixture({ id: "a" })];
  const next = patchModelReview(list, "a", { status: "done", id: "hack", parentSessionId: "hack" });
  eq(next[0].status, "done", "状态更新");
  eq(next[0].id, "a", "id 不被补丁覆盖");
  eq(next[0].parentSessionId, "p-1", "parent 不被补丁覆盖");
  deepEq(patchModelReview(list, "missing", { status: "done" }), list, "找不到 id 原样返回");
});

check("findReviewRelations：双向查询 + 按 id 去重", () => {
  const list = [
    fixture({ id: "a", parentSessionId: "s1", reviewSessionId: "s2" }),
    fixture({ id: "b", parentSessionId: "s1", reviewSessionId: "s3" }),
    fixture({ id: "c", parentSessionId: "s9", reviewSessionId: "s2" }),
  ];
  const rel = findReviewRelations(list, "s1");
  deepEq(rel.asParent.map((r) => r.id), ["a", "b"], "s1 作为原会话的复核");
  deepEq(rel.asReview.map((r) => r.id), [], "s1 不是复核产物");

  const rel2 = findReviewRelations(list, "s2");
  deepEq(rel2.asParent.map((r) => r.id), [], "s2 没发起复核");
  deepEq(rel2.asReview.map((r) => r.id), ["a", "c"], "s2 是 a / c 的复核产物");

  // 同一条记录同时满足两侧（异常数据）：只算一次，进 asParent
  const dup = findReviewRelations([fixture({ id: "d", parentSessionId: "s2", reviewSessionId: "s2" })], "s2");
  deepEq([...dup.asParent, ...dup.asReview].map((r) => r.id), ["d"], "同 id 不重复计入两侧");
});

/* ---------------- 4. 磁盘层（真实写盘 / 重读） ---------------- */

const reviewsPath = () => getModelReviewsPath(agentDir);

check("磁盘：写盘 0600 + 往返一致 + 缺失文件当空", () => {
  rmSync(reviewsPath(), { force: true });
  deepEq(readModelReviews(agentDir), [], "缺失文件 → 空");

  const list = [fixture({ id: "a", status: "done" })];
  writeModelReviews(list, agentDir);
  assert(existsSync(reviewsPath()), "文件应已写出");
  const mode = statSync(reviewsPath()).mode & 0o777;
  eq(mode, 0o600, "权限应为 0600");
  deepEq(readModelReviews(agentDir), list, "读写往返一致");
  assert(readFileSync(reviewsPath(), "utf8").includes('"version": 1'), "应带版本信封");
});

check("磁盘：损坏 JSON / 脏结构容错为空，不让一条坏记录挡住界面", () => {
  writeFileSync(reviewsPath(), "{ this is not json", "utf8");
  deepEq(readModelReviews(agentDir), [], "坏 JSON → 空");
  writeFileSync(reviewsPath(), JSON.stringify({ reviews: [{ nope: true }] }), "utf8");
  deepEq(readModelReviews(agentDir), [], "脏条目 → 空");
});

check("磁盘：createModelReview 追加；updateModelReview 状态流转", () => {
  rmSync(reviewsPath(), { force: true });
  const created = createModelReview(
    { parentSessionId: "p-1", model: { provider: "p", modelId: "m" }, taskPreview: "任务", status: "creating" },
    agentDir,
  );
  assert(typeof created.id === "string" && created.id.length > 0, "应生成 id");
  assert(typeof created.createdAt === "string" && created.createdAt.length > 0, "应生成 createdAt");
  deepEq(readModelReviews(agentDir).map((r) => r.id), [created.id], "落盘");

  const updated = updateModelReview(created.id, { status: "done" }, agentDir);
  eq(updated.status, "done", "返回更新后的记录");
  eq(readModelReviews(agentDir)[0].status, "done", "磁盘同步");
  eq(updateModelReview("missing", { status: "error" }, agentDir), null, "找不到 id → null");

  // FIFO 落盘：塞满 + 1，磁盘只留 200 条
  const many = Array.from({ length: MAX_MODEL_REVIEWS }, (_, i) => fixture({ id: `k${i}` }));
  writeModelReviews(many, agentDir);
  createModelReview(
    { parentSessionId: "p-2", model: { provider: "p", modelId: "m" }, taskPreview: "新任务", status: "creating" },
    agentDir,
  );
  eq(readModelReviews(agentDir).length, MAX_MODEL_REVIEWS, "磁盘封顶 200");
});

/* ---------------- 5. 路由层（校验契约） ---------------- */

const route = await jiti.import("../app/api/model-reviews/route.ts");
const postReview = async (body) => {
  const res = await route.POST(
    new Request("http://localhost/api/model-reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, data: await res.json() };
};
const getReview = async (sessionId) => {
  const url = sessionId
    ? `http://localhost/api/model-reviews?sessionId=${encodeURIComponent(sessionId)}`
    : "http://localhost/api/model-reviews";
  const res = await route.GET(new Request(url));
  return { status: res.status, data: await res.json() };
};

/** 造一个最小会话文件（只够 resolveSessionPath + readSessionHeader 认出）。 */
function writeFixtureSession(sessionId, { withUserText = true } = {}) {
  const dir = join(agentDir, "sessions", "demo-project");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `2026-10-16T00-00-00-000Z_${sessionId}.jsonl`);
  const lines = [
    JSON.stringify({
      type: "session",
      id: sessionId,
      timestamp: "2026-10-16T00:00:00.000Z",
      cwd: "/home/demo/pi-workspace",
    }),
  ];
  if (withUserText) {
    lines.push(JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-10-16T00:00:01.000Z", message: { role: "user", content: "虚构任务：修一个 demo bug" } }));
  } else {
    lines.push(JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-10-16T00:00:01.000Z", message: { role: "assistant", content: "（只有助手消息，没有任务原文）" } }));
  }
  writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  return file;
}

await checkAsync("路由：缺 parentSessionId → 400", async () => {
  const r = await postReview({});
  eq(r.status, 400, "状态码");
  assert(/parentSessionId/.test(r.data.error), "错误文案应点出缺字段");
});

await checkAsync("路由：provider 与 modelId 未成对 → 400", async () => {
  for (const body of [
    { parentSessionId: "s-x", provider: "p" },
    { parentSessionId: "s-x", modelId: "m" },
  ]) {
    const r = await postReview(body);
    eq(r.status, 400, `成对校验：${JSON.stringify(body)}`);
  }
});

await checkAsync("路由：原会话不存在 → 404", async () => {
  const r = await postReview({ parentSessionId: "definitely-missing-session" });
  eq(r.status, 404, "状态码");
  assert(/不存在/.test(r.data.error), "应回「不存在」");
});

await checkAsync("路由：原会话没有任务文本 → 400（不落到起会话）", async () => {
  const sessionId = "fixture-no-task";
  writeFixtureSession(sessionId, { withUserText: false });
  const r = await postReview({ parentSessionId: sessionId });
  eq(r.status, 400, "状态码");
  assert(/任务文本/.test(r.data.error), "应回「没有可复核的任务文本」");
});

await checkAsync("路由：GET 双向查询（作为原会话 / 作为复核产物）", async () => {
  rmSync(reviewsPath(), { force: true });
  writeModelReviews(
    [
      fixture({ id: "ra", parentSessionId: "parent-1", reviewSessionId: "review-1" }),
      fixture({ id: "rb", parentSessionId: "parent-2", reviewSessionId: "review-1" }),
    ],
    agentDir,
  );
  const asParent = await getReview("parent-1");
  eq(asParent.status, 200, "状态码");
  deepEq(asParent.data.asParent.map((r) => r.id), ["ra"], "正向");
  deepEq(asParent.data.asReview, [], "无反向");

  const asReview = await getReview("review-1");
  deepEq(asReview.data.asReview.map((r) => r.id), ["ra", "rb"], "反向两条去重");
  deepEq(asReview.data.asParent, [], "无正向");

  const all = await getReview("");
  eq(all.data.reviews.length, 2, "无 sessionId 时返回全部");
});

/* ---------------- 6. 调用点静态核对（防分层绿、链路断） ---------------- */

const readSource = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

check("模块分层：纯函数定义在 IO 导入之前（客户端只取类型就不会拖 fs）", () => {
  const source = readSource("lib/model-review.ts");
  const pureIdx = source.indexOf("export function extractFirstUserTask");
  const ioIdx = source.indexOf('from "node:fs"');
  assert(pureIdx >= 0, "应有纯函数");
  assert(ioIdx >= 0, "应有 IO 区");
  assert(pureIdx < ioIdx, "纯函数区应在 IO 区之前");
  assert(/^\/\/ ={10,}$/m.test(source), "应有 IO 区分隔线");
});

check("路由：走 session-launch 唯一路径 + 不注入原产出 + 模型校验 + 状态流转", () => {
  const source = readSource("app/api/model-reviews/route.ts");
  assert(/startNewAgentSession\(/.test(source), "必须走 lib/session-launch");
  assert(/buildReviewPrompt\(taskText\)/.test(source), "消息应只由原任务原文构造");
  assert(!/extractFirstUserTask\(.*\)[\s\S]{0,80}reviewSessionId/.test(source), "不得把复核会话产出回灌");
  assert(/isVisibleModel\(models, provider, modelId\)/.test(source), "应校验模型在可选集内");
  assert(/extractFirstUserTask/.test(source), "应从原会话取首条任务");
  assert(/updateModelReview\(review\.id, \{ status: "running", reviewSessionId \}\)/.test(source), "应落 running");
  assert(/event\.type === "agent_end"/.test(source), "应在 agent_end 落 done");
  assert(/event\.type === "prompt_error"/.test(source), "应在 prompt_error 落 error");
});

check("复核独立语义：buildReviewPrompt 只吃任务原文，纯函数里没有回灌产出的入口", () => {
  const source = readSource("lib/model-review.ts");
  // 只有「任务原文 + 声明」两个输入，不得出现 diff / 结论 / 上下文 之类的注入面
  assert(/export function buildReviewPrompt\(taskText: string\)/.test(source), "签名应只有 taskText");
  assert(!/buildReviewPrompt\([^)]*diff/i.test(source), "不得注入 diff");
});

check("观测栏：复核区渲染 + 并排打开 / 打开复核会话 / 回链原会话", () => {
  const source = readSource("components/SessionObservatory.tsx");
  assert(/function ModelReviewSection\(/.test(source), "应有复核区");
  assert(/\{review && <ModelReviewSection \{\.\.\.review\} \/>\}/.test(source), "观测栏应渲染复核区");
  assert(/rail-review-side/.test(source), "应有并排打开");
  assert(/rail-review-open/.test(source), "应有打开复核会话");
  assert(/rail-review-parent/.test(source), "应有回链原会话");
  assert(/<ModelPicker/.test(source), "应复用 ModelPicker");
  assert(/fetch\(`\/api\/model-reviews\?sessionId=/.test(source), "应查询复核关系");
});

check("ChatView：把复核区数据（会话 / 模型集 / 打开动作）透传给观测栏", () => {
  const source = readSource("components/ChatView.tsx");
  assert(/review=\{session\?\.id \? \{/.test(source), "应传 review 对象");
  assert(/onOpenSide: \(id\) => onSelectSide\?\.\(id\)/.test(source), "并排打开应走 ?side=");
  assert(/openSessionById/.test(source), "应有按 id 打开（会话列表未刷新时兜底）");
});

check(".gitignore 白名单包含本自测（随仓库分发，非本机夹具）", () => {
  const source = readSource(".gitignore");
  assert(/!tools\/model-review-selftest\.mjs/.test(source), "应加入白名单");
});

rmSync(root, { recursive: true, force: true });

console.log(fail === 0 ? "\n全部通过" : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
