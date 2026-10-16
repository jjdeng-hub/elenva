// 项目级审批策略（lib/guardrail-policy.ts）的自检：
// 纯函数层（继承 / 覆盖 / 非法值 / key 写法）+ 决策层等价性（无项目配置 == 旧直读全局）
// + 磁盘层（读写容错 / key 规范化 / 补丁语义）+ 调用点静态核对。
// 运行：node tools/project-policy-selftest.mjs
//
// 隔离：PI_CODING_AGENT_DIR 指向 mkdtemp 出来的临时目录，全用**虚构**数据，
// 不碰真实 ~/.pi/agent。lib/*.ts 是纯 TS（无 JSX），jiti 可直载（见记忆 F1/F3）。
import { createJiti } from "jiti";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "elenva-project-policy-selftest-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const policy = await jiti.import("../lib/guardrail-policy.ts");
const {
  parseProjectPolicy,
  parsePolicyByProject,
  parsePolicyPatch,
  policyPathKey,
  findProjectPolicy,
  resolvePolicy,
  isApprovalMode,
  isApprovalFallback,
} = policy;
const settingsLib = await jiti.import("../lib/guardrail-settings.ts");
const {
  DEFAULT_GUARDRAIL_SETTINGS,
  readGuardrailSettings,
  writeProjectPolicy,
  getGuardrailSettingsPath,
} = settingsLib;
const { needsApproval } = await jiti.import("../lib/tool-risk.ts");

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
/** 异步用例（路由层）：同样的 PASS/FAIL 口径 */
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

const settingsPath = () => join(agentDir, "elenva-guardrails.json");

// 全局基线（与 DEFAULT_GUARDRAIL_SETTINGS 同形，但刻意换一组值，
// 免得「等于默认值」冒充「等于全局值」）
const global = {
  approvalMode: "writes",
  approvalFallback: "queue",
  mcpWriteApproval: false,
  policyByProject: {},
};
const CWDS = [
  "/home/demo/pi-workspace",
  "/home/demo/pi-workspace/",
  "D:\\demo\\repo",
  "D:/demo/repo",
  "",
  "/",
  "/home/demo/pi-workspace/sub",
];

/* ---------------- 1. 值层解析（读盘容错） ---------------- */

check("parseProjectPolicy：合法三键全收", () => {
  const parsed = parseProjectPolicy({ approvalMode: "off", approvalFallback: "queue", mcpWriteApproval: true });
  assert(parsed !== null, "应返回策略对象");
  eq(parsed.approvalMode, "off", "approvalMode");
  eq(parsed.approvalFallback, "queue", "approvalFallback");
  eq(parsed.mcpWriteApproval, true, "mcpWriteApproval");
});

check("parseProjectPolicy：部分键保留（其余缺省 = 继承）", () => {
  const parsed = parseProjectPolicy({ approvalMode: "risky" });
  assert(parsed !== null, "应返回策略对象");
  eq(Object.keys(parsed).length, 1, "只应有一个键");
  eq(parsed.approvalMode, "risky", "approvalMode");
  assert(!("approvalFallback" in parsed), "未写的键不应出现（否则就成了显式覆盖）");
});

check("parseProjectPolicy：非法值逐键丢弃，全非法 → null", () => {
  eq(parseProjectPolicy({ approvalMode: "strict", mcpWriteApproval: "yes" }), null, "全非法应为 null");
  const partial = parseProjectPolicy({ approvalMode: "strict", mcpWriteApproval: false });
  assert(partial !== null, "至少一个合法键就保留");
  eq(partial.mcpWriteApproval, false, "合法键保留");
  assert(!("approvalMode" in partial), "非法键丢弃");
  for (const bad of [null, undefined, 42, "x", [], true]) {
    eq(parseProjectPolicy(bad), null, `非对象 ${JSON.stringify(bad)} 应为 null`);
  }
});

check("parsePolicyByProject：坏条目忽略、空 key 忽略、整表非对象 → {}", () => {
  const parsed = parsePolicyByProject({
    "/a": { approvalMode: "off" },
    "/b": { approvalMode: "nope" },
    "/c": {},
    "": { approvalMode: "writes" },
    "/d": "string",
  });
  eq(Object.keys(parsed).sort().join(","), "/a", "只应留下真正有合法键的条目");
  for (const bad of [null, undefined, [], "x", 7]) {
    eq(Object.keys(parsePolicyByProject(bad)).length, 0, "非对象整表应为空");
  }
});

