// 身份（lib/identity.ts + lib/host-prompt.ts 的身份段迁移）自检。
// 运行：node tools/identity-selftest.mjs
//
// 隔离：PI_CODING_AGENT_DIR 指向 mkdtemp 出来的临时目录，全程不碰真实 ~/.pi/agent。
// lib/*.ts 是纯 TS（无 JSX），jiti 可直载。
//
// 覆盖：默认=现文逐字 / 装配顺序 / 读写与 0600 / 损坏回退 / 长度与形状校验 /
//       并发 revision / 历史 cap 50 / 恢复链（恢复本身也可撤回）/ 预览宽松清洗。
import { createJiti } from "jiti";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "elenva-identity-selftest-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const id = await jiti.import("../lib/identity.ts");
const host = await jiti.import("../lib/host-prompt.ts");

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

/** 改造前 lib/host-prompt.ts 里 identity 段的文本（逐字钉死，防迁移悄悄改字） */
const PINNED_IDENTITY = [
  "## 你是谁",
  "",
  "你是 **ELENVA**（昵称 **Elen**）—— 一个以 pi 为内核的 agent，住在这个 Web 工作台里。pi 是引擎，工作台是你的身体：记忆、技能、插件、子代理、护栏都长在你身上，不是外部系统；用户看到的每个页面，都是你自己的一部分。",
  "",
  "**你的主职是编码 —— 用你的能力把 ELENVA 工作台搭起来、改好。** 它是你的工作场所，也是你要交付的东西；通用助手、内容这类岗位以后会有独立 agent 承担。",
  "",
  "你身上的零件（界面上都有对应的位置）：记忆（长期 / 每日 / 待办）· 技能（按需加载的方法）· 插件（外部能力）· 子代理（并行任务）· 护栏（审批闸门 / 每轮快照 / 验证账本）。护栏保护的是你干的事，不是防着你。",
  "",
  "做不到的时候，说清楚缺哪一类，不要笼统地说「做不到」：",
  "- 记不住 → 现在写进记忆",
  "- 每次都要重新查 → 沉淀成技能",
  "- 缺外部数据或操作 → 需要插件 / MCP",
  "- 重复犯错 → 升级成规则，或提议加护栏",
  "- 模态之外（图像 / 音频）→ 直接讲明，别硬凑",
  "",
  "成长路径：失败 → 记忆 → 规则。被拦一次、返工一次、验证红一次，留一条记忆；同类问题出现第二次，升级成规则。收尾时如实报出没验证的部分 —— 那里通常就是你当前最真实的短板。",
].join("\n");

const identityPath = join(agentDir, "elenva-identity.json");
const historyDir = join(agentDir, "elenva-identity-history");
const readFile = (p) => readFileSync(p, "utf8");
const writeRaw = (content) => writeFileSync(identityPath, content, "utf8");
const bodyOf = (text) => ({ id: `s-${text.length}`, title: "测试段", body: text });

/* ============================ ① 隔离自证 ============================ */

check("① 隔离生效：路径落在临时 agentDir，初始为内置默认", () => {
  assert.equal(id.getIdentityPath(), resolve(agentDir, "elenva-identity.json"));
  assert.equal(id.getIdentityHistoryDir(), resolve(agentDir, "elenva-identity-history"));
  const current = id.readIdentity();
  assert.equal(current.source, "default");
  assert.equal(current.revision, "absent");
  assert.equal(existsSync(identityPath), false, "初始不应有身份文件");
});

/* ====================== ② 默认=现文逐字（迁移保证） ====================== */

check("② 内置默认拼回整块 === 改造前现文（逐字）", () => {
  assert.equal(id.buildIdentityText(id.DEFAULT_IDENTITY_SECTIONS), PINNED_IDENTITY);
  assert.equal(host.HOST_PROMPT_SECTIONS.find((s) => s.id === "identity").text, PINNED_IDENTITY);
});

check("②b 文件缺失时，装配出的身份段 === 现文（零行为变化）", () => {
  const section = host.hostPromptSections().find((s) => s.id === "identity");
  assert.equal(section.text, PINNED_IDENTITY);
  assert.equal(host.hostSystemPrompt(), host.buildHostPrompt(host.HOST_PROMPT_SECTIONS));
});

