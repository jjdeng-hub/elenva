# elenva-comfyui —— 本机生图（ComfyUI）

给 Elen 注册一个 `generate_image` 工具：调用**本机 ComfyUI**（默认 Flux 工作流）按提示词生成图片；
结果以图片块返回——随会话保存、在网页对话里直接渲染。

## 安装

```bash
node extensions/elenva-comfyui/install.mjs
```

（把扩展复制到 `<agentRoot>/extensions/elenva-comfyui/`；`--uninstall` 卸载，`--print-path` 看目标路径。）

装好后**重开会话**（扩展在会话启动时加载）。用之前确保本机 ComfyUI 已在运行（默认 `127.0.0.1:8188`）。

## 配置（可选）

`<agentRoot>/comfyui.json`（默认 `~/.pi/agent/comfyui.json`；Windows 为 `C:\Users\<你>\.pi\agent\comfyui.json`）：

```json
{
  "baseUrl": "http://127.0.0.1:8188",
  "workflowPath": "",
  "timeoutMs": 300000,
  "models": {
    "unet": "flux1-dev.safetensors",
    "clip1": "t5xxl_fp16.safetensors",
    "clip2": "clip_l.safetensors",
    "vae": "ae.safetensors"
  },
  "nodeMap": {},
  "saveDir": ""
}
```

- `baseUrl`：ComfyUI 地址；默认 `http://127.0.0.1:8188`。
- `workflowPath`：自定义工作流（**API 格式** JSON，ComfyUI 里 `Workflow → Export (API)` 导出）；留空用内置 Flux 模板。
- `models.*`：按你本机的模型文件名覆盖内置模板（默认见上；在 ComfyUI 的 `models/unet`、`models/clip`、`models/vae` 目录里核对）。
- `nodeMap`：显式指定参数节点 id（如 `{"prompt": "6", "seed": "25", "steps": "17", "width": "27"}`）；默认自动识别。
- `saveDir`：图片副本保存目录；留空为 `<agentRoot>/comfyui-outputs/`。

环境变量可临时覆盖：`COMFYUI_BASE_URL` / `COMFYUI_WORKFLOW_PATH` / `COMFYUI_SAVE_DIR`。

## 用法

对话里直接说（模型会自动调用工具）：「生成一张图：……」。

工具参数：`prompt`（必填）、`width` / `height`（默认 1024）、`seed`（可选，不传随机）。

## 故障排查

- **连不上 ComfyUI**：确认 ComfyUI 正在运行；地址端口与 `baseUrl` 一致。
- **模型名不对（node_errors）**：把 `models.*` 改成你本机实际的模型文件名。
- **超时**：Flux 首次运行（加载模型）可能较慢，调大 `timeoutMs`。
- **工作流不是 API 格式**：必须用 Export (API) 导出（编辑器格式不能提交）。

## 自检

```bash
node extensions/elenva-comfyui/selftest.mjs
```