check("isApprovalMode / isApprovalFallback：只认白名单", () => {
  assert(isApprovalMode("off") && isApprovalMode("risky") && isApprovalMode("writes"), "合法档位");
  assert(!isApprovalMode("strict") && !isApprovalMode("") && !isApprovalMode(1), "非法档位");
  assert(isApprovalFallback("reject") && isApprovalFallback("queue"), "合法回落");
  assert(!isApprovalFallback("deny") && !isApprovalFallback(null), "非法回落");
});

check("parsePolicyPatch：整条 null = 清除；单键 null = 回到继承（必须传下去）；非法值报错", () => {
  const cleared = parsePolicyPatch(null);
  assert(cleared.ok, "null 合法");
  eq(cleared.patch, null, "整条 null → 整条清除");
  const ok = parsePolicyPatch({ approvalMode: "off", mcpWriteApproval: false });
  assert(ok.ok, "合法补丁");
  eq(ok.patch.approvalMode, "off", "approvalMode");
  eq(ok.patch.mcpWriteApproval, false, "mcpWriteApproval");
  assert(!("approvalFallback" in ok.patch), "没传的键不进补丁");
  // 回归点（复核复现的那个 bug）：null 必须原样进补丁。
  // 早先这里写成「键存在但值为 null 就跳过」→ 下游收到空补丁 {} → 单键回退静默失效。
  for (const key of ["approvalMode", "approvalFallback", "mcpWriteApproval"]) {
    const onlyNull = parsePolicyPatch({ [key]: null });
    assert(onlyNull.ok, `${key}: 单独传 null 应合法`);
    assert(key in onlyNull.patch, `${key}: null 必须保留在补丁里（否则下游不知道要删）`);
    eq(onlyNull.patch[key], null, `${key}: 值应为 null`);
    eq(Object.keys(onlyNull.patch).length, 1, `${key}: 不应扩散到其它键`);
  }
  const mixed = parsePolicyPatch({ approvalMode: null, approvalFallback: "queue" });
  assert(mixed.ok, "null 与合法值可以混传");
  eq(mixed.patch.approvalMode, null, "null 原样");
  eq(mixed.patch.approvalFallback, "queue", "合法值照常");
  assert(!("mcpWriteApproval" in mixed.patch), "没传的键仍不进补丁");
  for (const bad of [{ approvalMode: "strict" }, { approvalFallback: "deny" }, { mcpWriteApproval: "on" }, { approvalMode: undefined }, "x", 3]) {
    const result = parsePolicyPatch(bad);
    assert(!result.ok, `${JSON.stringify(bad)} 应报错`);
  }
});

/* ---------------- 2. 解析：项目 > 全局（三键独立） ---------------- */

check("policyPathKey：统一分隔符 / 去尾斜杠，不改大小写", () => {
  eq(policyPathKey("C:\\x\\y\\"), "C:/x/y", "反斜杠");
  eq(policyPathKey("/a/b//"), "/a/b", "尾斜杠");
  eq(policyPathKey("  /a/b  "), "/a/b", "空白");
  eq(policyPathKey("/Root/A"), "/Root/A", "大小写必须保留（Linux 路径敏感）");
});

check("无项目配置：三键严格等于全局值（默认路径等价）", () => {
  for (const cwd of CWDS) {
    const resolved = resolvePolicy(global, cwd);
    eq(resolved.approvalMode, global.approvalMode, `approvalMode @ ${JSON.stringify(cwd)}`);
    eq(resolved.approvalFallback, global.approvalFallback, `approvalFallback @ ${JSON.stringify(cwd)}`);
    eq(resolved.mcpWriteApproval, global.mcpWriteApproval, `mcpWriteApproval @ ${JSON.stringify(cwd)}`);
    eq(resolved.projectKey, null, `projectKey @ ${JSON.stringify(cwd)}`);
  }
  const defaults = resolvePolicy(DEFAULT_GUARDRAIL_SETTINGS, "/home/demo/pi-workspace");
  eq(defaults.approvalMode, DEFAULT_GUARDRAIL_SETTINGS.approvalMode, "默认档位");
  eq(defaults.approvalFallback, DEFAULT_GUARDRAIL_SETTINGS.approvalFallback, "默认回落");
  eq(defaults.mcpWriteApproval, DEFAULT_GUARDRAIL_SETTINGS.mcpWriteApproval, "默认 MCP 开关");
});