/* ============================ ③ 装配顺序 ============================ */

check("③ 身份在前、环境事实在后", () => {
  const prompt = host.hostSystemPrompt();
  assert.ok(prompt.startsWith(PINNED_IDENTITY), "宿主层必须以身份段开头");
  const envIndex = prompt.indexOf("## 运行环境（ELENVA Web 工作台）");
  assert.ok(envIndex > PINNED_IDENTITY.length, "环境段必须排在身份段之后");
});

/* ============================ ④ 读写 + 0600 ============================ */

check("④ 首次保存：落盘、0600、可读回，且旧值（内置默认）已快照", () => {
  const custom = [bodyOf("第一段：只改这一段。"), { id: "z", title: "第二段", body: "第二段：保留。" }];
  const result = id.writeIdentity({ sections: custom, revision: "absent" });
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  assert.equal(existsSync(identityPath), true);
  assert.equal((statSync(identityPath).mode & 0o777).toString(8), "600");
  const current = id.readIdentity();
  assert.equal(current.source, "file");
  assert.deepEqual(current.document.sections.map((s) => s.body), ["第一段：只改这一段。", "第二段：保留。"]);
  assert.equal(current.revision, result.revision);
  assert.ok(current.document.updatedAt, "应有 updatedAt");
  const history = id.listIdentityHistory();
  assert.equal(history.length, 1, "保存前应快照一条旧值");
  assert.equal(history[0].chars, PINNED_IDENTITY.length, "快照的是内置默认（旧值）");
});

/* ============================ ⑤ 并发 revision ============================ */

check("⑤ revision 不一致 → conflict，不覆盖", () => {
  const stale = id.writeIdentity({ sections: [bodyOf("不该写进去")], revision: "deadbeef" });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "conflict");
  assert.equal(id.readIdentity().document.sections[0].body, "第一段：只改这一段。");
});

/* ============================ ⑥ 校验 ============================ */

check("⑥ 校验：空段 / 超长段 / 超总量 / 空数组都拒", () => {
  const current = id.readIdentity().revision;
  assert.equal(id.writeIdentity({ sections: [], revision: current }).ok, false, "空数组应拒");
  assert.equal(id.writeIdentity({ sections: [bodyOf("   ")], revision: current }).ok, false, "空正文应拒");
  const longBody = "甲".repeat(id.IDENTITY_SECTION_BODY_LIMIT + 1);
  assert.equal(id.writeIdentity({ sections: [bodyOf(longBody)], revision: current }).ok, false, "超长单段应拒");
  // 总量超限：多段刚好都在单段上限内
  const many = Array.from({ length: 3 }, (_, i) => ({
    id: `m${i}`,
    title: "x",
    body: "乙".repeat(id.IDENTITY_SECTION_BODY_LIMIT),
  }));
  const over = id.writeIdentity({ sections: many, revision: current });
  assert.equal(over.ok, false);
  assert.equal(over.code, "over-limit");
});

/* ============================ ⑦ 损坏回退 ============================ */

check("⑦ 文件损坏 → 回退内置默认（不抛、不改文件）", () => {
  writeRaw("{ 这不是合法 JSON");
  const current = id.readIdentity();
  assert.equal(current.source, "fallback");
  assert.equal(current.error !== undefined, true);
  assert.deepEqual(current.document.sections, id.DEFAULT_IDENTITY_SECTIONS.map((s) => ({ ...s })));
  assert.equal(readFile(identityPath), "{ 这不是合法 JSON", "回退不应清空/改动损坏文件");
});

check("⑦b 损坏状态下保存：以默认值为旧值快照，并修复文件", () => {
  const beforeHistory = id.listIdentityHistory().length;
  const result = id.writeIdentity({ sections: [bodyOf("修复后的身份")], revision: id.readIdentity().revision });
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  assert.equal(id.readIdentity().source, "file");
  assert.equal(id.listIdentityHistory().length, beforeHistory + 1);
  const latest = id.readIdentityHistory(id.listIdentityHistory()[0].id);
  assert.deepEqual(latest.sections.map((s) => s.body), id.DEFAULT_IDENTITY_SECTIONS.map((s) => s.body), "旧的「生效默认」应被快照");
});

