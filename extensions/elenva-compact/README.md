# elenva-compact —— Claude Code 式上下文压缩机制（pi 扩展）

把 Claude Code 的上下文压缩机制（微压缩 + 结构化摘要 + 状态重建 + 阈值触发）复刻进 pi，
以扩展形态实现：不改 pi 内核、不碰 node_modules。机制与结构对齐 CC 逆向报告，代码与文案全部重写。

## 三件套

### ① 微压缩（`context` 事件）

每轮 LLM 调用前检查历史里的大工具结果：`read / bash / powershell / grep / find / edit / write / ls`
的结果若为纯文本，按下面的策略替换成指针文本（内容落盘，需要时用 `read` 工具回读）：

- **保留最近 3 次调用**不压（对齐 CC kd5=3）
- 从最旧开始压，直到「未压缩旧结果总量 ≤ 预算」（默认 40000 token，对齐 CC vd5=40k）
- 自动模式门槛：当前上下文已过提示线（窗口 − 20000）**且**本轮预计省 ≥ 20000 token（对齐 CC yd5）；两条不满足则只重放已落盘指针、不新增
- **幂等**：落盘路径 = `<agentDir>/compact-cache/<sessionId>/<toolCallId>.txt`（确定性路径 + 文件存在即跳过写入），多轮重放同一指针、不重复落盘；会话重启后凭文件存在性恢复
- 含图片块的工具结果**不压**（避免丢视觉上下文）；`isError` 为真的结果不压
- 非破坏式：只改本轮出站消息，会话文件里保留原文

### ② 摘要升级（`session_before_compact`）

pi 触发压缩（原生阈值 / 手动 `/compact` / 本扩展补触发）时，接管摘要生成：

- 提示词要求**先 `<analysis>` 分析、后 `<summary>` 输出**；`<summary>` 按 CC 式 **9 段结构**
  （Primary Request and Intent / Key Technical Concepts / Files and Code Sections / Errors
  and fixes / Problem Solving / All user messages / Pending Tasks / Current Work / Optional Next Step），
  引导语对齐 CC（「paying close attention to the user's explicit requests and your previous actions」）
- `<analysis>`/`<summary>` 标签解析清洗为 `Analysis:` / `Summary:` 文本段；`<summary>` 缺失或为空 →
  返回 undefined 走 pi 默认压缩（**绝不吞会话**）
- `/compact [instructions]` 的自定义指令进入提示词与续接摘要的 **Additional Instructions:** 段
- 续接摘要组装：
  - 续接头「This session is being continued from a previous conversation…」（对齐 CC 关键句）
  - **转录回读指针**：本会话 session jsonl 路径，模型可用 read 工具直接读全量转录
  - **续跑句按 reason 分流**（对齐 CC 双参数语义）：threshold / overflow 附「Please continue the
    conversation from where we left it off without asking the user any further questions…」，manual 不附
  - 摘要模型默认同当前模型（`PI_ELENVA_SUMMARY_MODEL` 可换）；生成失败的 usage 回传计入
    会话统计（`CompactionEntry.usage`）

### ③ 状态重建（不迷路）

摘要尾部附上从会话与磁盘重建的「你刚才在哪」：

- **近期文件回注**：从 `preparation.fileOps` 取最近触碰的文件，直接回注磁盘内容，
  上限：≤5 个文件 / 总量 ≤50k token / 单文件 ≤5k token（截断附「用 read 读全文」提示）
- **待办回注**：从会话条目提取 `elenva-todo` 的最新清单（`[ ]` `[>]` `[x]` 标记对齐）
- 其它会话态（如后台任务）：pi 会话条目没有登记处，**如实注明未重建**，不编造

## ④ 触发与提示

两条触发线并存（README 前文与 `trigger.ts` 头注同口径）：

| 线 | 定义 | 生效时机 |
|---|---|---|
| pi 原生 in-run | `window − reserveTokens`（默认 16384） | agent run 内轮间检查（pi 内建，无扩展时也生效） |
| 本扩展补触发 | `window − 13000`（或 `PI_AUTOCOMPACT_PCT_OVERRIDE` 按 `%` × 窗口） | **run 完全结算后**（`agent_settled`）检查，补 pi「tool batch 终结即 run 结束、无排队消息时跳过检查」的缝隙 |

为什么补触发不在 run 中途点火：v0.86.1 的 `ctx.compact()` 会**先 abort 当前 agent 操作再压缩**
（agent-session.js compact docstring），中途点火等于掐断正在收尾的 turn；且 run 结束后不再有
`turn_end`，所以触发挂在 `agent_settled`（实测 `-p` 与 RPC 下 turn_end 在结算前均 isIdle=false）。
`-p` 一次性进程会在退出时收回在途压缩（竞速），长驻会话（TUI / RPC / 飞书守护进程）可靠。

扩展触发带一个哨兵 customInstructions，在 `session_before_compact` 里识别：pi 把扩展触发的
`ctx.compact()` 记为 reason=**manual**，识别哨兵后按 threshold 处理（附续跑句），哨兵不展开为附加指令。

- 状态行（对齐 CC）：`Context left until auto-compact: X%`（相对触发线的倒计时）
- 低上下文警示（对齐 CC 文案）：剩余 <20% 时提示一次 `Context low (X% remaining) · Run /compact to compact now`

## ⑤ 命令

- `/context` —— 用量 / 触发线 / 微压缩统计（次数、省 token）/ 压缩历史（本会话 compaction 条目）
- `/microcompact [budgetTokens]` —— 手动微压缩：下一轮调用前应用（手动模式跳过自动门槛）

防冲突：斜杠命令进行路由时若与宿主版本内建命令重名，注册会失败并打一条 console 提示（不挡启动）。

