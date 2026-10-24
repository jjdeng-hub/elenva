// models.json 写入端校验（lib/models-config-store.ts:validateModelsConfig）的自检：
// 内核的「整份文件全通过或整份失败」语义 —— 坏配置必须被拦在写入之前，
// 好配置不能被误拦（含 provider 级 api / baseUrl 的继承）。
// 运行：node tools/models-config-selftest.mjs
//
// 隔离：PI_CODING_AGENT_DIR 指向 mkdtemp 出来的临时目录，全用**虚构**数据，
// 不碰真实 ~/.pi/agent。lib/*.ts 是纯 TS（无 JSX），jiti 可直载。
import { createJiti } from "jiti";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "elenva-models-config-selftest-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname } });
const lib = await jiti.import("../lib/models-config-store.ts");
const { validateModelsConfig } = lib;

let fail = 0;
const check = async (name, fn) => {
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

/** 断言「通过」，同时打印实际返回，避免空转通过 */
const expectOk = async (data, label) => {
  const error = await validateModelsConfig(data);
  assert(error === null, `${label} 应通过，实际返回：${String(error)}`);
};
/** 断言「被拒」，并要求错误里出现关键片段（错误原文来自内核） */
const expectRejected = async (data, fragment, label) => {
  const error = await validateModelsConfig(data);
  assert(typeof error === "string" && error.length > 0, `${label} 应被拒，实际通过了`);
  assert(error.includes(fragment), `${label} 的错误应包含「${fragment}」，实际：${error}`);
};

/* =============================== 通过用例 =============================== */

await check("空 providers：通过（清空后保存是合法操作）", async () => {
  await expectOk({ providers: {} }, "空 providers");
});

await check("provider 级 api + baseUrl，model 只给 id：通过（继承）", async () => {
  await expectOk(
    {
      providers: {
        "demo-gw": {
          api: "openai-completions",
          baseUrl: "https://example.invalid/v1",
          models: [{ id: "demo-model" }],
        },
      },
    },
    "provider 级继承",
  );
});

await check("model 级 api + baseUrl 齐全：通过", async () => {
  await expectOk(
    {
      providers: {
        "demo-gw": {
          models: [
            {
              id: "demo-model",
              api: "openai-completions",
              baseUrl: "https://example.invalid/v1",
            },
          ],
        },
      },
    },
    "model 级字段",
  );
});

/* =============================== 拒绝用例 =============================== */

await check("缺 api（provider 与 model 都没有）：拒绝，错误含 no \"api\" specified", async () => {
  await expectRejected(
    {
      providers: {
        bad: { models: [{ id: "ok-model" }] },
      },
    },
    'no "api" specified',
    "缺 api",
  );
});

await check("缺 baseUrl：拒绝，错误含 baseUrl", async () => {
  await expectRejected(
    {
      providers: {
        "demo-gw": { api: "openai-completions", models: [{ id: "demo-model" }] },
      },
    },
    "baseUrl",
    "缺 baseUrl",
  );
});

await check("空串 baseUrl 先被 sanitize 清掉，再按缺失拒绝（不写坏文件）", async () => {
  await expectRejected(
    {
      providers: {
        "demo-gw": {
          api: "openai-completions",
          baseUrl: "   ",
          models: [{ id: "demo-model" }],
        },
      },
    },
    "baseUrl",
    "空白 baseUrl",
  );
});

await check("contextWindow <= 0：拒绝，错误含 contextWindow", async () => {
  await expectRejected(
    {
      providers: {
        "demo-gw": {
          api: "openai-completions",
          baseUrl: "https://example.invalid/v1",
          models: [{ id: "demo-model", contextWindow: 0 }],
        },
      },
    },
    "contextWindow",
    "非法 contextWindow",
  );
});

await check("maxTokens <= 0：拒绝，错误含 maxTokens", async () => {
  await expectRejected(
    {
      providers: {
        "demo-gw": {
          api: "openai-completions",
          baseUrl: "https://example.invalid/v1",
          models: [{ id: "demo-model", maxTokens: -1 }],
        },
      },
    },
    "maxTokens",
    "非法 maxTokens",
  );
});

rmSync(root, { recursive: true, force: true });

console.log(fail === 0 ? "\n全部通过" : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
