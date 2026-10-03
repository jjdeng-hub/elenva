# pi 内核升级手册

> 适用：本项目锁定的 `@earendil-works/*` 依赖。手动执行，没有 CI。

## 一、先弄清事实（这几条决定了策略）

| 事实 | 含义 |
|---|---|
| **SDK 和 CLI 是同一个包**。`pi-coding-agent` 的 `bin` → `dist/bundle/cli.js`，`main` → `dist/index.js` | 没有「SDK 版本」这个独立概念。升 `pi-coding-agent` = 同时升 CLI 和 SDK |
| **兄弟包锁步发布**。`pi-ai` / `pi-agent-core` / `pi-tui` / `pi-protocol` / `pi-server` / `pi-client` / `chord` / `pi-telemetry` 版本号永远一致（截至 0.85.1 共 45 个版本一一对应） | 必须**整组一起升**，不能只升一个。`pi-coding-agent` 还自带 `npm-shrinkwrap.json`（165 个包精确锁定），它的传递依赖是冻结的 |
| **semver 不可信**。`0.84.3` 是补丁号，却带 `### Breaking Changes`（重命名 `GoogleThinkingLevel`）。274 个版本里 40+ 次 `Breaking Changes` / `Removed` | 不要用版本号判断风险，用 changelog + 验证 |
| 发布节奏约**每周一版** | 见第五节触发策略 |
| **0.86 起系统提示词「转写化」**：`agent.state.systemPrompt` 只读；提示词/工具声明由转写里的 `system` 消息承载、请求前回放。SDK 对 `forceSystemPrompt` 用「请求前投影」（`agent.transformContext`） | 别再直写 state；本项目的 `exactSystemPrompt` 已改为投影实现（`lib/agent-runtime.ts`）。角色白名单相应增加 `system`（`tools/pi-surface-check.ts` 段②、`lib/session-reader.ts` 跳过） |

## 二、查有没有新版

```bash
npm view @earendil-works/pi-coding-agent version          # 官方 registry 上的 latest
npm view @earendil-works/pi-coding-agent dist-tags --json # 确认没有 canary/next 通道
```

