# 单一真源与投影式 UI（v1）

状态：待 Elen 实施 · 提出：Jerry · 整理：Tom
日期：2026-11-12

## 为什么改

现在 ELENVA 有两处“自己生产数据”的地方：

1. 会话记录：Hermes 的 `state.db` 已经有这条 ACP 会话的完整记录（含工具调用、标题），
   ELENVA 又在应用包里写了一份 `data/chat.jsonl`。两套记录只能靠同步维持一致，
   实测已经不一致——刷新后工具输出和标题都丢了。
2. 领域数据：面板读 `data/*.json`，但文件的产生路径、schema、写入时机都没有硬约束，
   导致“界面先长出来，数据再由界面补”。

结论：路走反了。**数据由运行时/Agent 生产，UI 只做投影。** 这不是洁癖，是为了少一套
永远对不齐的状态。

## 不变量（违反就是走回头路）

1. **单一真源**：每类数据只有一个真相来源。UI 不得成为任何业务数据的写入方。
2. **投影是只读的**：UI 读真源、渲染、给空态；不“顺手”修数据、不缓存第二份业务数据。
3. **写入经过 Agent**：界面上的动作（按钮、编辑、确认）产出的是“意图”，交给 Agent 执行；
   Agent 落盘后广播一轮结束，UI 重新读盘。
4. **契约先于界面**：任何 UI 要渲染的数据，必须先有路径约定 + schema + 版本；
   没有契约的数据，界面不猜。
5. **界面状态不是业务数据**：视口、筛选、草稿、折叠状态属于 UI（localStorage 即可），
   不进真源、不进契约。

## 真源清单

| 数据 | 真源 | 谁写 | UI 怎么读 |
| --- | --- | --- | --- |
| 会话 / 消息 / 工具调用 / 标题 | Hermes `state.db`（sessions / messages） | Hermes 运行时 | 资源层按 profile 读 |
| 记忆 / 技能 / SOUL | profile 目录（`memories/*.md`、`skills/**`、`SOUL.md`） | Agent（经工具）或用户 | 只读投影（SOUL 可编辑=经 profile API） |
| 节律 / 定时任务 | `~/.hermes/cron/jobs.json` | Hermes / cron | 只读投影 |
| 领域数据（内容库、训练记录…） | 应用包约定的固定路径（见下） | **该 Agent 自己** | 只读投影 |
| 聚合卡片（status.json 等） | 派生文件，可从真源重算 | Agent 每轮末重算 | 只读投影 |

**已核实（2026-11-12 读 `state.db`）**：ELENVA 跑出来的会话确实在 `state.db` 里，但**不是**
`source='acp'`——那是 ACP 探针建的空会话（`message_count=0`）。真实会话是
`source='local'` + `cwd='<应用包目录>'`（例如 `/root/.elenva/agents/default`），
里面 user / assistant / `role='tool'`（带 `tool_name` 与 JSON 结果）齐全，标题、模型、
`tool_call_count` 也在。所以**识别口径用 `cwd`（或 profile + cwd），不要用 `source`**；
`message_count=0` 的会话忽略。

会话这一条落地后，`data/chat.jsonl` **删除**，不再写、不再读、不再迁移历史（历史在 state.db 里）。

## 领域数据契约（应用包 / Agent 之间）

每类文件必须能回答四件事，写进应用包的 `AGENTS.md` 与 `schemas/<name>.json`：

1. **路径**：绝对路径固定，或相对应用包根目录的固定相对路径。禁止“看情况放”。
   例：`data/log.json`、`data/journal/YYYY-MM-DD.md`、`data/training.json`。
2. **schema**：字段名、类型、必填、枚举。`schemas/<name>.json` 是唯一契约文件，UI 按它渲染。
3. **版本**：`schemaVersion`（整数）。UI 遇到不认识的版本必须显式提示“需要升级”，不得静默空白。
4. **写入口径**：只追加（新在前 / 新在后要写死）还是整份重写；只改目标条目，不整份覆盖。

