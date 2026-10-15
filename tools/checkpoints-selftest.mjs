// checkpoints 回滚（整轮 / 文件级）的自检（lib/checkpoints.ts）。
// 运行：node tools/checkpoints-selftest.mjs
//
// 全部用**临时目录**做 workspace + 临时 agentDir（相关函数支持第二参 agentDir 覆盖），
// 不碰真实数据。用例数据均为虚构。
//
// 走 jiti 直载 .ts：lib/checkpoints.ts 里是**无扩展名**的相对导入在别处可能出现，
// jiti 能解析无扩展名 + `@/` 别名（该文件是纯 .ts，不含 JSX）。
import { createJiti } from "jiti";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const cp = await jiti.import("../lib/checkpoints.ts");

let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
  if (!ok) fail++;
};
const read = (path) => readFileSync(path, "utf8");

/** 每个用例独立临时环境：workspace + agentDir 都在临时目录里，跑完删除 */
function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), "elenva-cp-"));
  const ws = join(root, "ws");
  const agentDir = join(root, "agent");
  mkdirSync(ws, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  return { root, ws, agentDir };
}

/** 模拟一个子轮次：对每个写入先记录 preImage → 写盘 → 记录 postHash，返回 turnId */
function subTurn(env, sessionId, turnIndex, writes) {
  const ck = cp.openCheckpoint({ sessionId, cwd: env.ws, turnIndex }, env.agentDir);
  for (const w of writes) {
    cp.recordFilePreImage({ sessionId, turnId: ck.id, filePath: w.path, tool: "write" }, env.agentDir);
    writeFileSync(w.path, w.content);
    cp.recordFilePostHash({ sessionId, turnId: ck.id, filePath: w.path }, env.agentDir);
  }
  return ck.id;
}

// ① 单次触碰的修改文件 → 还原到原内容
{
  const env = makeEnv();
  const sid = "case1";
  const f = join(env.ws, "a.txt");
  writeFileSync(f, "原内容");
  const t = subTurn(env, sid, 0, [{ path: f, content: "改后" }]);
  const r = cp.restoreCheckpoint({ sessionId: sid, turnId: t }, env.agentDir);
  check("① 修改文件被还原", r.restored.includes(f), `restored=${r.restored.length}`);
  check("① 内容回到原内容", read(f) === "原内容", read(f));
  check("① 无跳过", r.skipped.length === 0, JSON.stringify(r.skipped));
  rmSync(env.root, { recursive: true, force: true });
}

// ② 新建文件 → 删除
{
  const env = makeEnv();
  const sid = "case2";
  const f = join(env.ws, "new.txt");
  const t = subTurn(env, sid, 0, [{ path: f, content: "新建内容" }]);
  const r = cp.restoreCheckpoint({ sessionId: sid, turnId: t }, env.agentDir);
  check("② 新建文件被删除", r.deleted.includes(f), `deleted=${r.deleted.length}`);
  check("② 文件已不在磁盘", !existsSync(f));
  rmSync(env.root, { recursive: true, force: true });
}

// ③ 漂移（录制后外部改写）→ 跳过、内容不动
{
  const env = makeEnv();
  const sid = "case3";
  const f = join(env.ws, "a.txt");
  writeFileSync(f, "原内容");
  const t = subTurn(env, sid, 0, [{ path: f, content: "改后" }]);
  writeFileSync(f, "外部又改");
  const r = cp.restoreCheckpoint({ sessionId: sid, turnId: t }, env.agentDir);
  check("③ 漂移文件被跳过", r.skipped.some((s) => s.path === f && s.reason.includes("又被改动")), JSON.stringify(r.skipped));
  check("③ 外部内容未被覆盖", read(f) === "外部又改", read(f));
  check("③ 未被还原", r.restored.length === 0, `restored=${r.restored.length}`);
  rmSync(env.root, { recursive: true, force: true });
}

// ④ paths 过滤 → 只动命中文件、其余不动
{
  const env = makeEnv();
  const sid = "case4";
  const a = join(env.ws, "a.txt");
  const b = join(env.ws, "b.txt");
  writeFileSync(a, "A 原");
  writeFileSync(b, "B 原");
  const t = subTurn(env, sid, 0, [{ path: a, content: "A 改" }, { path: b, content: "B 改" }]);
  const r = cp.restoreCheckpoint({ sessionId: sid, turnId: t, paths: [a] }, env.agentDir);
  check("④ 只还原命中文件", r.restored.length === 1 && r.restored[0] === a, `restored=${JSON.stringify(r.restored)}`);
  check("④ 命中文件回到原内容", read(a) === "A 原", read(a));
  check("④ 未命中文件一动不动", read(b) === "B 改", read(b));
  rmSync(env.root, { recursive: true, force: true });
}

// ⑤ 不传 paths → 与现状一致（整轮）
{
  const env = makeEnv();
  const sid = "case5";
  const a = join(env.ws, "a.txt");
  const b = join(env.ws, "b.txt");
  writeFileSync(a, "A 原");
  writeFileSync(b, "B 原");
  const t = subTurn(env, sid, 0, [{ path: a, content: "A 改" }, { path: b, content: "B 改" }]);
  const r = cp.restoreCheckpoint({ sessionId: sid, turnId: t }, env.agentDir);
  check("⑤ 整轮还原两个文件", r.restored.length === 2, `restored=${r.restored.length}`);
  check("⑤ 两个文件均回到原内容", read(a) === "A 原" && read(b) === "B 原");
  check("⑤ 无跳过", r.skipped.length === 0, JSON.stringify(r.skipped));
  rmSync(env.root, { recursive: true, force: true });
}

// ⑥ 跨子轮次（同一文件在两个子轮次各写一次）→ 按新→旧带 filter 级联 → 回到最初内容
{
  const env = makeEnv();
  const sid = "case6";
  const f = join(env.ws, "a.txt");
  writeFileSync(f, "最初");
  const t1 = subTurn(env, sid, 0, [{ path: f, content: "v1" }]);
  const t2 = subTurn(env, sid, 1, [{ path: f, content: "v2" }]);
  // 与客户端 restoreFile 同构：新 → 旧逐个子轮次带 paths 过滤
  for (const id of [t2, t1]) {
    cp.restoreCheckpoint({ sessionId: sid, turnId: id, paths: [f] }, env.agentDir);
  }
  check("⑥ 级联后回到最初内容", read(f) === "最初", read(f));
  rmSync(env.root, { recursive: true, force: true });
}

// ⑦ paths 未命中 → 空结果、无副作用
{
  const env = makeEnv();
  const sid = "case7";
  const f = join(env.ws, "a.txt");
  writeFileSync(f, "原内容");
  const t = subTurn(env, sid, 0, [{ path: f, content: "改后" }]);
  const r = cp.restoreCheckpoint({ sessionId: sid, turnId: t, paths: [join(env.ws, "不存在.txt")] }, env.agentDir);
  check("⑦ 空结果", r.restored.length === 0 && r.deleted.length === 0 && r.skipped.length === 0, JSON.stringify(r));
  check("⑦ 无副作用", read(f) === "改后", read(f));
  rmSync(env.root, { recursive: true, force: true });
}

console.log(fail === 0 ? "\nSELFTEST: OK" : `\nSELFTEST: ${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