check("命中的项目覆盖单键，其余仍继承全局", () => {
  const settings = {
    ...global,
    policyByProject: { "/home/demo/pi-workspace": { approvalMode: "risky" } },
  };
  const hit = resolvePolicy(settings, "/home/demo/pi-workspace");
  eq(hit.approvalMode, "risky", "项目值生效");
  eq(hit.approvalFallback, global.approvalFallback, "未覆盖的键继承全局");
  eq(hit.mcpWriteApproval, global.mcpWriteApproval, "未覆盖的键继承全局");
  eq(hit.projectKey, "/home/demo/pi-workspace", "命中 key");
  // 兄弟目录 / 子目录不受影响（策略按精确项目目录生效，不做前缀继承）
  const other = resolvePolicy(settings, "/home/demo/pi-workspace/sub");
  eq(other.projectKey, null, "子目录不继承");
  const sibling = resolvePolicy(settings, "/home/demo/other");
  eq(sibling.approvalMode, global.approvalMode, "别的项目仍是全局值");
});

check("三键全覆盖时全部取项目值", () => {
  const settings = {
    ...global,
    policyByProject: {
      "/home/demo/pi-workspace": { approvalMode: "off", approvalFallback: "reject", mcpWriteApproval: true },
    },
  };
  const hit = resolvePolicy(settings, "/home/demo/pi-workspace");
  eq(hit.approvalMode, "off", "approvalMode");
  eq(hit.approvalFallback, "reject", "approvalFallback");
  eq(hit.mcpWriteApproval, true, "mcpWriteApproval");
});

check("key 写法差异（反斜杠 / 尾斜杠 / 大小写）都能命中", () => {
  const windows = {
    ...global,
    policyByProject: { "d:/demo/repo": { approvalMode: "off" } },
  };
  const winOpt = { caseInsensitiveKeys: true };
  eq(resolvePolicy(windows, "D:\\demo\\repo", winOpt).approvalMode, "off", "盘符大小写 + 反斜杠");
  eq(resolvePolicy(windows, "D:/demo/repo/", winOpt).approvalMode, "off", "尾斜杠");
  eq(findProjectPolicy(windows.policyByProject, "D:/DEMO/REPO", winOpt).key, "d:/demo/repo", "全大写也能兜底命中");
  // Linux：不忽略大小写 —— /Home/Demo 与 /home/demo 是两个不同目录，串台等于把档位套错项目
  const linux = { ...global, policyByProject: { "/Home/Demo": { approvalMode: "off" } } };
  eq(findProjectPolicy(linux.policyByProject, "/home/demo"), null, "Linux 上大小写不同不串台");
  eq(resolvePolicy(linux, "/home/demo").projectKey, null, "未命中 → 不算命中");
  eq(resolvePolicy(linux, "/Home/Demo").approvalMode, "off", "大小写完全一致时照常命中");
  eq(resolvePolicy(linux, "/Home/Demo/extra").projectKey, null, "不做前缀继承");
});

check("非法项目值（手写坏文件）→ 回落全局", () => {
  const settings = {
    ...global,
    policyByProject: { "/home/demo/pi-workspace": { approvalMode: "strict", mcpWriteApproval: "yes" } },
  };
  const resolved = resolvePolicy(settings, "/home/demo/pi-workspace");
  eq(resolved.approvalMode, global.approvalMode, "非法档位回落全局");
  eq(resolved.mcpWriteApproval, global.mcpWriteApproval, "非法布尔回落全局");
  eq(resolved.projectKey, null, "整条判为无效 → 不算命中");
});

/* ---------------- 3. 决策层等价性（无项目配置 == 旧直读全局） ---------------- */

const RISKS = [];
for (const level of ["safe", "guarded", "destructive"]) {
  for (const confirmInRisky of [undefined, true]) {
    for (const mcpWrite of [undefined, true]) {
      RISKS.push({ level, reason: "x", ruleKey: `${level}-${confirmInRisky}-${mcpWrite}`, ruleLabel: "x", ...(confirmInRisky ? { confirmInRisky } : {}), ...(mcpWrite ? { mcpWrite } : {}) });
    }
  }
}