写入要求：

- **原子写**：先写 `*.tmp` 再 `rename`，避免 UI 读到半份 JSON。
- **失败可见**：写失败要留痕（日志或返回错误），不静默吞掉。
- **派生文件不手改**：`status.json` 这类必须由 Agent 从真源重算，UI 不提供编辑入口。

## UI 边界

允许：

- 读真源 → 渲染（表格、时间线、卡片、文档）。
- 空态、加载态、错误态、schema 不匹配的降级提示。
- 动作按钮：把一段结构化 prompt 交给 Agent（现有 `actions[].prompt`）。
- 界面偏好：折叠、筛选、草稿、上次打开的视图。

不允许：

- 直接写业务数据文件（哪怕“只是改一个字”）。
- 为了渲染而在浏览器里维护一份业务数据的可变副本（可以缓存展示，但必须可随时丢弃）。
- 没有 schema 的字段“先显示着”。

## 发现与连接（同一份原则）

- Agent = profile。ELENVA 侧栏来自“连接端点报告的 profile 列表”，不是内置清单、不生成。
- 本地端点先做（localhost），远程端点保留同一接口 + token（v1 不实现鉴权）。
- 应用包降级为可选装饰：有包多一块面板，没有包退回通用工作台，不影响可用性。

## 迁移步骤（Elen 执行）

1. 宿主 `bin/acp-host.cjs`：移除 `chat.jsonl` 的写入与读取；`/history` 改为经资源层读
   `state.db`（按 `cwd` 过滤，忽略 `message_count=0`），或直接废弃该端点、前端改调
   `/api/agents/resources?kind=messages`。
2. 前端会话页：历史来源切到 `state.db`；保留 `turn_end` 事件用于“跑完重读”。
3. 资源层补两件事：按 `cwd` 认会话（不要用 `source`）；把 assistant 行的 `tool_calls`
   与 `role='tool'` 的 `tool_name`/结果拼成可渲染的工具调用序列。
4. 应用包：`data/chat.jsonl` 删除；`AGENTS.md` 增加“数据契约四件事”。
5. 文档：`docs/design-decisions.md` 增补第 14 条（单一真源与投影式 UI）。

## 验收标准

- 用只含 `default` 一个 profile 的干净 `~/.hermes` 启动：侧栏只出现 1 个 Agent。
- 跑一轮带工具与审批的对话；**刷新页面**后：消息、工具调用（含输出）、会话标题、耗时全部还在。
- 包内不再出现 `chat.jsonl`；`git grep chat.jsonl` 只剩文档里的说明。
- 把某个 `data/*.json` 写成非法 JSON：界面显示“数据格式不对”，不白屏、不静默空白。
- 把某个 schema 的 `schemaVersion` 改成未来版本：界面显示“需要升级”，不渲染错误数据。
- 断开 Agent 进程：会话页仍能浏览历史（只读投影不依赖运行时活着）。

## 阶段二：同一套会话外壳（与 Elen 的界面完全一致）

目标不是“看起来像”，而是**同一个组件、两个运行时适配器**。复制一份 ChatView 会立刻分叉。

要做到这一点，需要抽出两个接口：

1. **会话索引**：Pi 的会话文件与 Hermes 的 `state.db` 都投影成同一个 `SessionInfo`
   （id / title / cwd / 更新时间 / 条数 / 运行状态 / 来源）。侧栏、搜索、分组只认这个形状。
2. **运行时适配器**：`send / abort / 流事件 / 审批 / 模型 / 用量 / 上下文占用`。
   - Pi 侧：现有 `useAgentSession`。
   - Hermes 侧：新 `useAcpSession`，内部就是现在的 SSE + `/prompt` + `/permission`。