/* ============================ ⑧ 历史 cap ============================ */

check("⑧ 历史 cap 50：55 次保存后只留最近 50，最旧被淘汰", () => {
  // 先清空历史，避免前面用例的快照干扰计数
  for (const name of readdirSync(historyDir)) rmSync(join(historyDir, name), { force: true });
  const ids = [];
  for (let i = 0; i < 55; i += 1) {
    const result = id.writeIdentity({ sections: [bodyOf(`版本 ${i}`)], revision: id.readIdentity().revision });
    assert.equal(result.ok, true, result.ok ? "" : result.error);
    ids.push(result.snapshot);
  }
  const history = id.listIdentityHistory();
  assert.equal(history.length, id.IDENTITY_HISTORY_CAP);
  assert.equal(readdirSync(historyDir).length, id.IDENTITY_HISTORY_CAP, "磁盘上也只留 50 个快照文件");
  const oldestKept = history[history.length - 1].id;
  assert.ok(ids.indexOf(oldestKept) >= 0, "保留的应是最新的 50 条");
  assert.ok(history.some((h) => h.id === ids[ids.length - 1]), "最新一条应在列表里");
  assert.equal(history[0].id, ids[ids.length - 1], "列表按新→旧排序");
});

/* ============================ ⑨ 恢复链 ============================ */

check("⑨ 恢复：写回旧值；恢复本身也先快照当前值，可再撤回", () => {
  // 从干净状态开始：A → B → 恢复 A → 撤回回 B
  rmSync(identityPath, { force: true });
  for (const name of readdirSync(historyDir)) rmSync(join(historyDir, name), { force: true });

  const A = [bodyOf("A 版本")];
  const B = [bodyOf("B 版本")];
  assert.equal(id.writeIdentity({ sections: A, revision: "absent" }).ok, true);
  assert.equal(id.writeIdentity({ sections: B, revision: id.readIdentity().revision }).ok, true);

  const snapshotOfA = id.listIdentityHistory()[0].id; // 保存 B 前快照的是 A
  const restored = id.restoreIdentity(snapshotOfA, id.readIdentity().revision);
  assert.equal(restored.ok, true, restored.ok ? "" : restored.error);
  assert.equal(id.readIdentity().document.sections[0].body, "A 版本", "恢复后应回到 A");

  const snapshotOfB = id.listIdentityHistory()[0].id; // 恢复前快照的是 B
  const back = id.restoreIdentity(snapshotOfB, id.readIdentity().revision);
  assert.equal(back.ok, true, back.ok ? "" : back.error);
  assert.equal(id.readIdentity().document.sections[0].body, "B 版本", "再撤回应回到 B");
});

check("⑨b 恢复不存在的版本 / 非法 id → 拒绝", () => {
  assert.equal(id.restoreIdentity("../../etc/passwd").ok, false);
  assert.equal(id.restoreIdentity("2020-01-01T00-00-00-000Z").ok, false);
});

/* ============================ ⑩ 预览宽松清洗 ============================ */

check("⑩ 生效预览：宽松清洗非法段落，不抛", () => {
  const text = id.previewIdentityText([
    { id: "a", title: "ok", body: "保留" },
    { id: "b", body: "   " }, // 空 → 丢
    "不是对象", // 丢
  ]);
  assert.equal(text, `${id.IDENTITY_HEADING}\n\n保留`);
  assert.equal(id.previewIdentityText(undefined), "");
});

/* ============================ ⑪ 装配覆盖 ============================ */

check("⑪ 预览用装配函数：候选身份段替换后，环境段仍原样", () => {
  const withOne = [bodyOf("候选身份段")];
  const text = id.buildIdentityText(withOne);
  const sections = host.hostPromptSections().map((s) => (s.id === "identity" ? { ...s, text } : s));
  const assembled = host.buildHostPrompt(sections);
  assert.ok(assembled.startsWith(`${id.IDENTITY_HEADING}\n\n候选身份段`));
  assert.ok(assembled.includes("## 运行环境（ELENVA Web 工作台）"));
});

/* ============================ 汇总 ============================ */

try {
  rmSync(root, { recursive: true, force: true });
} catch {
  // 临时目录清理失败不影响结论
}

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