三方交叉核对（任一领先即说明有预发布通道）：
[pi.dev/changelog](https://pi.dev/changelog) · [GitHub releases](https://github.com/earendil-works/pi/releases) · npm registry

**注意**：`npm` 上的 `latest` 与 GitHub tag 通常同天发布；若只有 CHANGELOG 提到某版本而 registry 没有，说明还没发，不能升。

## 三、读 delta changelog（只读关心的部分）

新版的 changelog 在 `node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md`（未升级前 `npm pack` 新版解包也能拿到）。**只读两样**：

1. `### Breaking Changes` / `### Removed` 段落
2. 含本项目实际使用符号名的行（`grep -F` 我们 import 的符号）

## 四、升级与验证

### 步骤

```bash
# ① 整组升级，精确锁版本（-E = --save-exact，禁止 ^ 漂移）
npm i -E @earendil-works/pi-coding-agent@<X> \
        @earendil-works/pi-agent-core@<X> \
        @earendil-works/pi-ai@<X> \
        @earendil-works/pi-tui@<X>

# ② 主类型检查：0 输出即通过（守 API 改名 / 改签名 / 扩展钩子名）
node ./node_modules/typescript/bin/tsc --noEmit

# ③ 用法面探针：守「形态」——内容块、消息角色、图片结构、会话格式版本
node ./node_modules/typescript/bin/tsc -p tools/tsconfig.json

# ④ 端到端手测（无自动化替代）：起 dev server →
#    发一条消息看流式渲染 / 跑一个工具看结果卡片 / 触发一次审批卡 / 刷新页面看历史
```

### 各门守什么

| 门 | 抓什么 | 抓不到什么 |
|---|---|---|
| ② `tsc --noEmit` | 导出符号消失、签名变化、**扩展钩子名**（`pi.on("tool_call")` 是字面量类型） | 一切形态变化 —— 边界处全是 `as unknown as` |
| ③ 探针 | SDK 新增/删除**消息角色**、**内容块类型**；`CURRENT_SESSION_VERSION` 变化；已知形态漂移 | 运行期行为、真实数据 |
| ④ 手测 | 端到端行为 | 低频路径 |

### 缺口（当前无自动化，靠人）

- **会话文件兼容性**：`lib/types.ts` 是手抄的领域模型，`lib/session-reader.ts` / `lib/session-list-scanner.ts` 自己解析 JSONL。格式变了 → 探针的 ① 会红（若 `CURRENT_SESSION_VERSION` 跟着变），但它**不会**自动验证真实文件仍读得出。
  → 值得补：把一份冻结的真实会话文件放 `tools/fixtures/`，断言解析出的条数 / 类型分布 / 图片形态。
- **行为变化**：同名函数语义变了（如 0.85.0 的「固定会话范围」、thinking 行为调整）。只能靠手测 + 读 changelog。

### 回退

```bash
git checkout -- package.json package-lock.json && npm ci
```

`node_modules/` 与 `package-lock.json` 都进版本控制 / 可重建，回退无残留。（升级前若工作区有未提交改动，先 `git stash`。）

## 五、触发策略

**按需升级，不追版本** —— 理由充分才升：

- pi 修了影响我们的 bug
- 我们要的新能力（新模型、新钩子、新 SDK 接口）
- 距上次升级 > 2 个月（避免一次跳太多）

**跨版本原则**：

- 跨度 ≤ 2 个 minor：直接跳到目标版，跑一遍 ②③④
- 跨度 > 2 个 minor：逐版跑 ②③（廉价、可循环），④ 只在落点版做一次；哪一版 ②③ 变红就在哪一版停下来查

**至少每月查一次** `npm view ... version`（见第二节），别等积攒。

## 六、与全局 CLI 的关系

本机全局 CLI（飞书守护进程用）与网页内核是**两套独立安装**，版本可以不同：

```bash
pi --version                      # 全局 CLI
npm ls -g --depth=0 | grep pi     # 全局装了哪些
```

对齐它用 `npm i -g @earendil-works/pi-coding-agent@<X>`。注意改完要**重启守护进程**才会生效（版本是进程启动时加载的）。

截至 2026-10-03：网页内核 **1.0.0**（本轮升级）、全局 CLI **0.86.1**（待对齐） —— 档位暂不一致（CLI 对齐另行安排）。

### 1.0.0 升级记录（2026-10-03，chore/pi-1.0）

- **实测适配仅两处**（其余 API 全兼容）：① `prompt` 的 `preflightResult` 回调签名 `(success: boolean)` → `(disposition: "handled" | "queued" | "started")`（只在接受时触发；照 RPC 参考实现「任何 disposition = 接受」处理）；② `steer()` / `followUp()` 返回值 `Promise<void>` → `Promise<QueuedDisposition>`。改动集中在 `lib/pi-types.ts`（手写镜像）与 `lib/agent-runtime.ts`。
- **兼容性实测**：会话格式 `CURRENT_SESSION_VERSION = 3` 不变（老会话回放正常）；扩展钩子全在（10 个）；工具面不变（15 个，新内置扩展 mcp/codemode/tool-search 未进入 SDK 会话工具面）；审批闸门实测正常（工作区外写入弹卡、批准后执行）；`pi-hermes-memory` 的 `pi-tui` 依赖未观察到重复模块警告；dev 全日志 0 警告 0 错误。
- **升级前后跨 0.87 → 0.99 → 1.0**：上下文边界（ContextEditEntry）、codemode/MCP/虚拟模型/分类器（含内置 TypeSafe `jev-latest`）等新能力可用，供后续按需接入。

## 七、修改本手册的时机

- 探针断言全绿后 → 更新「已知缺口」小节（✅ 2026-09-21 已完成：角色缺口按「刻意不建模 + 白名单」归档）
- pi 改了发布方式（如出现 canary 通道）→ 更新第一、二节
- 补上会话兼容性夹具后 → 更新第四节的缺口列表