check(`决策层等价：${RISKS.length} 种风险 × 全局组合，新旧判定逐一相同`, () => {
  const modes = ["off", "risky", "writes"];
  const fallbacks = ["reject", "queue"];
  const mcpFlags = [true, false];
  const cwds = ["/home/demo/pi-workspace", "/home/demo/other", ""];
  // 项目表里放的是**别的项目**（不对任何测试 cwd 命中），模拟「没配项目策略」
  const settings = {
    approvalMode: "risky",
    approvalFallback: "reject",
    mcpWriteApproval: true,
    policyByProject: { "/somewhere/else": { approvalMode: "off" } },
  };
  let compared = 0;
  for (const mode of modes) {
    for (const fallback of fallbacks) {
      for (const mcpFlag of mcpFlags) {
        const globals = { ...settings, approvalMode: mode, approvalFallback: fallback, mcpWriteApproval: mcpFlag };
        for (const cwd of cwds) {
          const resolved = resolvePolicy(globals, cwd);
          for (const risk of RISKS) {
            // 旧路径（现状）：先看 MCP 开关，再看档位
            const oldBlocked = !(risk.mcpWrite === true && !globals.mcpWriteApproval)
              && needsApproval(risk, globals.approvalMode);
            // 新路径：同样两步，只是三个值来自 resolvePolicy
            const newBlocked = !(risk.mcpWrite === true && !resolved.mcpWriteApproval)
              && needsApproval(risk, resolved.approvalMode);
            eq(newBlocked, oldBlocked, `拦不拦 @ ${mode}/${risk.level}/mcp=${risk.mcpWrite === true}`);
            eq(resolved.approvalFallback, globals.approvalFallback, `拦下之后 @ ${mode}/${fallback}`);
            compared += 1;
          }
        }
      }
    }
  }
  assert(compared === 3 * 2 * 2 * 3 * RISKS.length, `比较次数应为全矩阵（实际 ${compared}）`);
});

check("决策层：项目覆盖真的改变判定（放全权 / 加严各一例）", () => {
  const settings = {
    approvalMode: "risky",
    approvalFallback: "reject",
    mcpWriteApproval: true,
    policyByProject: {
      "/trusted": { approvalMode: "off" },
      "/strict": { approvalMode: "writes" },
    },
  };
  const guarded = { level: "guarded", reason: "x", ruleKey: "g", ruleLabel: "g", confirmInRisky: true };
  eq(needsApproval(guarded, resolvePolicy(settings, "/normal").approvalMode), true, "默认项目仍拦");
  eq(needsApproval(guarded, resolvePolicy(settings, "/trusted").approvalMode), false, "放行的项目不拦");
  eq(needsApproval(guarded, resolvePolicy(settings, "/strict").approvalMode), true, "加严的项目仍拦");
  const safe = { level: "safe", reason: "", ruleKey: "", ruleLabel: "" };
  eq(needsApproval(safe, resolvePolicy(settings, "/strict").approvalMode), false, "safe 档一律不打扰");
});

/* ---------------- 4. 磁盘层（guardrail-settings） ---------------- */

const writeSettings = (value) => writeFileSync(settingsPath(), JSON.stringify(value), "utf8");

check("读盘：缺字段 → 空表；非法值忽略；key 规范化", () => {
  const path = settingsPath();
  writeSettings({
    approvalMode: "off",
    policyByProject: {
      "/a/": { approvalMode: "risky" },
      "/b": { approvalMode: "nope", approvalFallback: "queue" },
      "/c": {},
      "/d": "x",
    },
  });
  const settings = readGuardrailSettings(path);
  eq(settings.approvalMode, "off", "全局档位仍照旧读");
  eq(Object.keys(settings.policyByProject).sort().join(","), "/a,/b", "只留有合法键的项目");
  eq(settings.policyByProject["/a"].approvalMode, "risky", "尾斜杠被规范化");
  eq(settings.policyByProject["/b"].approvalFallback, "queue", "非法键丢弃、合法键保留");
  assert(!("approvalMode" in settings.policyByProject["/b"]), "非法 approvalMode 必须被丢掉");
  // 存的是策略，解析仍按项目 > 全局
  eq(resolvePolicy(settings, "/a").approvalMode, "risky", "读盘后的解析");
  eq(resolvePolicy(settings, "/b").approvalMode, "off", "被丢掉的键回落全局");
});

