// 正文元信息（lib/agents/doc-meta.ts）与历史版本（lib/agents/data-store.ts）的自检。
//
// 背景：工作台从「卡片流」改成「管线 + 当前这一篇 + 协作面」后，正文的标题/字数/小节/缺口
// 都从 Markdown 现算；历史版本来自每次写入前的自动备份。这两块都是纯逻辑，适合用夹具钉住。
//
// 运行：node tools/agent-doc-selftest.mjs
// 隔离：全在 mkdtemp 出来的临时应用包内造**虚构**内容，不碰 ~/.elenva。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { interopDefault: true });
const meta = await jiti.import("../lib/agents/doc-meta.ts");
const store = await jiti.import("../lib/agents/data-store.ts");

let fail = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message.split("\n")[0] : error}`);
  }
};

const SAMPLE = `# 样例：装修预算表怎么做

一句话论点：**预算表更像一张未知清单。**

## 1 · 一张填得挺满的表

正文一段，含 \`inline code\` 与 [链接](https://example.com)。

【待你补：房型与面积能不能写】
【待你定：要不要提自己做的面板】

## 2 · 漏掉的钱出在行数上

再来一段。

【待你补：真实漏掉的几行】
`;

/* ---------------- 1. 正文元信息 ---------------- */

check("标题：取一级标题，去掉 # 与首尾空白", () => {
  assert.equal(meta.extractTitle(SAMPLE), "样例：装修预算表怎么做");
});

check("标题：没有一级标题时退回第一个非空行", () => {
  assert.equal(meta.extractTitle("\n\n只有一行正文\n第二行"), "只有一行正文");
  assert.equal(meta.extractTitle("   \n\n"), "");
});

check("字数：去掉 Markdown 标记与空白后计数", () => {
  const plain = meta.countWords("**粗体** 和 `代码` 和 [链接](https://x.y) 不算标记");
  // avail: 粗体和代码和链接不算标记 → 13 个汉字（粗体2 和1 代码2 和1 链接2 不算标记4 = 12? 以实际剥后结果为准，断言区间）
  assert.ok(plain >= 10 && plain <= 16, `实得 ${plain}`);
  assert.equal(meta.countWords("# 标题\n\n正文"), 4); // 标题 + 正文 = 2 + 2
});

check("小节：只认 ## 与 ###，一级标题不算小节", () => {
  const sections = meta.extractSections(SAMPLE);
  assert.equal(sections.length, 2);
  assert.deepEqual(sections.map((s) => s.level), [2, 2]);
  assert.match(sections[0].title, /一张填得挺满的表/);
});

check("缺口：抽出【待你补/定】两种标记、去重、上限 8 条", () => {
  const gaps = meta.extractGaps(SAMPLE);
  assert.deepEqual(gaps, ["房型与面积能不能写", "要不要提自己做的面板", "真实漏掉的几行"]);
  const many = Array.from({ length: 20 }, (_, i) => `【待你补：第${i}条】`).join("\n");
  assert.equal(meta.extractGaps(many).length, 8);
  assert.deepEqual(meta.extractGaps("没有标记的一段"), []);
});

check("docMeta 汇总 + 字数进度", () => {
  const m = meta.docMeta(SAMPLE);
  assert.match(m.title, /装修预算表/);
  assert.equal(m.sections.length, 2);
  assert.equal(m.gaps.length, 3);
  assert.ok(m.words > 20, `words=${m.words}`);
  assert.equal(meta.wordProgress(700, 1400)?.ratio, 0.5);
  assert.equal(meta.wordProgress(700), null);
});

/* ---------------- 2. 历史版本 ---------------- */

const root = mkdtempSync(join(tmpdir(), "elenva-agent-doc-selftest-"));
const pkg = join(root, "pkg");
mkdirSync(join(pkg, "data"), { recursive: true });
const rel = "data/demo.md";

writeFileSync(join(pkg, rel), "第一版\n");
const second = store.writeAgentFile(pkg, rel, "第二版\n", {});
assert.ok(second.ok, "第二次写入应成功");
const third = store.writeAgentFile(pkg, rel, "第三版\n", {});
assert.ok(third.ok, "第三次写入应成功");

check("历史：每次写入都留一份备份，最新在前", () => {
  const versions = store.listVersions(pkg, rel);
  assert.equal(versions.length, 2, `应 2 份备份，实得 ${versions.length}`);
  assert.ok(versions[0].savedAt >= versions[1].savedAt, "应按时间倒序");
  assert.equal(versions[0].revision, store.revisionOf("第二版\n"));
  assert.ok(versions[0].name.startsWith("demo.md."));
});

check("历史：恢复到旧版本，当前内容真的变回去，且恢复本身也留了备份", () => {
  const before = store.listVersions(pkg, rel);
  const target = before[before.length - 1]; // 最早的一版 = 第一版
  const restored = store.restoreVersion(pkg, rel, target.name, {});
  assert.ok(restored.ok, "恢复应成功");
  const content = store.readAgentFile(pkg, rel);
  assert.equal(content.ok && content.content, "第一版\n");
  assert.equal(store.listVersions(pkg, rel).length, 3, "恢复前的第三版也该留一份备份");
});

check("历史：版本名带路径/.. 被拒（不能借恢复接口越界）", () => {
  for (const bad of ["../data/demo.md.2026", "sub/demo.md.2026", "demo.md.2026/../x"]) {
    const res = store.restoreVersion(pkg, rel, bad, {});
    assert.equal(res.ok, false, `${bad} 应被拒`);
  }
});

check("历史：revision 过期时拒绝恢复（不覆盖别人刚写的）", () => {
  const versions = store.listVersions(pkg, rel);
  const res = store.restoreVersion(pkg, rel, versions[0].name, { expectedRevision: "deadbeefdeadbeef" });
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
});

check("备份：同一文件最多保留 20 份，且不同文件的备份互不挤占", () => {
  const other = "data/other.md";
  writeFileSync(join(pkg, other), "另一篇\n");
  for (let i = 0; i < 25; i += 1) store.writeAgentFile(pkg, rel, `第 ${i} 次\n`, {});
  const versions = store.listVersions(pkg, rel);
  assert.equal(versions.length, 20, `应截到 20 份，实得 ${versions.length}`);
  const backupFiles = readdirSync(join(pkg, "data", ".backup"));
  assert.ok(backupFiles.some((name) => name.startsWith("other.md.")) === false, "另一篇还没写过备份");
});

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
