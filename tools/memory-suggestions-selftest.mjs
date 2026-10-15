// 记忆整理候选（lib/memory-suggestions.ts）的自检：解析 / 标记词 / 长度门槛 / 空待办 /
// 去重 / 对记忆内容的排除 / 忽略清单 / cap / key 稳定性 / 空目录。
// 运行：node tools/memory-suggestions-selftest.mjs
//
// 隔离：PI_CODING_AGENT_DIR 与 ELENVA_WORKLOG_DIR 都指向 mkdtemp 出来的临时目录，
// 全用**虚构**数据（自造中文句与 ASCII 词），不碰真实工作记录与记忆文件。
// lib/*.ts 是纯 TS（无 JSX），jiti 可直载（.tsx 不行，见记忆 F1）。
import { createJiti } from "jiti";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "elenva-memory-suggests-selftest-"));
const agentDir = join(root, "agent");
const worklogDir = join(root, "worklog");
mkdirSync(agentDir, { recursive: true });
mkdirSync(worklogDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.ELENVA_WORKLOG_DIR = worklogDir;

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const lib = await jiti.import("../lib/memory-suggestions.ts");
const {
  listMemorySuggestions,
  readRecentWorklogBlocks,
  isLessonLine,
  normalizeSuggestionLine,
  suggestionKey,
  listDismissed,
  isDismissed,
  dismissSuggestion,
  getMemorySuggestsPath,
  worklogDir: worklogDirFn,
  LESSON_MARKERS,
  SUGGESTION_LINE_MIN_LENGTH,
  SUGGESTION_MAX_ENTRIES,
  SUGGESTION_MAX_ITEMS,
  SUGGESTION_DISMISS_LIMIT,
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

/* ============================ 临时环境工具 ============================ */

const memoryPath = () => join(agentDir, "pi-hermes-memory", "MEMORY.md");

const writeWorklog = (name, content, mtimeMs) => {
  const path = join(worklogDir, name);
  writeFileSync(path, content, "utf8");
  if (typeof mtimeMs === "number") utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
};

const resetWorklogs = () => {
  for (const name of readdirSync(worklogDir)) rmSync(join(worklogDir, name), { force: true });
};

const writeMemoryEntries = (entries) => {
  mkdirSync(dirname(memoryPath()), { recursive: true });
  writeFileSync(
    memoryPath(),
    `${entries.map((text) => `${text} <!-- created=2020-01-01, last=2020-01-01 -->`).join("\n§\n")}\n`,
    "utf8",
  );
};

const clearMemory = () => rmSync(join(agentDir, "pi-hermes-memory"), { recursive: true, force: true });
const resetDismissed = () => rmSync(getMemorySuggestsPath(), { force: true });

/** 造一条工作记录条目（heading + 正文行） */
const entry = (title, lines, date = "2026-10-15 10:00", status = "done") =>
  [`## ${date} · ${title} · ${status}`, ...lines].join("\n");

/** 每个用例前：清空工作记录 / 记忆 / 忽略清单 */
const fresh = () => {
  resetWorklogs();
  clearMemory();
  resetDismissed();
};

/* ============================ 隔离自证 ============================ */

check("① 临时目录隔离生效（忽略清单与工作记录都落在临时目录内）", () => {
  assert.equal(getMemorySuggestsPath(), resolve(agentDir, "elenva-memory-suggests.json"));
  assert.ok(getMemorySuggestsPath().startsWith(agentDir));
  assert.equal(worklogDirFn(), worklogDir);
});

/* ============================ 常量 ============================ */

check("② 常量导出且取任务书定稿值；标记词表齐全", () => {
  assert.equal(SUGGESTION_LINE_MIN_LENGTH, 12);
  assert.equal(SUGGESTION_MAX_ENTRIES, 40);
  assert.equal(SUGGESTION_MAX_ITEMS, 8);
  assert.equal(SUGGESTION_DISMISS_LIMIT, 200);
  for (const word of ["踩坑", "坑点", "教训", "陷阱", "切记", "以后不要", "不要再", "避免", "经验", "学到", "小技巧", "注意"]) {
    assert.ok(LESSON_MARKERS.includes(word), `标记词表缺 ${word}`);
  }
});

/* ============================ 解析 / 排序 ============================ */

check("③ 多文件按 mtime 新→旧、文件内新→旧；边界标题不丢条目", () => {
  fresh();
  const oldAt = Date.now() - 60_000;
  writeWorklog(
    "old.md",
    [entry("旧条目", ["注意：这是旧文件里的一条线索内容"]), "\n", entry("更旧条目", ["教训：这是更早的一条线索内容"])].join("\n\n"),
    oldAt,
  );
  writeWorklog(
    "new.md",
    [
      entry("新条目", ["经验：这是新文件里的一条线索内容"]),
      "\n",
      "## 边界标题没有时间\n踩坑：边界标题下的线索也要被扫到",
      "\n",
      "## 2026-10-14 09:00 宽松格式的标题\n教训：宽松标题下的线索也要被扫到",
    ].join("\n\n"),
    Date.now(),
  );

  const candidates = listMemorySuggestions();
  const lines = candidates.map((c) => c.line);
  assert.ok(lines.includes("经验：这是新文件里的一条线索内容"), "新文件的线索应出现");
  assert.ok(lines.includes("踩坑：边界标题下的线索也要被扫到"), "边界标题的条目不应被丢弃");
  assert.ok(lines.includes("注意：这是旧文件里的一条线索内容"), "旧文件的线索也应出现");
  assert.ok(lines.indexOf("经验：这是新文件里的一条线索内容") < lines.indexOf("注意：这是旧文件里的一条线索内容"), "新文件应先于旧文件");

  const boundary = candidates.find((c) => c.line.startsWith("踩坑："));
  assert.equal(boundary.sourceTitle, "边界标题没有时间");
  assert.equal(boundary.sourceDate, null, "边界标题取不到时间应为 null");
  const loose = candidates.find((c) => c.line.startsWith("教训："));
  assert.equal(loose.sourceTitle, "宽松格式的标题");
  assert.equal(loose.sourceDate, "2026-10-14 09:00", "宽松标题应能从行首取到时间");
  const normal = candidates.find((c) => c.line.startsWith("经验："));
  assert.equal(normal.sourceTitle, "新条目");
  assert.equal(normal.sourceDate, "2026-10-15 10:00");

  const blocks = readRecentWorklogBlocks();
  assert.equal(blocks.length, 5, "5 条条目应都被解析到");
  assert.equal(blocks[0].sourceFile, "new.md", "文件内新→旧：new.md 的第一条在最前");
});

/* ============================ 标记词 / 长度门槛 ============================ */

check("④ 标记词命中；短行与无标记词行不报", () => {
  fresh();
  writeWorklog(
    "m.md",
    entry("标记词检查", [
      "注意：这是一条足够长的线索内容",
      "注意",
      "这是一句很长的但没有标记词的普通句子内容",
      "避免：这是一条足够长的避免线索",
    ]),
  );
  const lines = listMemorySuggestions().map((c) => c.line);
  assert.ok(lines.includes("注意：这是一条足够长的线索内容"));
  assert.ok(lines.includes("避免：这是一条足够长的避免线索"));
  assert.ok(!lines.some((l) => l === "注意"), "短于 12 字的行不报");
  assert.ok(!lines.some((l) => l.startsWith("这是一句很长")), "无标记词的长行不报");
  assert.equal(isLessonLine("注意"), false);
  assert.equal(isLessonLine("这是一句很长的但没有标记词的普通句子内容"), false);
});

/* ============================ 空待办 / 空标签 ============================ */

check("⑤ 空待办行与纯标签行跳过", () => {
  assert.equal(isLessonLine("待办：无。"), false);
  assert.equal(isLessonLine("待办：无。（更正：这里写了注意但其实没有待办）"), false);
  assert.equal(isLessonLine("待办: 无"), false);
  assert.equal(isLessonLine("目标："), false);
  assert.equal(isLessonLine("做了什么:"), false);

  fresh();
  writeWorklog(
    "todo.md",
    entry("空待办", ["待办：无。（更正：这里写了注意但其实没有待办）", "经验：这是一条真的要报的线索"]),
  );
  const lines = listMemorySuggestions().map((c) => c.line);
  assert.deepEqual(lines, ["经验：这是一条真的要报的线索"]);
});

/* ============================ 去重 ============================ */

check("⑥ 同一行（归一后）只留一条，新文件优先", () => {
  fresh();
  const dup = "- 教训：这条线索在两个文件里都出现过";
  writeWorklog("old.md", entry("旧", ["教训：这条线索在两个文件里都出现过"]), Date.now() - 60_000);
  writeWorklog("new.md", entry("新", [dup]), Date.now());
  const candidates = listMemorySuggestions();
  assert.equal(candidates.length, 1, `期望去重后 1 条，实得 ${candidates.length}`);
  assert.equal(candidates[0].sourceFile, "new.md");
});

/* ============================ 对记忆内容的排除 ============================ */

check("⑦ 已在记忆里的行被排除（整行包含 / 前 30 字核心包含）", () => {
  fresh();
  const exact = "踩坑：这条已经写进记忆了不必再提示";
  const contained = "陷阱：这条只是记忆条目的一个片段";
  const core = `切记${"甲".repeat(38)}`; // 40 字，核心 = 前 30 字
  assert.ok(core.length > 30);
  writeMemoryEntries([
    exact,
    `先是一段记忆正文：${contained}，后面还有别的内容`,
    `${core.slice(0, 30)}，后面又补了别的说明`,
  ]);
  writeWorklog("m.md", entry("记忆排除", [exact, contained, core, "经验：这条没写进记忆应当出现"]));
  const lines = listMemorySuggestions().map((c) => c.line);
  assert.deepEqual(lines, ["经验：这条没写进记忆应当出现"]);
});

/* ============================ 忽略清单 ============================ */

check("⑧ dismiss 后该候选消失；listDismissed / isDismissed 一致", () => {
  fresh();
  writeWorklog("m.md", entry("忽略检查", ["经验：第一条线索内容足够长", "教训：第二条线索内容足够长"]));
  const before = listMemorySuggestions();
  assert.equal(before.length, 2);
  const target = before[0];
  assert.equal(dismissSuggestion(target.key), true);
  assert.equal(isDismissed(target.key), true);
  assert.ok(listDismissed().includes(target.key));
  const after = listMemorySuggestions();
  assert.equal(after.length, 1);
  assert.notEqual(after[0].key, target.key);
});

check("⑨ 忽略清单落盘结构 {version:1, dismissed}、权限 0600、重复 dismiss 只留一份", () => {
  fresh();
  assert.equal(dismissSuggestion("key-a"), true);
  assert.equal(dismissSuggestion("key-b"), true);
  assert.equal(dismissSuggestion("key-a"), true); // 重复
  const parsed = JSON.parse(readFileSync(getMemorySuggestsPath(), "utf8"));
  assert.deepEqual(Object.keys(parsed).sort(), ["dismissed", "version"]);
  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.dismissed, ["key-b", "key-a"], "重复 key 只保留一份且移到最后");
  assert.equal(statSync(getMemorySuggestsPath()).mode & 0o777, 0o600);
});

check("⑩ 忽略清单损坏容错 + 上限 200 FIFO", () => {
  fresh();
  writeFileSync(getMemorySuggestsPath(), "{ 这不是 JSON", "utf8");
  assert.deepEqual(listDismissed(), [], "损坏文件应容错为空表");
  assert.equal(isDismissed("任意"), false);
  assert.equal(dismissSuggestion("重建后的 key"), true, "损坏后应能重建干净清单");

  const many = Array.from({ length: SUGGESTION_DISMISS_LIMIT }, (_, i) => `k${i}`);
  writeFileSync(getMemorySuggestsPath(), JSON.stringify({ version: 1, dismissed: many }), "utf8");
  assert.equal(dismissSuggestion("最新 key"), true);
  const kept = listDismissed();
  assert.equal(kept.length, SUGGESTION_DISMISS_LIMIT, "写后不应超过上限");
  assert.ok(!kept.includes("k0"), "最旧的应被 FIFO 淘汰");
  assert.ok(kept.includes("k1"), "次旧的应保留");
  assert.equal(kept[kept.length - 1], "最新 key", "最新加入的应在末尾");
});

/* ============================ cap / 空 / key ============================ */

check("⑪ cap 8：12 条线索只报前 8 条", () => {
  fresh();
  const lines = Array.from({ length: 12 }, (_, i) => `经验：第 ${i} 条线索内容足够长`);
  writeWorklog("m.md", entry("上限检查", lines));
  const candidates = listMemorySuggestions();
  assert.equal(candidates.length, SUGGESTION_MAX_ITEMS);
  assert.equal(candidates.length, 8);
  assert.deepEqual(candidates.map((c) => c.line), lines.slice(0, 8));
});

check("⑫ 空工作记录目录 / 无候选 → []", () => {
  fresh();
  assert.deepEqual(listMemorySuggestions(), []);
  writeWorklog("m.md", entry("没有线索", ["目标：做点什么", "做了什么：写了一段代码"]));
  assert.deepEqual(listMemorySuggestions(), []);
});

check("⑬ key 稳定：sha1(sourceFile + NUL + 归一后的 line)，行首符号与空白归一", () => {
  const normalized = "注意：这是一条线索内容";
  const expected = createHash("sha1").update(`a.md\u0000${normalized}`, "utf8").digest("hex");
  assert.equal(suggestionKey("a.md", "- 注意：这是一条线索内容"), expected);
  assert.equal(suggestionKey("a.md", "  注意：这是一条线索内容  "), expected);
  assert.equal(suggestionKey("a.md", "注意：这是一条  线索内容"), suggestionKey("a.md", "注意：这是一条 线索内容"), "连续空白应折叠为一个");
  assert.notEqual(suggestionKey("b.md", normalized), expected, "不同文件应得到不同 key");
  assert.equal(normalizeSuggestionLine("  1. * 小技巧：写点东西  "), "小技巧：写点东西");
});

console.log(fail === 0 ? `\n全部通过（13 项）` : `\n失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