check("读盘：损坏文件 / 老文件（无 policyByProject）都回落默认且不抛", () => {
  writeFileSync(settingsPath(), "{ 坏掉的 json", "utf8");
  const broken = readGuardrailSettings(settingsPath());
  eq(broken.approvalMode, DEFAULT_GUARDRAIL_SETTINGS.approvalMode, "损坏 → 默认档位");
  eq(Object.keys(broken.policyByProject).length, 0, "损坏 → 空项目表");
  writeSettings({ approvalMode: "risky", allowByProject: { "/a": ["git-push"] } });
  const legacy = readGuardrailSettings(settingsPath());
  eq(Object.keys(legacy.policyByProject).length, 0, "老文件没有该字段 → 空表（加字段是 additive）");
  eq(legacy.allowByProject["/a"][0], "git-push", "allowByProject 语义不动");
});

check("写入：补丁只改传进来的键，null 回到继承", () => {
  const path = settingsPath();
  rmSync(path, { force: true });
  let settings = writeProjectPolicy("/proj", { approvalMode: "off" }, path);
  eq(settings.policyByProject["/proj"].approvalMode, "off", "首次写入");
  settings = writeProjectPolicy("/proj", { mcpWriteApproval: false }, path);
  eq(settings.policyByProject["/proj"].approvalMode, "off", "旧键保留（补丁不是整条替换）");
  eq(settings.policyByProject["/proj"].mcpWriteApproval, false, "新键写入");
  settings = writeProjectPolicy("/proj", { approvalMode: null }, path);
  assert(!("approvalMode" in settings.policyByProject["/proj"]), "null → 回到继承");
  eq(settings.policyByProject["/proj"].mcpWriteApproval, false, "另一个键不受影响");
  eq(resolvePolicy(settings, "/proj").approvalMode, settings.approvalMode, "回到继承后等于全局");
});

check("写入：清空最后一项时删掉整条 key；cwd 为空不改文件", () => {
  const path = settingsPath();
  rmSync(path, { force: true });
  writeProjectPolicy("/proj", { approvalMode: "off" }, path);
  let settings = writeProjectPolicy("/proj", null, path);
  eq(Object.keys(settings.policyByProject).length, 0, "整条清除");
  writeProjectPolicy("/proj", { approvalMode: "off" }, path);
  settings = writeProjectPolicy("/proj", { approvalMode: null, mcpWriteApproval: null }, path);
  eq(Object.keys(settings.policyByProject).length, 0, "逐键清空后不应留空对象");
  writeProjectPolicy("/proj", { approvalMode: "off" }, path);
  const before = readFileSync(path, "utf8");
  settings = writeProjectPolicy("", { approvalMode: "writes" }, path);
  eq(Object.keys(settings.policyByProject).length, 1, "空 cwd 不新增");
  eq(readFileSync(path, "utf8"), before, "空 cwd 不改文件内容");
});

check("写入：不同项目互不影响，key 写法归一（同一目录不产生两条）", () => {
  const path = settingsPath();
  rmSync(path, { force: true });
  writeProjectPolicy("/p1", { approvalMode: "off" }, path);
  let settings = writeProjectPolicy("/p2", { approvalMode: "writes" }, path);
  eq(Object.keys(settings.policyByProject).length, 2, "两个项目两条");
  settings = writeProjectPolicy("/p1/", { mcpWriteApproval: true }, path);
  eq(Object.keys(settings.policyByProject).length, 2, "尾斜杠写法应归一到同一条");
  eq(settings.policyByProject["/p1"].approvalMode, "off", "归一后旧值仍在");
  eq(settings.policyByProject["/p1"].mcpWriteApproval, true, "归一后新值写入");
  eq(settings.policyByProject["/p2"].approvalMode, "writes", "另一个项目不受影响");
});

check("落盘 → 重读 → 解析：一轮闭环", () => {
  const path = settingsPath();
  rmSync(path, { force: true });
  writeProjectPolicy("/home/demo/pi-workspace", { approvalMode: "risky", approvalFallback: "queue" }, path);
  const settings = readGuardrailSettings(path);
  const resolved = resolvePolicy(settings, "/home/demo/pi-workspace");
  eq(resolved.approvalMode, "risky", "approvalMode");
  eq(resolved.approvalFallback, "queue", "approvalFallback");
  eq(resolved.mcpWriteApproval, DEFAULT_GUARDRAIL_SETTINGS.mcpWriteApproval, "未覆盖的键继承全局");
  eq(getGuardrailSettingsPath(agentDir), path, "路径入口一致");
});

