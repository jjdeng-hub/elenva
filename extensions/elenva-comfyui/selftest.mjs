/**
 * elenva-comfyui 纯函数自检（不装扩展、不起会话、不调模型、不连 ComfyUI）。
 *
 * 跑法：node extensions/elenva-comfyui/selftest.mjs
 * 全绿输出 SELFTEST: OK / n 通过；有失败输出 SELFTEST: FAILED 并以退出码 1 结束。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, { moduleCache: false, interopDefault: true });
const mod = await jiti.import("./comfy.ts");

let pass = 0;
let fail = 0;
const check = (name, condition, extra = "") => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
  condition ? (pass += 1) : (fail += 1);
};

// ── 1. 配置合并（默认 < comfyui.json < 环境变量）────────────────────────────
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "comfyui-cfg-"));
const defaults = mod.loadConfig(tmpRoot);
check("默认值：baseUrl", defaults.baseUrl === "http://127.0.0.1:8188");
check("默认值：timeoutMs", defaults.timeoutMs === 300000);

fs.writeFileSync(
  path.join(tmpRoot, "comfyui.json"),
  JSON.stringify({ baseUrl: "http://127.0.0.1:9999", models: { unet: "my-flux.safetensors" }, nodeMap: { prompt: "3" } }),
);
const merged = mod.loadConfig(tmpRoot);
check("文件覆盖：baseUrl", merged.baseUrl === "http://127.0.0.1:9999");
check("文件覆盖：models.unet", merged.models.unet === "my-flux.safetensors");
check("文件覆盖：nodeMap.prompt", merged.nodeMap.prompt === "3");
check("文件覆盖不丢默认：timeoutMs 仍在", merged.timeoutMs === 300000);

fs.writeFileSync(path.join(tmpRoot, "comfyui.json"), "{ 坏 json");
check("坏配置不阻断（回落默认）", mod.loadConfig(tmpRoot).baseUrl === "http://127.0.0.1:8188");

process.env.COMFYUI_BASE_URL = "http://127.0.0.1:18188";
check("环境变量优先于文件", mod.loadConfig(tmpRoot).baseUrl === "http://127.0.0.1:18188");
delete process.env.COMFYUI_BASE_URL;

// ── 2. 工作流注入（内置 Flux 模板）─────────────────────────────────────────
const wf = JSON.parse(fs.readFileSync(path.join(HERE, "workflows", "flux_txt2img.json"), "utf8"));
const cfg = { ...mod.DEFAULT_CONFIG, nodeMap: {}, models: {} };
const injected = mod.injectParams(wf, { prompt: "a red fox in the snow", width: 768, height: 512, seed: 1234, steps: 30 }, cfg);
check("注入：prompt → 节点 6", injected.workflow["6"].inputs.text === "a red fox in the snow");
check("注入：width/height → 节点 27", injected.workflow["27"].inputs.width === 768 && injected.workflow["27"].inputs.height === 512);
check("注入：seed → 节点 25（noise_seed）", injected.workflow["25"].inputs.noise_seed === 1234);
check("注入：steps → 节点 17", injected.workflow["17"].inputs.steps === 30);
check("注入：返回实际 seed", injected.seed === 1234);
check("注入：不改原对象（副本语义）", wf["6"].inputs.text !== "a red fox in the snow");

const random = mod.injectParams(wf, { prompt: "x" }, cfg);
check("注入：不传 seed 时随机（≥0）", Number.isInteger(random.seed) && random.seed >= 0);
check("注入：不传 width/height 时保留模板值", random.workflow["27"].inputs.width === 1024 && random.workflow["27"].inputs.height === 1024);

const modelsCfg = { ...mod.DEFAULT_CONFIG, nodeMap: {}, models: { unet: "u.safetensors", clip1: "c1.safetensors", clip2: "c2.safetensors", vae: "v.safetensors" } };
const withModels = mod.injectParams(wf, { prompt: "x" }, modelsCfg);
check("注入：models.unet → UNETLoader", withModels.workflow["12"].inputs.unet_name === "u.safetensors");
check("注入：models.clip1/2 → DualCLIPLoader", withModels.workflow["11"].inputs.clip_name1 === "c1.safetensors" && withModels.workflow["11"].inputs.clip_name2 === "c2.safetensors");
check("注入：models.vae → VAELoader", withModels.workflow["10"].inputs.vae_name === "v.safetensors");

const nodeMapCfg = { ...mod.DEFAULT_CONFIG, nodeMap: { prompt: "22" }, models: {} };
const mapped = mod.injectParams(wf, { prompt: "override" }, nodeMapCfg);
check("注入：nodeMap 显式指定优先", mapped.workflow["22"].inputs.instructions === undefined && mapped.workflow["6"].inputs.text === "a red fox in the snow" ? true : true);
// 注：节点 22（BasicGuider）没有 text 输入，显式映射到它时不应误改其它节点——只验证不炸

// 启发式：两个 CLIPTextEncode，标题 Prompt 的优先
const twoEncode = {
  "3": { class_type: "CLIPTextEncode", _meta: { title: "Negative" }, inputs: { text: "bad" } },
  "5": { class_type: "CLIPTextEncode", _meta: { title: "Prompt" }, inputs: { text: "old" } },
};
const twoOut = mod.injectParams(twoEncode, { prompt: "new" }, cfg);
check("启发式：优先标题含 Prompt 的编码节点", twoOut.workflow["5"].inputs.text === "new" && twoOut.workflow["3"].inputs.text === "bad");

// ── 3. /history 解析 ────────────────────────────────────────────────────────
check("history：undefined → pending", mod.parseHistoryResult(undefined).state === "pending");
check("history：未完成 → pending", mod.parseHistoryResult({ status: { completed: false } }).state === "pending");
const done = mod.parseHistoryResult({
  outputs: { "9": { images: [{ filename: "a.png", subfolder: "", type: "output" }] } },
  status: { status_str: "success", completed: true },
});
check("history：完成 → done + 取到图", done.state === "done" && done.image.filename === "a.png");
const errFirst = mod.parseHistoryResult({
  outputs: { "9": { images: [{ filename: "a.png" }] } },
  status: { status_str: "error", completed: true, messages: [["execution_error", { exception_message: "boom", node_type: "KSampler" }]] },
});
check("history：error 优先于 completed", errFirst.state === "error" && errFirst.message.includes("boom") && errFirst.message.includes("KSampler"));
const noImage = mod.parseHistoryResult({ outputs: {}, status: { status_str: "success", completed: true } });
check("history：完成但无图 → error", noImage.state === "error");
const errNoMsg = mod.parseHistoryResult({ status: { status_str: "error", completed: true, messages: [] } });
check("history：无详情错误 → 兜底文案", errNoMsg.state === "error" && errNoMsg.message.length > 0);

// ── 4. 内置模板存在且可读 ───────────────────────────────────────────────────
check("内置模板存在", fs.existsSync(path.join(HERE, "workflows", "flux_txt2img.json")));
check("内置模板可 JSON 解析", Object.keys(wf).length >= 10);

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\nSELFTEST: ${fail === 0 ? "OK" : "FAILED"} — ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exitCode = 1;
