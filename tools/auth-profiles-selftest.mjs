// 「多账号 / 命名凭据档」（模块 6 · 第 5 轮）的自检：
//   纯函数层（指纹 / 档 id / 凭据校验 / 稳定序列化）
//   + 磁盘层（索引读写往返 / 档本体 0600 / 损坏容错）
//   + 链路层（夹具 auth.json 上：存档 → 切换 → 回退，含字节比对、自动备份、OAuth 令牌回收、写失败回滚）
//   + 路由层（GET/POST/PATCH/DELETE/switch 直接调 handler，断言响应与重读磁盘）
//   + 静态核对（接口不回凭据明文 / 设置页接线 / .gitignore 白名单）
// 运行：node tools/auth-profiles-selftest.mjs
//
// 隔离：PI_CODING_AGENT_DIR 指向 mkdtemp 出来的临时目录，全用**虚构**凭据，
// 不碰真实 ~/.pi/agent/auth.json。lib/*.ts 是纯 TS，jiti 可直载（见记忆 F1/F3）。
import { createJiti } from "jiti";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "elenva-auth-profiles-selftest-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const lib = await jiti.import("../lib/auth-profiles.ts");
const {
  resolveAuthProfilesPaths,
  readAuthProfilesIndex,
  listAuthProfiles,
  saveCurrentAsProfile,
  updateProfileNote,
  deleteAuthProfile,
  switchToAuthProfile,
  getProfileBodyPath,
  fingerprintCredential,
  profileIdFor,
  isValidCredential,
  readLiveAuthData,
  readCurrentAuthFingerprints,
  __setFailNextLiveWriteForTest,
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
const readSource = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf-8");

/** 每个用例一个干净 agentDir，避免相互污染 */
function freshAgent(label) {
  const dir = join(root, label);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function writeAuth(dir, data) {
  writeFileSync(join(dir, "auth.json"), JSON.stringify(data, null, 2), { mode: 0o600 });
}
function readAuthBytes(dir) {
  return readFileSync(join(dir, "auth.json"));
}
function readProfileBodyJson(dir, id) {
  return JSON.parse(readFileSync(getProfileBodyPath(id, dir), "utf-8"));
}

const OAUTH_A = { type: "oauth", refresh: "refresh-AAA-secret", access: "access-AAA", expires: 1111111111 };
const OAUTH_A_ROTATED = { type: "oauth", refresh: "refresh-AAA-rotated", access: "access-AAA-2", expires: 2222222222 };
const OAUTH_B = { type: "oauth", refresh: "refresh-BBB-secret", access: "access-BBB", expires: 3333333333 };
const API_KEY = { type: "api_key", key: "sk-fixture-opencode-go" };

/* ---------------- 纯函数层 ---------------- */

check("指纹：与键序无关、不同凭据不同、不含明文", () => {
  const a1 = { type: "oauth", refresh: "R", access: "A", expires: 1 };
  const a2 = { expires: 1, access: "A", refresh: "R", type: "oauth" };
  assert(fingerprintCredential(a1) === fingerprintCredential(a2), "键序不同应同指纹");
  assert(fingerprintCredential(a1) !== fingerprintCredential({ ...a1, refresh: "R2" }), "内容不同应不同指纹");
  assert(!fingerprintCredential(a1).includes("R"), "指纹不得包含原文");
  assert(/^[0-9a-f]{16}$/.test(fingerprintCredential(a1)), "指纹应为 16 位十六进制");
});

check("档 id：确定性；中文名退化为 provider + 短哈希；非法 provider 被拒", () => {
  assert(profileIdFor("账号A", "anthropic") === profileIdFor("账号A", "anthropic"), "应确定性");
  assert(profileIdFor("Company", "anthropic").startsWith("company-"), "英文应走 slug");
  assert(/^anthropic-[0-9a-f]{8}$/.test(profileIdFor("账号A", "anthropic")), "中文应退化");
  assert(profileIdFor("a", "p") !== profileIdFor("a", "q"), "不同 provider 应不同 id");
});

check("凭据校验：接受 api_key / oauth，拒绝残缺与非法类型", () => {
  assert(isValidCredential(API_KEY), "api_key 合法");
  assert(isValidCredential({ type: "api_key" }), "api_key 可无 key（命令引用等）");
  assert(isValidCredential({ type: "api_key", key: "!cmd" }), "命令引用合法");
  assert(isValidCredential(OAUTH_A), "oauth 合法");
  assert(!isValidCredential({ type: "oauth", access: "a", refresh: "r" }), "缺 expires 应拒");
  assert(!isValidCredential({ type: "oauth", access: 1, refresh: "r", expires: 1 }), "类型错应拒");
  assert(!isValidCredential({ type: "unknown" }), "未知类型应拒");
  assert(!isValidCredential(null), "null 应拒");
  assert(!isValidCredential({ type: "api_key", env: { A: 1 } }), "env 非字符串应拒");
});

/* ---------------- 磁盘层 ---------------- */

await checkAsync("索引：缺失 → 空；写入后读回一致", async () => {
  const dir = freshAgent("index");
  const empty = readAuthProfilesIndex(dir);
  assert(empty.profiles.length === 0 && Object.keys(empty.active).length === 0, "缺失应为空索引");
  writeAuth(dir, { anthropic: OAUTH_A });
  await saveCurrentAsProfile("anthropic", "账号A", "个人号", dir);
  const again = readAuthProfilesIndex(dir);
  assert(again.profiles.length === 1, "应有 1 档");
  assert(again.profiles[0].label === "账号A" && again.profiles[0].note === "个人号", "档名/备注应保留");
  assert(again.active.anthropic === again.profiles[0].id, "active 应指向刚存的档");
});

await checkAsync("档本体：0600、内容为凭据本身；索引损坏时不崩", async () => {
  const dir = freshAgent("body");
  writeAuth(dir, { anthropic: OAUTH_A });
  const profile = await saveCurrentAsProfile("anthropic", "账号A", undefined, dir);
  const bodyPath = getProfileBodyPath(profile.id, dir);
  assert((statSync(bodyPath).mode & 0o777) === 0o600, "档本体应为 0600");
  assert(readProfileBodyJson(dir, profile.id).refresh === OAUTH_A.refresh, "档本体应为凭据本身");
  writeFileSync(resolveAuthProfilesPaths(dir).indexPath, "{ not json", "utf-8");
  const recovered = readAuthProfilesIndex(dir);
  assert(recovered.profiles.length === 0, "索引损坏应从容返回空");
});

check("读 auth.json：缺文件 → 空；损坏 → 抛错（拒绝把坏文件当空）", () => {
  const dir = freshAgent("corrupt-live");
  assert(Object.keys(readLiveAuthData(join(dir, "auth.json"))).length === 0, "缺文件返回空");
  writeFileSync(join(dir, "auth.json"), "{broken", "utf-8");
  let threw = false;
  try {
    readLiveAuthData(join(dir, "auth.json"));
  } catch {
    threw = true;
  }
  assert(threw, "损坏应抛错");
});

/* ---------------- 链路层：全链 ---------------- */

await checkAsync("全链：存档 → 切换 → 回退（字节比对 + 自动备份 + 令牌回收）", async () => {
  const dir = freshAgent("chain");
  writeAuth(dir, { anthropic: OAUTH_A, "opencode-go": API_KEY });

  // 存 A 档
  const a = await saveCurrentAsProfile("anthropic", "账号A", undefined, dir);

  // 模拟内核刷新后重新 /login 到账号 B
  writeAuth(dir, { anthropic: OAUTH_B, "opencode-go": API_KEY });
  const b = await saveCurrentAsProfile("anthropic", "账号B", undefined, dir);
  const beforeSwitchBytes = readAuthBytes(dir);

  // 切到 A
  const r1 = await switchToAuthProfile(a.id, dir);
  assert(r1.provider === "anthropic", "应报告 provider");
  assert(r1.autoBackupId, "切换前应生成自动备份");
  const liveAfterA = readLiveAuthData(join(dir, "auth.json"));
  assert(JSON.stringify(liveAfterA.anthropic) === JSON.stringify(OAUTH_A), "live 应变为 A 凭据");
  assert(JSON.stringify(liveAfterA["opencode-go"]) === JSON.stringify(API_KEY), "其它 provider 不得被改动");
  // 自动备份保存的是切换前的字节内容（B）
  assert(
    JSON.stringify(readProfileBodyJson(dir, r1.autoBackupId)) === JSON.stringify(OAUTH_B),
    "自动备份内容应为切换前的 B",
  );
  assert(beforeSwitchBytes.length > 0, "前置字节基线非空");

  // 模拟内核用 A 请求后轮换令牌：live 变为 A'，再由我们切到 B 时应回收到 A 档
  writeAuth(dir, { anthropic: OAUTH_A_ROTATED, "opencode-go": API_KEY });
  await switchToAuthProfile(b.id, dir);
  assert(
    JSON.stringify(readProfileBodyJson(dir, a.id)) === JSON.stringify(OAUTH_A_ROTATED),
    "切出时应把轮换后的 A' 回收到 A 档",
  );

  // 切回 A：应拿到轮换后的 A'
  await switchToAuthProfile(a.id, dir);
  const liveBack = readLiveAuthData(join(dir, "auth.json"));
  assert(JSON.stringify(liveBack.anthropic) === JSON.stringify(OAUTH_A_ROTATED), "切回应恢复 A'");

  // 列表把当前生效标在 A 上
  const listing = listAuthProfiles(dir);
  assert(listing.active.anthropic === a.id, "列表应标记 A 为当前生效");
  assert(listing.active["opencode-go"] === undefined || listing.active["opencode-go"] === null, "opencode-go 无档");

  // 跨目录再读一次索引，确认落盘
  const persisted = readAuthProfilesIndex(dir);
  assert(persisted.active.anthropic === a.id, "索引 active 应持久化");
});

await checkAsync("全链：写失败回滚，auth.json 字节完全不变；自动备份已落盘", async () => {
  const dir = freshAgent("rollback");
  writeAuth(dir, { anthropic: OAUTH_B, "opencode-go": API_KEY });
  const a = await saveCurrentAsProfile("anthropic", "账号A", undefined, dir);
  // 先把 live 改为 B（否则 A 档＝live，切换无意义）
  writeAuth(dir, { anthropic: OAUTH_B, "opencode-go": API_KEY });
  const beforeBytes = readAuthBytes(dir);

  __setFailNextLiveWriteForTest("fixture: write boom");
  let message = "";
  try {
    await switchToAuthProfile(a.id, dir);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(/回滚/.test(message), `应报告回滚，实际：${message}`);
  const afterBytes = readAuthBytes(dir);
  assert(Buffer.compare(beforeBytes, afterBytes) === 0, "失败后 auth.json 字节应与切换前完全一致");

  // 自动备份仍在册（可手动切回）
  const index = readAuthProfilesIndex(dir);
  assert(index.profiles.some((p) => p.kind === "auto"), "失败也应留下自动备份");
});

await checkAsync("全链：目标档文件损坏 → 拒绝切换且不碰 auth.json", async () => {
  const dir = freshAgent("bad-body");
  writeAuth(dir, { anthropic: OAUTH_B });
  const a = await saveCurrentAsProfile("anthropic", "账号A", undefined, dir);
  writeFileSync(getProfileBodyPath(a.id, dir), "{ broken", "utf-8");
  const before = readAuthBytes(dir);
  let threw = false;
  try {
    await switchToAuthProfile(a.id, dir);
  } catch {
    threw = true;
  }
  assert(threw, "损坏档应拒绝切换");
  assert(Buffer.compare(before, readAuthBytes(dir)) === 0, "auth.json 不得被触碰");
});

await checkAsync("全链：无前置凭据时切换不留自动备份，且能写入首份凭据", async () => {
  const dir = freshAgent("no-prev");
  writeAuth(dir, { anthropic: OAUTH_A });
  const a = await saveCurrentAsProfile("anthropic", "账号A", undefined, dir);
  // 模拟外部 /logout：live 中移除 anthropic
  writeAuth(dir, { "opencode-go": API_KEY });
  const result = await switchToAuthProfile(a.id, dir);
  assert(result.autoBackupId === null, "无前置凭据不应产生自动备份");
  assert(
    JSON.stringify(readLiveAuthData(join(dir, "auth.json")).anthropic) === JSON.stringify(OAUTH_A),
    "应写入档内凭据",
  );
  assert(readLiveAuthData(join(dir, "auth.json"))["opencode-go"].key === API_KEY.key, "其它 provider 保留");
});

await checkAsync("全链：损坏的 auth.json 下拒绝存档，字节不变", async () => {
  const dir = freshAgent("corrupt-save");
  writeFileSync(join(dir, "auth.json"), "{broken", "utf-8");
  const before = readAuthBytes(dir);
  let threw = false;
  try {
    await saveCurrentAsProfile("anthropic", "账号A", undefined, dir);
  } catch {
    threw = true;
  }
  assert(threw, "损坏 auth.json 应拒绝存档");
  assert(Buffer.compare(before, readAuthBytes(dir)) === 0, "字节不得变化");
});

await checkAsync("备注：更新与清空；删除：移除索引与本体且不动 live", async () => {
  const dir = freshAgent("note-delete");
  writeAuth(dir, { anthropic: OAUTH_A });
  const a = await saveCurrentAsProfile("anthropic", "账号A", "旧备注", dir);
  const updated = await updateProfileNote(a.id, "新备注", dir);
  assert(updated.note === "新备注", "备注应更新");
  await updateProfileNote(a.id, "  ", dir);
  assert(readAuthProfilesIndex(dir).profiles.find((p) => p.id === a.id).note === undefined, "空备注应清除");
  const liveBefore = readAuthBytes(dir);
  await deleteAuthProfile(a.id, dir);
  assert(!existsSync(getProfileBodyPath(a.id, dir)), "本体应删除");
  assert(readAuthProfilesIndex(dir).profiles.length === 0, "索引应清空");
  assert(Buffer.compare(liveBefore, readAuthBytes(dir)) === 0, "删除档不得动 auth.json");
});

await checkAsync("存档建档名重复 → 覆盖同档（保留 createdAt），不产生重复", async () => {
  const dir = freshAgent("upsert");
  writeAuth(dir, { anthropic: OAUTH_A });
  const first = await saveCurrentAsProfile("anthropic", "账号A", undefined, dir);
  await new Promise((r) => setTimeout(r, 5));
  writeAuth(dir, { anthropic: OAUTH_A_ROTATED });
  const second = await saveCurrentAsProfile("anthropic", "账号A", undefined, dir);
  assert(first.id === second.id, "同档名应同 id");
  assert(first.createdAt === second.createdAt, "createdAt 应保留");
  assert(readAuthProfilesIndex(dir).profiles.length === 1, "不应重复");
  assert(
    readProfileBodyJson(dir, second.id).refresh === OAUTH_A_ROTATED.refresh,
    "本体应更新为最新凭据",
  );
});

await checkAsync("自动备份滚动上限：不无限增长", async () => {
  const dir = freshAgent("prune");
  writeAuth(dir, { anthropic: OAUTH_A });
  const a = await saveCurrentAsProfile("anthropic", "账号A", undefined, dir);
  writeAuth(dir, { anthropic: OAUTH_B });
  const b = await saveCurrentAsProfile("anthropic", "账号B", undefined, dir);
  for (let i = 0; i < 24; i += 1) {
    await switchToAuthProfile(i % 2 === 0 ? a.id : b.id, dir);
  }
  const autos = readAuthProfilesIndex(dir).profiles.filter((p) => p.kind === "auto");
  assert(autos.length <= 20, `自动备份应不超过 20，实际 ${autos.length}`);
});

check("只读指纹列表不泄露凭据字段", () => {
  const dir = freshAgent("fingerprints");
  writeAuth(dir, { anthropic: OAUTH_A });
  const current = readCurrentAuthFingerprints(dir);
  const json = JSON.stringify(current);
  assert(!json.includes("secret") && !json.includes("access-AAA"), "指纹列表不得含凭据明文");
  assert(current.anthropic.type === "oauth", "应报告类型");
});

/* ---------------- 路由层（直接调 handler） ---------------- */

await checkAsync("路由：GET /api/auth/profiles 不回凭据；POST 存档；PATCH 备注；DELETE 删除", async () => {
  const dir = freshAgent("route-profiles");
  process.env.PI_CODING_AGENT_DIR = dir;
  writeAuth(dir, { anthropic: OAUTH_A });
  const route = await jiti.import("../app/api/auth/profiles/route.ts");

  const get1 = await route.GET();
  const body1 = await get1.json();
  assert(get1.status === 200, "GET 应 200");
  assert(!JSON.stringify(body1).includes("secret"), "GET 响应不得含凭据明文");

  const post = await route.POST(
    new Request("http://localhost/api/auth/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "anthropic", label: "账号A", note: "个人" }),
    }),
  );
  const postBody = await post.json();
  assert(post.status === 200, `POST 应 200，实际 ${post.status} ${JSON.stringify(postBody)}`);
  assert(!JSON.stringify(postBody).includes("secret"), "POST 响应不得含凭据明文");
  const id = postBody.profile.id;

  const patch = await route.PATCH(
    new Request("http://localhost/api/auth/profiles", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, note: "改过" }),
    }),
  );
  assert(patch.status === 200, "PATCH 应 200");

  const missing = await route.POST(
    new Request("http://localhost/api/auth/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "无 provider" }),
    }),
  );
  assert(missing.status === 400, "缺 provider 应 400");

  const del = await route.DELETE(new Request(`http://localhost/api/auth/profiles?id=${id}`, { method: "DELETE" }));
  assert(del.status === 200, "DELETE 应 200");
});