/* ---------------- 4.5 集成链路：parse → write（以及路由层，复核复现的那条） ---------------- */

/** 三键设满（模拟用户先都设过），键值与全局值故意不同 */
const FULL_POLICY = { approvalMode: "off", approvalFallback: "queue", mcpWriteApproval: false };

check("集成链路：parsePolicyPatch → writeProjectPolicy，三键逐一同路径", () => {
  const path = settingsPath();
  for (const key of Object.keys(FULL_POLICY)) {
    rmSync(path, { force: true });
    writeProjectPolicy("/proj", FULL_POLICY, path);
    const parsed = parsePolicyPatch({ [key]: null });
    assert(parsed.ok, `${key}: 补丁应合法`);
    const settings = writeProjectPolicy("/proj", parsed.patch, path);
    const policy = settings.policyByProject["/proj"] ?? {};
    assert(!(key in policy), `${key}: 该键应被删（回到继承）`);
    for (const other of Object.keys(FULL_POLICY)) {
      if (other === key) continue;
      eq(policy[other], FULL_POLICY[other], `${key} 回退时 ${other} 应保留`);
    }
    // 真落盘（不是只看内存里的返回值）
    const reread = readGuardrailSettings(path).policyByProject["/proj"] ?? {};
    assert(!(key in reread), `${key}: 重读也应已删`);
    eq(resolvePolicy(readGuardrailSettings(path), "/proj")[key], DEFAULT_GUARDRAIL_SETTINGS[key], `${key}: 回退后等于全局值`);
  }
});

check("集成链路：模拟界面载荷 —— 三键逐个选回「继承」后整条 entry 消失", () => {
  const path = settingsPath();
  rmSync(path, { force: true });
  writeProjectPolicy("/proj", FULL_POLICY, path);
  eq(Object.keys(readGuardrailSettings(path).policyByProject["/proj"]).length, 3, "先设满三键");
  // 界面每个选择器的「继承」选项值都是空字符串，转成 null 发出去
  let settings = readGuardrailSettings(path);
  for (const key of Object.keys(FULL_POLICY)) {
    // 界面语义：选「继承」→ 发 null（选择器的 value 是空字符串）
    const parsed = parsePolicyPatch({ [key]: null });
    assert(parsed.ok, `${key}: 界面载荷应合法`);
    settings = writeProjectPolicy("/proj", parsed.patch, path);
  }
  eq(settings.policyByProject["/proj"], undefined, "最后一个键回退后整条 entry 删除");
  eq(readGuardrailSettings(path).policyByProject["/proj"], undefined, "重读也确认整条没了");
  const resolved = resolvePolicy(readGuardrailSettings(path), "/proj");
  eq(resolved.projectKey, null, "解析回落到「无项目配置」");
});

