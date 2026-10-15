// 节律会话注册表（lib/scheduled-sessions.ts）的自检：
// 默认档 / 三档读写往返 / 非法档回落 / 过期自动失效 / clear 后的审计窗口与档位保留 /
// list 剪枝 / 空 id 静默跳过。
// 运行：node tools/scheduled-sessions-selftest.mjs
//
// 隔离：纯 globalThis 注册表 + 类型导入（无 node:* / 无 SDK 依赖），
// 用 jiti 直载 TS；不碰磁盘、不碰真实 ~/.pi/agent。
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const lib = await jiti.import("../lib/scheduled-sessions.ts");
const {
  markScheduledSession,
  clearScheduledSession,
  isScheduledSession,
  getScheduledSessionTier,
  listScheduledSessionIds,
  SCHEDULED_SESSION_TTL_MS,
  SCHEDULED_SESSION_GRACE_MS,
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
const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};
const eq = (actual, expected, message) =>
  assert(actual === expected, `${message}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);

/** 每条用例用独立 id，避免用例互相污染（注册表是进程级单例） */
let seq = 0;
const sid = () => `sess-${++seq}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ============================ 基本登记 ============================ */

check("未登记 → isScheduledSession=false / tier=null", () => {
  const id = sid();
  eq(isScheduledSession(id), false, "未登记应为 false");
  eq(getScheduledSessionTier(id), null, "未登记档位应为 null");
});

check("默认档：mark 不带 tier → standard", () => {
  const id = sid();
  markScheduledSession(id);
  eq(isScheduledSession(id), true, "登记后应为 true");
  eq(getScheduledSessionTier(id), "standard", "默认档");
});

check("只读档：登记 / 读回", () => {
  const id = sid();
  markScheduledSession(id, "readonly");
  eq(getScheduledSessionTier(id), "readonly", "档位读回");
  eq(isScheduledSession(id), true, "仍在标记期");
});

check("全权档：登记 / 读回", () => {
  const id = sid();
  markScheduledSession(id, "full");
  eq(getScheduledSessionTier(id), "full", "档位读回");
});

check("重复登记覆盖档位", () => {
  const id = sid();
  markScheduledSession(id, "readonly");
  markScheduledSession(id, "full");
  eq(getScheduledSessionTier(id), "full", "后写覆盖");
  markScheduledSession(id);
  eq(getScheduledSessionTier(id), "standard", "再覆盖回默认");
});

check("非法档位回落 standard", () => {
  const id = sid();
  markScheduledSession(id, "yolo");
  eq(getScheduledSessionTier(id), "standard", "非法值回落");
});

check("空 / 非法 id 静默跳过", () => {
  const before = listScheduledSessionIds().length;
  markScheduledSession("");
  markScheduledSession("   ");
  markScheduledSession(null);
  markScheduledSession(undefined);
  eq(listScheduledSessionIds().length, before, "不新增条目");
  eq(getScheduledSessionTier(""), null, "空 id 读回 null");
});

/* ============================ 过期与审计窗口 ============================ */

check("过期：TTL 到点后 isScheduledSession=false、tier=null", async () => {
  const id = sid();
  markScheduledSession(id, "readonly", 30);
  eq(isScheduledSession(id), true, "窗口内为真");
  await sleep(60);
  eq(isScheduledSession(id), false, "过期为假");
  eq(getScheduledSessionTier(id), null, "过期档位为 null");
});

check("clear：收敛为审计窗口，档位保留", () => {
  const id = sid();
  markScheduledSession(id, "full", SCHEDULED_SESSION_TTL_MS);
  clearScheduledSession(id);
  eq(isScheduledSession(id), true, "清除后仍在审计窗口");
  eq(getScheduledSessionTier(id), "full", "档位随审计窗口保留");
});

check("clear：短窗口到点后失效", async () => {
  const id = sid();
  markScheduledSession(id, "readonly");
  clearScheduledSession(id, 30);
  eq(isScheduledSession(id), true, "窗口内为真");
  await sleep(60);
  eq(isScheduledSession(id), false, "窗口过后为假");
  eq(getScheduledSessionTier(id), null, "窗口过后档位为 null");
});

check("clear：未登记 id 不抛、不凭空登记", () => {
  const id = sid();
  clearScheduledSession(id);
  eq(isScheduledSession(id), false, "不存在的 id 不会被登记");
  eq(listScheduledSessionIds().includes(id), false, "也不进列表");
});

/* ============================ 列表与剪枝 ============================ */

check("list：登记项可见，过期项被剪掉", async () => {
  const alive = sid();
  const dead = sid();
  markScheduledSession(alive, "readonly");
  markScheduledSession(dead, "full", 20);
  let ids = listScheduledSessionIds();
  assert(ids.includes(alive), "未过期项应在列表");
  assert(ids.includes(dead), "窗口内项应在列表");
  await sleep(50);
  ids = listScheduledSessionIds();
  assert(ids.includes(alive), "未过期项仍在");
  eq(ids.includes(dead), false, "过期项被剪掉");
});

check("TTL 常量自洽（审计窗口与默认 TTL 均为正）", () => {
  assert(SCHEDULED_SESSION_TTL_MS > 0, "TTL 应为正");
  assert(SCHEDULED_SESSION_GRACE_MS > 0, "审计窗口应为正");
});

/* ============================ 收尾 ============================ */

console.log(fail === 0 ? "\n全部通过" : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