## 安装

```bash
node extensions/elenva-compact/install.mjs            # 安装 / 更新（进 <agentRoot>/extensions/elenva-compact/）
node extensions/elenva-compact/install.mjs --uninstall # 卸载
node extensions/elenva-compact/install.mjs --print-path
node extensions/elenva-compact/selftest.mjs            # 纯函数自检（71 项）
```

安装后 TUI / 飞书守护进程 / ELENVA web 的下次会话加载即生效；同目录的 elenva-* 扩展共存无冲突。

## 环境变量（全部可选）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PI_ELENVA_COMPACT_DISABLE` | — | `=1` 整扩展静默（不注册行为） |
| `PI_ELENVA_MICRO_DISABLE` | — | `=1` 关微压缩（摘要升级保留） |
| `PI_ELENVA_MICRO_BUDGET` | 40000 | 微压缩「剩余 ≤ 预算」目标（token） |
| `PI_ELENVA_KEEP_RECENT` | 3 | 微压缩保留最近 N 次调用 |
| `PI_ELENVA_COMPACT_TRIGGER_DISABLE` | — | `=1` 关扩展侧补触发 |
| `PI_AUTOCOMPACT_PCT_OVERRIDE` | — | 触发线按窗口百分比覆盖（1..100，对齐 CC 同名变量语义） |
| `PI_ELENVA_SUMMARY_MODEL` | — | 摘要模型 `"provider/id"`；默认同当前模型 |

pi 侧设置（`settings.json` 的 `compaction.enabled / reserveTokens / keepRecentTokens`）照常有效：
扩展侧补触发不看 enabled，但与原生两条线互补；摘要升级不依赖设置。

## 遥测

本会话相关事件按行追加到 `<agentDir>/elenva-compact-log.jsonl`（纯本地，不上传）：

```json
{"ts":"...","kind":"microcompact","sessionId":"...","tools":3,"tokensSaved":20985,"reemit":0,"budget":9000,"trigger":"auto"}
{"ts":"...","kind":"compact","sessionId":"...","reason":"threshold","pre":65837,"usage":{...},"ms":8,"summaryTokens":152}
{"ts":"...","kind":"compact_failed","sessionId":"...","reason":"manual","stage":"session","aborted":true}
```

## 与 Claude Code 的对照

| 机制 | Claude Code | 本扩展 |
|---|---|---|
| 微压缩工具集 | Read / Bash / Grep / Glob / WebSearch / WebFetch / Edit / Write | read / bash / powershell / grep / find / ls / edit / write（见下映射） |
| 保留最近 N 次调用 | 3（kd5） | 3（`PI_ELENVA_KEEP_RECENT`） |
| 微压缩预算 | 40000（vd5），自动默认 | 40000（`PI_ELENVA_MICRO_BUDGET`） |
| 自动模式最小节省量 | 20000（yd5） | 20000 |
| 自动模式武装线（提示线） | 预算 − 20000（md5） | 窗口 − 20000 |
| 自动触发线 | 预算 − 13000（Pz0），可用 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 覆盖 | 窗口 − 13000 / `PI_AUTOCOMPACT_PCT_OVERRIDE` 百分比 |
| 替换文案 | `Tool result saved to: <path>` + `Use Read to view` | `Tool result from <tool> saved to: <path>` + `Use the read tool…`（同风格重写） |
| 摘要模板 | 9 段 + `<analysis>`/`<summary>` 两段式 | 同结构，9 段段名对齐，措辞重写 |
| 解析清洗 | `<analysis>`→`Analysis:`、`<summary>`→`Summary:`、压空行 | 同行为 |
| 自定义指令 | 追加 `Additional Instructions:` | 同（提示词 + 续接摘要） |
| 续接三件套 | 续接头 + 转录全文回读指针 + 按 trigger 分流的续跑句 | 续接头 + session jsonl 回读指针 + 按 reason 分流（manual 不附） |
| 状态重建 | 最近 5 文件 / 总量 50k / 单文件 5k + 待办 + 计划/子代理 | ≤5 文件 / 50k / 5k + 待办（elenva-todo）；后台任务如实注明未重建 |
| 手动压缩附加件 | `/compact [instructions]`，manual 不续跑 | `/compact [instructions]`，manual 不续跑 |
| 遥测 | tengu_microcompact / tengu_compact | `<agentDir>/elenva-compact-log.jsonl`（本地 jsonl） |
| 会话记忆路径（sm-compact） | flag 门控的 10 段会话笔记 | 未实现（CC 侧本身实验路径） |
| 硬阻断线 | 窗口 − 3000，拒发 | 未实现（pi 原生 overflow 处理兜底） |

## 工具名映射（CC → pi）

| Claude Code | pi | 备注 |
|---|---|---|
| Read | `read` | — |
| Bash | `bash`（Windows 构建为 `bash` / `powershell`） | — |
| Grep | `grep` | — |
| Glob | `find` | pi 的 find ≈ CC 的 glob |
| Edit / Write | `edit` / `write` | — |
| （CC 无对应） | `ls` | 与 find 同类的只读列举，一并纳入 |
| WebSearch / WebFetch | —（pi 无内建） | — |

mcp / 扩展自定义工具（`mcp__*` 除外判（其结果形态不限通配））一律**不在**白名单，不会被微压缩。

## 与其它扩展的交互

- `elenva-todo`：微压缩不碰 `todo_write`；摘要升级从会话条目复读它的最新清单（互不占用钩子）
- `elenva-worklog` / `elenva-skills` / `elenva-memory`：钩子面无交集（turn_end/status 仅本扩展占用）
- `pi-hermes-memory`：其记忆注入在 system/尾注层，压缩摘要走 user 消息流，不冲突