// 路由层：直接调 POST 处理器 —— 与复核用的复现命令同一条路径（含 JSON 载荷与 cwd 规范化）
const route = await jiti.import("../app/api/guardrails/route.ts");
const postGuardrails = async (body) => {
  const res = await route.POST(new Request("http://localhost/api/guardrails", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: res.status, data: await res.json() };
};

await checkAsync("路由集成：POST 单键 null 真的落盘删除（复核复现的那条）", async () => {
  const path = settingsPath();
  const cwd = "/tmp/elenva-policy-demo"; // 虚构路径
  rmSync(path, { force: true });
  const seed = await postGuardrails({ action: "setProjectPolicy", cwd, policy: FULL_POLICY });
  eq(seed.status, 200, "seed 状态码");
  eq(seed.data.policyByProject[cwd].approvalMode, "off", "seed 落盘");

  const back = await postGuardrails({ action: "setProjectPolicy", cwd, policy: { approvalMode: null } });
  eq(back.status, 200, "回退状态码");
  assert(!("approvalMode" in back.data.policyByProject[cwd]), "响应里该键应已删");
  const stored = readGuardrailSettings(path).policyByProject[cwd] ?? {};
  assert(!("approvalMode" in stored), "磁盘上该键应已删");
  eq(stored.approvalFallback, "queue", "其余键保留");
  eq(stored.mcpWriteApproval, false, "其余键保留");

  let last = back;
  for (const key of ["approvalFallback", "mcpWriteApproval"]) {
    const step = await postGuardrails({ action: "setProjectPolicy", cwd, policy: { [key]: null } });
    eq(step.status, 200, `${key} 回退状态码`);
    assert(!(key in (step.data.policyByProject[cwd] ?? {})), `${key} 应从磁盘删除`);
    last = step;
  }
  eq(Object.keys(last.data.policyByProject).length, 0, "三键回退完 → 该项目整条消失");

  // 非法值：400 且不落盘（写前校验不能只挡一半）
  const bad = await postGuardrails({ action: "setProjectPolicy", cwd, policy: { approvalMode: "strict" } });
  eq(bad.status, 400, "非法档位 400");
  eq(Object.keys(readGuardrailSettings(path).policyByProject).length, 0, "400 不落盘");
  // 整条清除路径仍正常
  await postGuardrails({ action: "setProjectPolicy", cwd, policy: FULL_POLICY });
  const cleared = await postGuardrails({ action: "setProjectPolicy", cwd, policy: null });
  eq(cleared.status, 200, "整条清除状态码");
  eq(cleared.data.policyByProject[cwd], undefined, "整条清除");
});

/* ---------------- 5. 调用点与纯度核对（静态） ---------------- */

const readSource = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

check("纯函数模块不含运行时导入（客户端边界）", () => {
  const source = readSource("lib/guardrail-policy.ts");
  const imports = source.split("\n").filter((line) => /^import\b/.test(line.trim()));
  eq(imports.length, 1, `只应有一个 import（实际 ${imports.length} 行）`);
  assert(/^import type\b/.test(imports[0].trim()), `唯一导入必须是 type-only：${imports[0]}`);
  assert(!/from "node:/.test(source), "不得出现 node: 导入（会把 fs 拖进客户端包）");
});

check("host-guardrails：三个键全部走 resolvePolicy，不再直读 settings", () => {
  const source = readSource("lib/host-guardrails-extension.ts");
  assert(/resolvePolicy\(settings, runtime\.getCwd\(\)/.test(source), "应在读取 settings 后调用 resolvePolicy");
  assert(/caseInsensitiveKeys: process\.platform === "win32"/.test(source), "大小写匹配应由调用点按平台显式给出");
  const directReads = source.match(/settings\.(approvalMode|approvalFallback|mcpWriteApproval)/g) ?? [];
  eq(directReads.length, 0, `审批三键不应再有直读（实际 ${directReads.join(", ")}）`);
  const policyReads = source.match(/policy\.(approvalMode|approvalFallback|mcpWriteApproval)/g) ?? [];
  eq(policyReads.length, 3, `三个判定点都应读 policy（实际 ${policyReads.join(", ")}）`);
  // allowByProject 语义不动
  assert(/settings\.allowByProject\[cwdKey\(runtime\.getCwd\(\)\)\]/.test(source), "免确认规则仍按项目直读");
});

check("设置结构 / 路由：字段与读写入口都在", () => {
  const settingsSource = readSource("lib/guardrail-settings.ts");
  assert(/policyByProject: Record<string, ProjectPolicy>;/.test(settingsSource), "接口应含 policyByProject");
  assert(/policyByProject: \{\},/.test(settingsSource), "默认值应含空表");
  assert(/policyByProject: readPolicyByProject\(stored\.policyByProject\)/.test(settingsSource), "读盘应解析该字段");
  assert(/export function writeProjectPolicy\(/.test(settingsSource), "应导出 writeProjectPolicy");

  const route = readSource("app/api/guardrails/route.ts");
  assert(/policyByProject: settings\.policyByProject,/.test(route), "GET 应返回 policyByProject");
  assert(/approvalFallback: settings\.approvalFallback,/.test(route), "GET 应返回全局回落档（界面的「继承（…）」要用）");
  assert(/case "setProjectPolicy": \{/.test(route), "POST 应有 setProjectPolicy");
  assert(/parsePolicyPatch\(body\.policy\)/.test(route), "写入前应校验");
  assert(!/APPROVAL_MODES: ApprovalMode\[\]/.test(route), "档位白名单应复用纯函数模块，不再本地复制");

  const ui = readSource("components/SettingsPage.tsx");
  assert(/项目策略/.test(ui), "设置页应有「项目策略」分节");
  assert(/setProjectPolicy/.test(ui), "界面应调用写入接口");
  assert(/import type \{ ProjectPolicy \} from "@\/lib\/guardrail-policy"/.test(ui), "界面只应取类型（type-only）");
});

rmSync(root, { recursive: true, force: true });

console.log(fail === 0 ? "\n全部通过" : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