await checkAsync("路由：POST /api/auth/profiles/switch 走通并返回自动备份 id", async () => {
  const dir = freshAgent("route-switch");
  process.env.PI_CODING_AGENT_DIR = dir;
  writeAuth(dir, { anthropic: OAUTH_A });
  const a = await saveCurrentAsProfile("anthropic", "账号A", undefined, dir);
  writeAuth(dir, { anthropic: OAUTH_B });
  const route = await jiti.import("../app/api/auth/profiles/switch/route.ts");
  const res = await route.POST(
    new Request("http://localhost/api/auth/profiles/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: a.id }),
    }),
  );
  const body = await res.json();
  assert(res.status === 200, `应 200，实际 ${res.status} ${JSON.stringify(body)}`);
  assert(body.autoBackupId, "应返回自动备份 id");
  assert(!JSON.stringify(body).includes("secret"), "响应不得含凭据明文");
});

/* ---------------- 静态核对 ---------------- */

check("接口与 UI 不返回凭据内容：路由/存储层不把 key/refresh 放进响应对象", () => {
  const route = readSource("app/api/auth/profiles/route.ts");
  assert(!/credential/.test(route), "profiles 路由不应出现 credential 字段");
  const switchRoute = readSource("app/api/auth/profiles/switch/route.ts");
  assert(/switchToAuthProfile/.test(switchRoute), "switch 路由应调用切换函数");
  const ui = readSource("components/AccountProfilesSection.tsx");
  assert(/实验性/.test(ui), "UI 应标明实验性");
  assert(/当前登录/.test(ui), "UI 应有只读的当前登录区");
  assert(!/refresh\s*:/.test(ui), "UI 不得出现凭据字段");
});

check("设置页接线：渲染账号小节", () => {
  const settings = readSource("components/SettingsPage.tsx");
  assert(/AccountProfilesSection/.test(settings), "设置页应引入账号小节");
  assert(/<AccountProfilesSection \/>/.test(settings), "设置页应渲染账号小节");
});

check(".gitignore 白名单包含本自测（随仓库分发，非本机夹具）", () => {
  const source = readSource(".gitignore");
  assert(/!tools\/auth-profiles-selftest\.mjs/.test(source), "应加入白名单");
});

rmSync(root, { recursive: true, force: true });

console.log(fail === 0 ? "\n全部通过" : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
