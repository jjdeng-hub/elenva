// 「模型备注」（模块 6 · 第 4 轮）的自检：
// 纯函数层（归一 / 长度 / 截断 / 校验 / 解析容错 / 增删）
// + 磁盘层（读写往返 / 0600 / 损坏容错 / 缺文件容错）
// + 路由层（set / clear / 缺字段 400 / 超长 400 / 非字符串 400）
// + 调用点静态核对（模型页内联编辑 / 选择器小字 / 只增不改他接口 / .gitignore 白名单）。
// 运行：node tools/model-notes-selftest.mjs
//
// 隔离：PI_CODING_AGENT_DIR 指向 mkdtemp 出来的临时目录，全用**虚构**数据，
// 不碰真实 ~/.pi/agent。lib/*.ts 是纯 TS（无 JSX），jiti 可直载。
import { createJiti } from "jiti";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "elenva-model-notes-selftest-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const lib = await jiti.import("../lib/model-notes.ts");
const {
  MAX_NOTE_LENGTH,
  NOTE_DISPLAY_MAX,
  noteKey,
  noteLength,
  normalizeNote,
  truncateNote,
  validateNote,
  parseModelNotes,
  setNote,
  clearNote,
  getNote,
  getModelNotesPath,
  readModelNotes,
  writeModelNotes,
  saveModelNote,
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

const notesPath = () => getModelNotesPath(agentDir);

/* ---------------- 1. 纯函数：键 / 归一 / 长度 / 截断 ---------------- */

check("noteKey：provider/modelId 拼成存储键", () => {
  eq(noteKey("demo-provider", "demo-model"), "demo-provider/demo-model", "键格式");
});

check("normalizeNote：折叠换行与连续空白 + 去首尾；空串即清除信号", () => {
  eq(normalizeNote("  擅长 \n\n 长上下文\t便宜  "), "擅长 长上下文 便宜", "折叠空白");
  eq(normalizeNote("   "), "", "纯空白 → 空串");
  eq(normalizeNote(""), "", "空串 → 空串");
});

check("noteLength：按码点计数（中文 / emoji 各算一个）", () => {
  eq(noteLength("便宜"), 2, "中文两字");
  eq(noteLength("🙂🙂"), 2, "两个 emoji");
  eq(noteLength("a b"), 3, "含空格");
});

check("truncateNote：不超过上限原样，超出按码点截断加省略号", () => {
  eq(truncateNote("短备注"), "短备注", "不超上限");
  const long = "字".repeat(NOTE_DISPLAY_MAX + 20);
  const cut = truncateNote(long);
  eq(Array.from(cut).length, NOTE_DISPLAY_MAX, "截到展示上限（含省略号）");
  assert(cut.endsWith("…"), "应以省略号收尾");
  eq(truncateNote("🙂".repeat(5), 3), "🙂🙂…", "emoji 不被切成半个");
});

/* ---------------- 2. 纯函数：输入校验 ---------------- */

check("validateNote：非字符串拒绝；空串合法（清除）；按归一后长度判上限", () => {
  eq(validateNote(123).ok, false, "数字 → 拒绝");
  eq(validateNote(null).ok, false, "null → 拒绝");
  eq(validateNote(undefined).ok, false, "undefined → 拒绝");
  deepEq(validateNote("  便宜  "), { ok: true, note: "便宜" }, "归一后返回");
  deepEq(validateNote("   "), { ok: true, note: "" }, "纯空白 → 合法清除");
  const atLimit = "字".repeat(MAX_NOTE_LENGTH);
  eq(validateNote(atLimit).ok, true, "刚好上限 → 通过");
  const over = validateNote("字".repeat(MAX_NOTE_LENGTH + 1));
  eq(over.ok, false, "超一字 → 拒绝");
  assert(/200/.test(over.error), "错误文案应点出上限");
  // 折叠后才计数：多打的空白不该把用户顶到上限外
  eq(validateNote(`${"字".repeat(MAX_NOTE_LENGTH)}     `).ok, true, "尾部空白折叠后仍在限内");
});

/* ---------------- 3. 纯函数：解析容错 / 增删 ---------------- */

check("parseModelNotes：坏形状静默丢弃，好条目归一", () => {
  deepEq(parseModelNotes(null), {}, "null → 空表");
  deepEq(parseModelNotes([]), {}, "数组 → 空表");
  deepEq(parseModelNotes("x"), {}, "字符串 → 空表");
  deepEq(
    parseModelNotes({
      "demo-provider/demo-model": { note: " 擅长长上下文 ", updatedAt: "2026-10-16T00:00:00.000Z" },
      "  ": { note: "空键" },
      "p/bad-value": "not-an-object",
      "p/no-note": { updatedAt: "2026-10-16T00:00:00.000Z" },
      "p/blank-note": { note: "   " },
    }),
    { "demo-provider/demo-model": { note: "擅长长上下文", updatedAt: "2026-10-16T00:00:00.000Z" } },
    "只留形状完整的条目并归一",
  );
  // 缺 updatedAt 时给 epoch 兜底，不丢那条备注
  const fallback = parseModelNotes({ "p/m": { note: "没时间戳" } });
  eq(fallback["p/m"].note, "没时间戳", "缺时间戳仍保留");
  eq(fallback["p/m"].updatedAt, new Date(0).toISOString(), "时间戳兜底");
});

check("setNote / clearNote / getNote：纯函数、返回新表、空串即清除", () => {
  const base = {};
  const one = setNote(base, "p", "m", "便宜，适合草稿", "2026-10-16T00:00:00.000Z");
  deepEq(base, {}, "不改入参");
  eq(one["p/m"].note, "便宜，适合草稿", "写入");
  eq(one["p/m"].updatedAt, "2026-10-16T00:00:00.000Z", "记录时间戳");
  eq(getNote(one, "p", "m").note, "便宜，适合草稿", "读取");
  eq(getNote(one, "p", "none"), null, "不存在 → null");

  const two = setNote(one, "p", "m", "改成：擅长长上下文");
  eq(two["p/m"].note, "改成：擅长长上下文", "同键覆盖");
  eq(Object.keys(two).length, 1, "不新增重复键");

  const three = setNote(two, "p", "m", "   ");
  assert(!("p/m" in three), "空白 → 删除键");
  eq(clearNote(three, "p", "missing"), three, "清除不存在的键原样返回");
  deepEq(clearNote(two, "p", "m"), {}, "清除已存在的键");
});

/* ---------------- 4. 磁盘层：往返 / 权限 / 容错 ---------------- */

check("落盘形状：`provider/modelId` 平铺映射 + 缩进 JSON", () => {
  writeModelNotes(setNote({}, "demo-provider", "demo-model", "擅长长上下文，贵"), agentDir);
  const raw = JSON.parse(readFileSync(notesPath(), "utf8"));
  eq(raw["demo-provider/demo-model"].note, "擅长长上下文，贵", "落盘形状与规格一致");
  assert(!("version" in raw), "规格是平铺映射，不套 version 壳");
  assert(readFileSync(notesPath(), "utf8").endsWith("\n"), "文件以换行收尾");
});

check("文件权限：0600（备注是私人档案，不给同机其他用户读）", () => {
  const mode = statSync(notesPath()).mode & 0o777;
  eq(mode, 0o600, "权限位");
});

check("读写往返：saveModelNote 落库 + 读回；清除后键消失", () => {
  rmSync(notesPath(), { force: true });
  eq(readModelNotes(agentDir)["p/m"] ?? null, null, "缺文件 → 空表不抛");

  const saved = saveModelNote("demo-provider", "demo-model", "擅长长上下文", agentDir);
  eq(saved.note, "擅长长上下文", "返回落库后的条目");
  eq(readModelNotes(agentDir)["demo-provider/demo-model"].note, "擅长长上下文", "读回");

  const cleared = saveModelNote("demo-provider", "demo-model", "", agentDir);
  eq(cleared, null, "清除返回 null");
  assert(!("demo-provider/demo-model" in readModelNotes(agentDir)), "清除后键消失");
});

check("损坏容错：非法 JSON / 非对象顶层 → 空表，不让界面因一条坏记录打不开", () => {
  writeFileSync(notesPath(), "{ 这不是 JSON", "utf8");
  deepEq(readModelNotes(agentDir), {}, "非法 JSON → 空表");

  writeFileSync(notesPath(), JSON.stringify([1, 2, 3]), "utf8");
  deepEq(readModelNotes(agentDir), {}, "顶层是数组 → 空表");

  writeFileSync(notesPath(), JSON.stringify({ "p/m": { note: "" } }), "utf8");
  deepEq(readModelNotes(agentDir), {}, "空备注条目 → 丢弃");

  // 坏文件之后仍能正常写入（写是覆盖，不是追加）
  writeModelNotes(setNote({}, "p", "m", "恢复"), agentDir);
  eq(readModelNotes(agentDir)["p/m"].note, "恢复", "坏文件后可恢复");
});

check("原子写：目录不存在时自动创建", () => {
  const nested = join(root, "nested", "agent");
  writeModelNotes(setNote({}, "p", "m", "深层目录"), nested);
  assert(existsSync(getModelNotesPath(nested)), "文件应被创建");
  eq(readModelNotes(nested)["p/m"].note, "深层目录", "内容正确");
});

/* ---------------- 5. 路由层（校验契约） ---------------- */

const route = await jiti.import("../app/api/model-notes/route.ts");
const postNote = async (body) => {
  const res = await route.POST(
    new Request("http://localhost/api/model-notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, data: await res.json() };
};
const getNotes = async () => {
  const res = await route.GET();
  return { status: res.status, data: await res.json() };
};

await checkAsync("路由：GET 返回全表 + 上限（界面据此显示计数）", async () => {
  rmSync(notesPath(), { force: true });
  saveModelNote("demo-provider", "demo-model", "擅长长上下文", agentDir);
  const r = await getNotes();
  eq(r.status, 200, "状态码");
  eq(r.data.notes["demo-provider/demo-model"].note, "擅长长上下文", "全表");
  eq(r.data.maxLength, MAX_NOTE_LENGTH, "返回长度上限");
});

await checkAsync("路由：POST 落一条（归一后写入）", async () => {
  const r = await postNote({ provider: "demo-provider", modelId: "m2", note: "  便宜  " });
  eq(r.status, 200, "状态码");
  eq(r.data.note, "便宜", "返回归一后的文本");
  eq(readModelNotes(agentDir)["demo-provider/m2"].note, "便宜", "已落库");
});

await checkAsync("路由：note 空串 = 清除（键被删掉，而不是写空壳）", async () => {
  saveModelNote("demo-provider", "m3", "将被清除", agentDir);
  const r = await postNote({ provider: "demo-provider", modelId: "m3", note: "" });
  eq(r.status, 200, "状态码");
  eq(r.data.note, null, "返回 null");
  assert(!("demo-provider/m3" in readModelNotes(agentDir)), "键被删除");
});

await checkAsync("路由：缺 provider / modelId → 400", async () => {
  for (const body of [{}, { provider: "p" }, { modelId: "m" }, { provider: "  ", modelId: "m" }]) {
    const r = await postNote(body);
    eq(r.status, 400, `校验：${JSON.stringify(body)}`);
    assert(/provider|modelId/.test(r.data.error), "错误文案应点出缺字段");
  }
});

await checkAsync("路由：超长 → 400（不落库）；非字符串 → 400", async () => {
  const r = await postNote({ provider: "p", modelId: "m", note: "字".repeat(MAX_NOTE_LENGTH + 1) });
  eq(r.status, 400, "超长状态码");
  assert(/200/.test(r.data.error), "错误文案应点出上限");
  assert(!("p/m" in readModelNotes(agentDir)), "超长不落库");

  const r2 = await postNote({ provider: "p", modelId: "m", note: 42 });
  eq(r2.status, 400, "非字符串状态码");
});

/* ---------------- 6. 调用点静态核对（防分层绿、链路断） ---------------- */

const readSource = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

check("模块分层：纯函数定义在 IO 导入之前（客户端只取类型就不会拖 fs）", () => {
  const source = readSource("lib/model-notes.ts");
  const pureIdx = source.indexOf("export function parseModelNotes");
  const ioIdx = source.indexOf('from "node:fs"');
  assert(pureIdx >= 0, "应有纯函数");
  assert(ioIdx >= 0, "应有 IO 区");
  assert(pureIdx < ioIdx, "纯函数区应在 IO 区之前");
});

check("存储位置与形状：elenva-model-notes.json + provider/modelId 键", () => {
  const source = readSource("lib/model-notes.ts");
  assert(/elenva-model-notes\.json/.test(source), "文件名");
  assert(/writePrivateFileAtomicSync/.test(source), "原子写 + 0600");
  assert(/`\$\{provider\}\/\$\{modelId\}`/.test(source), "键口径");
});

check("模型页：每行备注展示 + 小铅笔内联编辑 + Enter 保存", () => {
  const source = readSource("components/ModelScopeEditor.tsx");
  assert(/useModelNotes\(/.test(source), "应取备注");
  assert(/notes\[ref\]\?\.note/.test(source), "行内展示备注");
  assert(/model-note-edit-/.test(source), "应有小铅笔入口");
  assert(/model-note-input-/.test(source), "应有内联输入");
  assert(/e\.key === "Enter"/.test(source), "Enter 保存");
  assert(/e\.key === "Escape"/.test(source), "Esc 取消");
  assert(/saveNote\(/.test(source), "应调用落库");
});

check("选择器：菜单行为有备注的模型显示小字，过长截断", () => {
  const source = readSource("components/ModelPicker.tsx");
  assert(/useModelNotes\(\{ enabled: open \}\)/.test(source), "菜单打开才拉备注");
  assert(/notes\[key\]\?\.note/.test(source), "按 provider/id 取备注");
  assert(/noteLine\(note\)/.test(source), "过长的截断后再显示");
});

check("接口只增不改：新路由挂 lib/model-notes，不碰模型清单加载链", () => {
  const routeSource = readSource("app/api/model-notes/route.ts");
  assert(/from "@\/lib\/model-notes"/.test(routeSource), "应挂到 lib/model-notes");
  assert(/readModelNotes\(/.test(routeSource) && /saveModelNote\(/.test(routeSource), "读写都走存储层");
  assert(!/loadModels|models-loader|models-cache/.test(routeSource), "备注接口不碰模型清单加载链");
  assert(!/model-notes/.test(readSource("app/api/models/route.ts")), "模型清单接口未被改动");
});

check(".gitignore 白名单包含本自测（随仓库分发，非本机夹具）", () => {
  const source = readSource(".gitignore");
  assert(/!tools\/model-notes-selftest\.mjs/.test(source), "应加入白名单");
});

// 收尾：确认全程只在临时目录里写（真实 agentDir 从未被碰到）
unlinkSync(notesPath());
rmSync(root, { recursive: true, force: true });

console.log(fail === 0 ? "\n全部通过" : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
