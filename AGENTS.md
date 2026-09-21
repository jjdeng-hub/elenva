# AGENTS.md

给在此仓库工作的 AI 编码助手的说明。**动手前先读这一页。**

## 项目是什么

ELENVA Web —— [pi coding agent](https://pi.dev) 的 Web 工作台。Next.js 应用，pi 内核以 npm 依赖形式**在同一进程内**驱动（不是子进程、不是 CLI 包装）。

**定位：个人工作台，自用优先。**作者自己每天在用，好不好用由这一次使用判定 —— 不按「产品」要求它，不迁就陌生人的上手成本，不为想象中的用户做妥协。

功能取舍只有一条判据：

> **每个新功能必须对应一次真实发生过的摩擦。**答不上来「我上一次真用到是什么时候」的，退出主线。

由此：

- 为「陌生人第一次打开」服务的能力（便携包 / 局域网密码 / 更新提示 / 首用引导）是**旁支**，可搁置，不因它们的存在而约束主线。
- **安装可靠性**（纯 JS、免编译）仍是硬约束：换台机器部署时自己同样不想装编译工具链（见下方「禁止引入原生模块」）。
- **素材是副产品**（项目过程会用于自媒体）—— 不要为了「能写一篇文章」而做功能。

## 技术栈

| | |
|---|---|
| 框架 | Next.js 16（App Router）+ React 19 |
| 样式 | Tailwind CSS v4 + CSS 变量语义 token |
| 类型 | TypeScript（strict） |
| 内核 | `@earendil-works/pi-coding-agent`（**精确锁定版本，不改 `^`**） |

## 硬约束

### 0. 启动脚本的编码规则（实测踩过，会静默出错）

`开发模式.cmd` / `bin/*.cmd` / `bin/*.ps1` 必须按下面的规则存：

| 文件 | 内容 | 编码 | 行尾 |
|---|---|---|---|
| `.cmd` | **只能 ASCII**（中文交给 Node / PowerShell 打印） | UTF-8 无 BOM | CRLF |
| `.ps1` | 可含中文 | **UTF-8 with BOM** | CRLF |
| `.js` | 可含中文 | UTF-8 无 BOM | 任意 |

为什么这么严（三条都是实测结论，不是讲究）：

1. **`.cmd` 里 `chcp 65001` + 中文 + 非 ASCII 文件名会错位**：`chcp` 改变代码页后，cmd 会
   **按路径重新打开批处理继续读**；中文文件名在新代码页下重新编码 → 字节对齐丢失 →
   从错误的偏移续读，**中文行被从中间截断当命令执行**，报
   `'xx这个窗口按' is not recognized as an internal or external command`。
2. **BOM 在 `.cmd` 里不可靠**：会看到 `'@echo off' is not recognized`（回显全开）。
3. **`.ps1` 不加 BOM，PowerShell 5.1 按系统代码页解 UTF-8** → 中文全是乱码。

改完怎么验：用桩跑一遍，看输出行数（与编码无关的判据，`grep` 中文报错会被 GBK 字节骗过）：

```bash
# node 用桩拦下来，不会真起服务
mkdir -p "$TEMP/nodestub" && printf '@echo off\r\necho STUB-NODE-CALLED %%*\r\nexit /b 0\r\n' > "$TEMP/nodestub/node.cmd"
PATH="$TEMP/nodestub:$PATH" cmd //c "$(cygpath -w "$(pwd)/开发模式.cmd")"
# 干净的一跑只应输出一行 STUB-NODE-CALLED，且无任何命令行回显
```

### 1. 禁止引入 `node-pty` 或任何原生模块

本项目当初从上游 fork 时**主动移除了终端功能**，换来的收益是：纯 JS 依赖、免编译、`npm i` 不会因原生模块构建失败。Windows 便携包能「解压即用」正是靠这一点。

如果要加终端类功能，先确认它不需要原生模块。

### 2. 样式必须走设计系统

**唯一来源**：`tools/design-system.html`（规范页）+ `app/globals.css`（语义类与 token）。

档位（不要发明新档）：

| 维度 | 允许值 |
|---|---|
| 字号 | 10 / 11 / 12 / 13 / 14 / 16 / 20 / 32（hero） |
| 圆角 | `sm` / `md` / `lg` / `card` |
| 间距 | 2 / 4 / 6 / 8 / 10 / 12 / 16 / 20 / 24 / 32（px，4 基准，2026-09-21 增） |
| 图标 | 10 / 12 / 14 / 16（强调）/ 20 |
| 动效 | `.t-fast` 120ms / `.t-base` 160ms / `.t-slow` 200ms |

语义类优先：`.card` / `.card-hd` / `.card-bd` / `.chip` / `.btn` / `.sect-title`。

聊天列宽由 `--chat-col`（`app/globals.css`）单独控制：**消息区与输入框必须共用它**，
各写一个 `max-w-*` 会让两者宽度不齐、看起来错位。

**禁止**：写死原生 Tailwind 色（`bg-white`、`text-red-500`）、半像素字号（`text-[11.5px]`）、渐变与装饰性循环动画。

图表/数据系列用 `viz-1..4` 派生色阶（2026-09-21 增）：纯红保留给动作、警示与选中态。

### 3. 深色模式零组件改动

深色通过 `[data-theme="dark"]` 重映射 CSS 变量实现。**组件里不要写 `dark:` 前缀**——写语义变量（`bg-panel`、`text-dim`），深色会自动生效。

### 4. 仓库边界：只放 Web UI 代码与工具

这个仓库会开源，且**隐私审计按全历史算**（`git log -p` 能把历史翻出来，删文件 ≠ 删历史）。所以：

| 能进仓库 | 不能进仓库（只留本机） |
|---|---|
| `app/` `components/` `lib/` `hooks/` `bin/` `public/` `extensions/` 源码 | **agent 产物**：session / 记忆（`USER.md` `MEMORY.md` `failures.md`）/ worklog / 运行数据 |
| `tools/` 里的项目工具（收敛脚本、打包、探针、评估夹具） | **技能**：`.pi/skills/` 一律不进；项目级技能放 `~/.pi/agent/projects-memory/<项目>/skills/` |
| 项目文档（`AGENTS.md` / `README.md` / `docs/*.md`） | **本机夹具与截图**：`tools/rev/`、`tools/shots/`、`public/_shots/` |
| | **个人数据**：真名 / 账号 / 卡号 / 手机号 / 本机绝对路径 / 提交信息里的个人决策 |

- 测试夹具用**明显虚构**的数据，并在文件里注明（例：`tools/memory-eval/cases.json` 的 `_disclaimer`）
- **提交信息也当公开文本写**：写「按用户决策…」，不写真名
- 收尾自查：对**全历史**扫一遍本机用户名 / 真名 / 邮箱关键词，必须 0 命中。关键词自己填 —— `git log --all -p | grep -iE "<用户名>|<真名>"`（把它们写进本文件反而是泄露）

## Agent 开发标准（2026-09-20 起）

ELENVA 的 agent 开发以 **《深入理解 AI Agent》（李博杰 著）为准绳**，不凭个人经验即兴发挥：
**凡与 Agent 相关的活儿（设计 / 改动 / 排查 / 评审 / 写方案）开工前一律先加载技能 `agent-book-reference`**，
按 `docs/agent-design-standard.md` 的闸门查书定位依据（章节 + 行号）；偏离书中做法必须写进该文件的
「偏离登记」并说明理由。查书入口：与 `pi-web-ui` 同级的 `ai-agent-book/`（入口 `LOCAL-README.md`）。

## 提交前必须验证

本项目**未接入 ESLint**（`npm run lint` 无效），用这两条兜底：

```bash
# 1) 类型检查：0 输出即通过
node ./node_modules/typescript/bin/tsc --noEmit

# 2) 设计系统收敛：0 改动即通过（幂等）
python tools/style-converge.py
```

改过 UI 后**两条都要跑**。`style-converge.py` 会自动修正越档的字号 / 圆角 / 图标 / 硬编码色 / 动效写法。

## 架构要点

- **内核同进程**：`lib/agent-runtime.ts` 里的 `startAgentSession()` 调 `createAgentSessionServices` / `createAgentSessionFromServices`。全项目在 `lib/` `app/` `components/` `hooks/` 内**零 `spawn`**（唯一例外在 `bin/`，用于启动 next）。
- **不要叫它 RPC**：本项目的「命令信封」（`send({ type: "prompt" })`）只是历史命名，实际是同进程函数分发，没有 JSON-RPC / stdio / 子进程。pi 确实有一个真正的 RPC 模式（`pi --mode rpc`，JSONL over stdin/stdout），**我们没用它**，走的是 SDK 的 `AgentSession` 本体。代码里残留的 `"rpc"` 字面量全部是 SDK 自己的枚举值（`ExtensionMode` / `InputSource`），必须原样传：
  - `setUIContext(ctx, "rpc")`、`bindExtensions({ mode: "rpc" })` → 告诉扩展「宿主是无头程序化界面」
  - `prompt(text, { source: "rpc" })` → 标记这条输入是程序发起的，不是用户在 TUI 敲的
- **加载是惰性的**：起服务不加载内核，打开会话才实例化，空闲 10 分钟回收（`PI_WEB_IDLE_TIMEOUT_MS` 可调）。
- **数据目录**：`~/.pi/agent/`（`getAgentDir()`）。与 pi CLI 共用同一份 sessions / auth / settings。
- **构建产物不进版本控制**：`dist/`、`.next/`、`node_modules/`、`*.tgz` 已在 `.gitignore`。

## 常见任务

| 任务 | 做什么 |
|---|---|
| 新增页面 | 在 `components/` 建组件 → `AppShell.tsx` 加视图与 hash 路由 → 侧栏加入口 |
| 新增 API | `app/api/<name>/route.ts`；若依赖 `cwd` 必须校验 `isExistingFilePathAllowed` |
| 改 `.cmd` / `.ps1` | **两套编码规则，别混**（见下）：`.cmd` 必须**纯 ASCII + 无 BOM + CRLF**；`.ps1` 必须 **UTF-8 with BOM + CRLF** |
| 改宿主提示词 | 先读 `docs/host-prompt.md`（收录规则、装配槽位、验证口径）；文本在 `lib/host-prompt.ts` |
| 改文案 | 直接改组件里的中文字符串（界面为纯中文，无 i18n 层） |
| 出新设计稿 | Ardot 画布 → 导出 PNG 到 `../design/`（设计资产不在本仓库） |

## 记忆约定

本仓库启用了记忆扩展 **`pi-hermes-memory`**（Hermes 风格：有界 + 分层 + 搜索，2026-09-19 从 `pi-memory` 换过来）。
**下面的东西要主动写进记忆，不必等用户开口**：

| 写什么 | 用什么 |
|---|---|
| 用户本人的偏好、习惯、沟通风格 | `memory_add` → `user`（`USER.md`） |
| 跨项目的结论、技术决定、环境事实 | `memory_add` → `memory`（`MEMORY.md`） |
| 本项目范围内的约定与踩过的坑 | `memory_add` → `project` |
| 什么没走通、为什么（免得重犯） | `memory_add` → `failure` |
| 可复用的做法（多步骤、以后还会用） | `skill_manage` → `create` |
| 顺手发现但本轮不修的问题 | **写进本页「已知待办」**（记忆没有便签层） |

- 内容**有字符上限**（画像 2500 / 长期 4000 / 项目 3000，见 `~/.pi/agent/hermes-memory-config.json`）：写满了先 `memory_replace` 合并、`memory_remove` 删旧的，别硬塞。
- 写简洁、写事实：记忆会注入**每一轮**上下文。用户说「记住」时立即写。
- 翻旧账用 `session_search`（历史会话全文搜）或 `memory_search`，不要往回翻文件。
- 每 10 轮对话或 15 次工具调用会自动复盘一次；用户纠错时会立即落盘。

> 分工：这里（`AGENTS.md`）是**用户手写**的规矩，进 git、随项目共享；
> 记忆在 `~/.pi/agent/pi-hermes-memory/`（全局：`USER.md` / `MEMORY.md` / `failures.md`）
> 与 `~/.pi/agent/projects-memory/<项目>/MEMORY.md`（项目级），是 **agent 自己写**的经历，本机私有、不进仓库。
> 网页「记忆」页展示这两处，**条目可直接编辑**（写入走 `/api/memory`，带配额校验、写前备份、并发检测）。
> 旧的 `~/.pi/agent/memory/`（pi-memory 那套）已停用，只作归档。
> 没装记忆扩展时，本节等同于无效指令（无害）。

### 工作记录（2026-09-20 起）

除记忆之外还有一层**工作记录**（扩展 `elenva-worklog`）：每轮把「最近一段工作 + 未完成待办」
作为**状态栏**注入上下文末尾（《深入理解 AI Agent》ch2 L851 的 Agent 状态栏；位置按 L914 追加在末尾而不是改 system）。

- **一段工作收尾时用 `worklog_write` 记一条**（目标 / 做了什么 / 证据 / 待办）；被问「做到哪一步了」时先 `worklog_read`
- 存储 `~/.pi/agent/worklog/<项目>.md`（滚动窗口 20 条，溢出进 `archive/`）
- 与记忆的分工：工作记录 = **情景记忆的当前段**（短期、滚动）；记忆 = **语义记忆**（长期、有界）—— 整理时把值得留下的提炼进记忆

## 已知待办

- **界面截图待用演示数据重拍**：原 6 张（`docs/screenshots/`）里有本机技能路径与用户名路径，已移出仓库；开源前需在干净环境重拍后放回
- 更新提示已指向 `elenva-web`，但**包尚未发布到 npm** → 发布后自动生效；发布仓库确定后填 `RELEASE_REPOSITORY`（`lib/app-update.ts`）即可出现跳转链接。**新定位下这条是旁支**：自用不依赖它，别为它做额外工作
- **故意保留**的 `pi-web:*` 标识：`lib/subagents.ts`、`lib/session-tool-selection.ts`、`lib/subagent-runtime.ts` 里的消息类型 —— 它们会被**写入会话文件**，改名会破坏已有会话的向后兼容
- **推送通知链路已移除**：`/api/push/*` + `lib/web-push.ts` 在界面侧从未接入，已连同上未启用的
  i18n 词条一起删除（`public/sw.js` 的 push 监听保留，重新启用时从 git 历史取回服务端即可）。
- **中文字数区间**：Markdown 渲染链（`lib/markdown.ts`）固定 `singleTilde: false`，
  否则 GFM 会把「100~200倍」当删除线。改动该文件时别丢掉这个选项。
- **图片形态（2026-09-21 已修复，分支 fix/image-shape）**：曾为活的雷——磁盘是平铺 `{type,data,mimeType}`、
  声明是 legacy `{source:{...}}`，从界面上传的图片刷新后渲染空图、编辑时静默丢失。现 `ImageContent` 与 SDK
  对齐（+客户端懒加载 `url`），legacy 仅读取层兜底；单点取数在 `lib/image-block.ts`（`imageData` / `imageBlockSrc`）；
  `tools/pi-surface-check.ts` 第④段已转绿。
- **飞书侧缺宿主层**：守护进程拉起的 `pi --mode rpc` 会话没有 ELENVA 的身份段与护栏（审批闸门/工具限制）。
  软提示入口是 `~/.pi/agent/APPEND_SYSTEM.md`（只对 CLI/飞书侧生效，不会重复注入网页会话）；硬护栏无现成入口。
- **记忆页已支持条目级编辑**（2026-09-20）：Agent 记忆（`USER.md` / `MEMORY.md` / `failures.md` / 项目记忆）
  每条可改 / 删 / 增，写入走 `PUT /api/memory` → `lib/agent-memory.ts`（并发校验 revision / 配额校验 /
  写前备份到 `~/.pi/agent/backups/memory-ui-*` / 原子写）；条目格式由服务端序列化，不会破坏 `§` + 元数据契约。
  未做：整文件源码模式；写入后 SQLite 检索镜像要等会话启动时由扩展对齐（常驻索引每轮直读文件，立即生效）。