`ChatView` 只依赖这两个接口，界面部分（标题栏、`SessionSidebar`、`ChatWindow`、`ChatInput`、
`TurnFooter`、`TodoPanel`、`RailTabs`、`SessionObservatory`、`FilePreviewPanel`）一行不改。

好消息：`SessionObservatory` 已经是纯数据驱动（`messages / results / sessionStats / turn /
trends / contextUsage / cwd / gitInfo`），只要适配器产出这些字段就能直接复用；
`computeTurnTrends` 也是纯函数，可直接用于 Hermes 的 messages。

Hermes 侧需要产出的观测数据：

- `messages / results`：来自 `lib/acp-chat.ts` 的翻译结果。
- `sessionStats`：`state.db` 的 `input_tokens / output_tokens / tool_call_count / started_at`。
- `turn`：当前这一轮的步数、耗时、token（`turn_end` 事件已有）。
- `contextUsage`：ACP 的 `usage_update` 能给就用，给不了显示 null（不要编）。
- `trends`：`computeTurnTrends(messages)`。

验收：同一个会话分别在 Pi 与 Hermes 下打开，侧栏行、标题栏、消息区、观测栏的
`data-testid` 与关键文本结构一致；差异只允许出现在数据本身（模型名、工具名）。

## 参考：Ekko Studio 怎么做的（2026-11-12 查证）

- **像的部分**：一套 UI + 每个 runtime 一个适配器（`services/registry/native-agents.ts` 选配置与
  turn adapter，ACP 协议抽在 `protocol/acp/`，进程生命周期在 `services/runtime/`）；
  profile / 模型 / provider / workspace 都是 **session 级上下文**；审批、澄清、队列、abort、
  usage 共用同一条事件通道。
- **不像的部分**：会话**落它自己的 SQLite**（`sessions/messages` 表），文档原话是
  “不直接把 Hermes CLI 历史当作唯一状态”；删除会话时会连带尝试删掉 Hermes 那边的历史。
  也就是它选了“平台自有真源”，不是投影。
- **为什么**：它托管 14+ 种 runtime（Claude Code / Codex / Qwen…），历史格式各不相同，
  又要桌面 / 手机 / 网页多端一致，还要 scoped 模式（Studio 提供模型与凭据）。
  统一会话库是它多 runtime 的代价，不是普适原则。

**我们的取舍**：我们**已经有两个运行时**——Elen（Pi）和 Hermes profile（Tom 及以后新增的），
会话分别存在 Pi 的会话文件与 Hermes 的 `state.db` 里。所以不能只读一家，也不能因此就复制一份消息。

采用「薄索引 + 各自真源」：

- **索引层**（可重建、派生）：把两个运行时的会话投影成同一条 `SessionInfo`
  （id / runtime / profile / title / cwd / 起止时间 / 条数 / 运行状态 / 来源），供侧栏、搜索、分组使用。
  它只存元数据，不存消息正文。
- **正文层**：点开会话时，向它所属的运行时取消息（Pi 读会话文件，Hermes 读 `state.db`）。
  正文永远只有一份。

这样既不需要“平台自有会话库”（Ekko 为十四种 runtime 付的代价），也不会因为两种存储就把 UI 分叉。
真到需要跨 runtime 全文检索、多端一致或接第三方 runtime 时，再把索引升级成归一化消息库——
接口不变，UI 不改。

## 非目标（v1 不做）

- 远程端点的鉴权与多端点管理。
- 附件/图片上传。
- 应用包的市场化分发。
- 把 `state.db` 的读取做成跨机器同步。

## 风险

- `state.db` 是 Hermes 的内部结构：读取必须集中在一个模块（现有 `lib/agents/resources.ts`），
  升级 Hermes 时只改这一处；不要在多处散读。
- 删掉 `chat.jsonl` 后，历史依赖 `state.db` 的会话识别是否可靠——**口径是 `cwd`**；
  上线前先在三条真实会话上验证（含一条带审批、一条只有只读工具）。
