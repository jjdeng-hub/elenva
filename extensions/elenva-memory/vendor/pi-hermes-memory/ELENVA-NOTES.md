# ELENVA-NOTES — vendored `pi-hermes-memory`

本目录是上游扩展的结构性拷贝，随 ELENVA 记忆模块（`extensions/elenva-memory/`）一起分发，
用于「一模块一插件、维护权自持」——不再通过 `settings.packages` 依赖第三方包。

## 上游

| | |
|---|---|
| 包名 | `pi-hermes-memory` |
| 版本 | 0.9.9 |
| 作者 / 许可 | Chandra Teja · MIT（见同目录 `LICENSE`，原样随行） |
| 仓库 | https://github.com/chandra447/pi-hermes-memory |
| 搬迁范围 | 上游 `src/`（约 17,010 行）→ 本目录 `src/`，未改动目录结构（相对导入保持原样） |

**契约冻结（本模块内不得改）**：工具名（`memory_add` / `memory_replace` / `memory_remove` /
`memory_search` / `session_search` / `skill_manage`）、记忆文件格式（`\n§\n` 分隔 +
`<!-- created=…, last=… -->`）、`hermes-memory-config.json` 键名、`sessions.db` 结构与
快照命名（`.recovery-` / `.retired-`）。

## 本地改动清单（ELENVA-FORK）

每处改动在上游源码里都有 `ELENVA-FORK:` 注释。逐条：

1. **`src/store/sqlite-native.ts` —— 整文件重写：`better-sqlite3` → `node:sqlite`。**
   上游通过 `createRequire` 加载外部原生模块 `better-sqlite3`，并带一套 ABI 不匹配自动
   `npm rebuild` 的恢复逻辑。ELENVA 要求**零外部 npm 依赖、免编译**（`npm i` 不能要工具链），
   因此改为适配 Node 内置 `node:sqlite` 的 `DatabaseSync`：
   - 保留的 API 面：`new Database(path, { readonly, readOnly, fileMustExist, timeout })`；
     实例 `prepare(sql) -> {run,get,all,iterate}` / `exec` / `close` / `pragma(q,{simple})` /
     `transaction(fn)` / `backup(dest,{progress})`。
   - `pragma()` 用 `prepare("PRAGMA …")` 读、`exec("PRAGMA …")` 写；
     `transaction(fn)` 用 `BEGIN`/`COMMIT`/`ROLLBACK` 包装；`backup()` 用 `VACUUM INTO ?`
     （与上游 Bun 分支同法，无增量进度回调）；`fileMustExist` 用 `fs.existsSync` 预检；
     `timeout` 落成 `PRAGMA busy_timeout`。
   - 移除的导出（无其他引用）：`BetterSqlite3LoadError`、`isNativeModuleAbiMismatch`、
     `resolveBetterSqlite3PackageRoot`、`formatBetterSqlite3AbiError`、`SqliteNativeLoadOptions`。
   - 导出 `loadBetterSqlite3()` → `loadSqliteDatabase()`（仍惰性求值，不在模块加载期开库）。
2. **`src/store/db.ts`、`src/store/atomic-lock-coordinator.ts`、`src/extension-root-migration.ts`** ——
   跟随上面的重命名：`loadBetterSqlite3({ requireImpl })` → `loadSqliteDatabase()`。
   三者里 `isBunRuntime() ? … bun:sqlite …` 的分支**原样保留**（Bun 下仍是内置模块，不构成
   npm 依赖；ELENVA 只跑 Node，走的是 `loadSqliteDatabase`）。
3. **`src/store/memory-store.ts`（`decodeEntry`）** —— 正则 `.*?` + `s` 标志改为
   `[\s\S]*?`：ELENVA 的 `tsconfig` target 为 ES2017，`s`（dotAll）标志要 ES2018，否则类型门报
   `TS1501`。行为等价。
4. **`src/tools/shared-output-view.ts`** —— 内联 `strip-ansi` v7（其模式来自 `ansi-regex` v6）为
   本地 `stripAnsi()`，去掉外部依赖；调用点不变。
5. **未改动但已核对**：`@earendil-works/pi-tui`（`shared-output-view.ts`、`handlers/skills-command.ts`）
   与 `@earendil-works/pi-ai`（`tools/*`、`handlers/review-memory-ops.ts`）在扩展运行时**可解析**
   （agent npm 目录里有 `pi-tui`；`pi-coding-agent` 与我们的现有层一样由宿主提供），故**不降级**、
   保持语义不变。真机验证见交付汇报。

## 已知与上游不同的运行时特征

- `node:sqlite` 在 Node 里仍标注 experimental，首个进程会打印一条 `ExperimentalWarning`。
  ELENVA 选择容忍，不为静默它引入依赖。
- `node:sqlite` 返回的行对象是 null-prototype，`node:sqlite` 无 `DatabaseSync.backup()`；
  见第 1 条的处理。
- 上游的 ABI 自愈路径（node 版本与编译期不一致时 `npm rebuild`）随 `better-sqlite3` 一起移除——
  内置模块不存在 ABI 不匹配问题。

## R2 写路径闭环（ELENVA-FORK · 2026-10-17）

对应记忆 2.0 模块 2 补轮 R2r1。目标：让「写而不删」在机制上不再可能积债——未满先提醒、
满了给路径、复盘带着预算干活。**契约冻结项全部未动**（工具名 / 文件格式 / config 既有键名 /
快照命名 / `sessions.db`）；新增 config 键 `nearFullThreshold`（缺省 = 默认行为）。

逐条：

6. **`src/types.ts`** —— `MemoryConfig.nearFullThreshold?: number`（比值 0..1，或 0..100 视作
   百分比；`0` 关闭）；`MemoryResult.overflow?: boolean`（容量错误的机器可读标记，替代对
   本地化错误文案做 `startsWith` 匹配）；新增 `MemoryUsage { charCount, limit, percent, entryCount }`。
7. **`src/constants.ts`** —— `DEFAULT_NEAR_FULL_THRESHOLD = 0.85`；
   `MEMORY_BUDGET_MERGE_THRESHOLD_PERCENT = 85`；`MemoryBudgetRow` + `buildMemoryBudgetSection()`；
   复盘 / 直连复盘 / 巩固四段提示词补「预算段 + ≥85% 必须产出合并/精简、不允许只追加」规则；
   复盘侧顺带并进「好记忆三标准」（applicable / durable / legible）短版。
8. **`src/config.ts`** —— 解析 `nearFullThreshold`（0..1 原样、>1 且 ≤100 除 100，其余忽略），
   缺省写进 `DEFAULT_CONFIG`。
9. **`src/store/memory-store.ts`** —— 写结果侧三件事：
   - 新增公开 `getUsage(target)`（供复盘/巩固提示词读每目标水位）；
   - `successResponse()` 在**成功**返回上附近满预警（`warning` / `warnings`，并经由
     `finalizeTargetMutation` 並入 `message`）：`⚠ MEMORY.md 水位 92%（4600/5000）——建议本次会话内
     合并/精简；示例对象：「…」（n 字符）`；覆盖 memory / user / failure（项目 store 同代码路径），
     与 cap 是否 enforce 无关（policy-only 下同样提醒）；
   - `memoryFullError()` / `replaceUnlocked()` / `applyMutationPlan()` 的溢出错误升级为结构化引导：
     水位 + 限额 + **需腾出字符数** + `memory_replace` 合并配方 + `memory_remove` 淘汰配方 +
     最长 3 条候选（摘要 + 字符数），并标 `overflow: true`；
   - `addWithConsolidation()` 的 grace / deferred / failed / 未腾够 四条文案同样附「按上面的配方
     手动腾空间」指引；判overflow 改用 `result.overflow === true`（不再对错误文案做前缀匹配）。
   - 红线：**不自动截断、不自动删**；`fifo-evict` 仅调用签名多传 projectedTotal，行为不变。
10. **`src/handlers/background-review.ts`** —— `ReviewPromptInput` 新增可选 `budget`；
    `setupBackgroundReview` 每目标读 `store.getUsage()`（+ 项目 store）拼成
    `{label, charCount, limit, percent, entryCount}`，注入 subprocess 与 direct 两条 prompt 的
    `--- Memory Budget ---` 段。
11. **`src/handlers/auto-consolidate.ts`** —— `buildConsolidationPrompt()` 与直连巩固的 user prompt
    都带上预算段（数字来源 `store.getUsage(target)`）。

本轮自测：`extensions/elenva-memory/selftest-r2.mjs`（50 断言：水位矩阵 × add/replace/remove、
引导回路 E2E、复盘输入断言）。

### R2 收尾：cap 解耦 + 配额口径统一（ELENVA-FORK · 2026-10-17）

12. **`src/types.ts` / `src/config.ts` / `src/store/memory-store.ts` —— `enforceCharLimit`（默认 true）。**
    原 `capEnforced` = `memoryMode !== "policy-only"`：现网 config 是 `policy-only`，于是写路径
    **完全没有硬限**，`reject` / `auto-consolidate` / 满额引导实际休眠，索引层「满额会硬拒写入」
    与控制路径口径不一。现改为 `capEnforced = config.enforceCharLimit !== false`，
    **policy-only 的语义收窄为「只关注入」**，配额照常执行。`enforceCharLimit: false` 可回旧行为。
    这是**有意的行为变更**：写路径从本版起真正设防（缺省 true）。
13. **配额默认值同源（`extensions/elenva-memory/stores.ts`、`lib/agent-memory.ts`）——**
    索引侧 / 网页记忆页原来自写默认值（memory 4000 / user 2500 / project 3000），与 vendor 的
    `DEFAULT_*_CHAR_LIMIT`（5000/5000/5000）不一致 → 同一份文件的「水位」在两处对不上。
    现将默认值统一 import vendor 常量（**唯一来源**）；**显式配置时零行为变化**（两边都读
    `hermes-memory-config.json` 的显式值）。`lib/agent-memory.ts` import 的 constants 模块只有
    一个 type-only import，无运行时依赖，Next 打包无负担（`lib/` 早有 import 扩展 TS 的先例）。

补充自测：`selftest-r2.mjs` 第 4 节（policy-only + enforce 默认 → 拒绝可达且带引导；
`enforce=false` → 旧行为；键缺省 → 执行；两处水位同源 + 显式配置零变化）；
`tools/memory-quota-selftest.mjs` 默认值同步为 5000 / failures 10000。

> **现场发现（本轮已决策修复）**：ELENVA 现网 config `memoryMode = "policy-only"` 一度使
> `capEnforced = false`，`memory_add` 不会被硬拒、`reject`/`auto-consolidate` 路径休眠。R2 收尾已把
> `capEnforced` 与注入模式解耦（见第 12 条）：`policy-only` 只管「不注入全文」，配额默认执行。
> 近满预警不依赖 cap，两者现在都生效。

## R2r2 失效标记（ELENVA-FORK · 2026-10-17）

对应记忆 2.0 模块 2 补轮 R2r2。目标：「写而不删」的另一半 —— 删除退居最后手段，常规治理 =
**标记失效**（历史可查、可回溯、可恢复）。契约冻结项全部未动（工具名**新增**一个 `memory_status`、
文件格式**向后兼容**地追加可选字段、config 既有键、快照命名、`sessions.db` 结构）。依据（简化版
Graphiti 双时序 + ch3 L505「证据不足不强行收敛」）。

**格式（可选追加字段）**：`<!-- created=…, last=…[, project64=…][, invalidated=YYYY-MM-DD][, reason=…] -->`
- 未失效条目**序列化字节与旧版一致**（新字段完全不出现）；
- 旧格式（无 `invalidated`）解析为**有效**（兼容红线）；非法日期同样降级为有效；
- `reason` 写入时归一：压空白、逗号→全角、`-->`→`→`、`>`→`＞`、截断 120 字符（避免破坏注释分隔）。

14. **`src/store/memory-store.ts`** —— 导出 `parseEntryMetadata` / `normalizeInvalidationReason` /
    `INVALIDATION_REASON_MAX`；`encodeEntry` / `decodeEntry` 支持 `invalidated`/`reason`；
    `getInvalidatedEntries()`；`getMemoryEntries/getUserEntries/getAllFailureEntries` 新增
    `{includeInvalidated}`（默认排除）；快照注入（`loadFromDisk` / `formatProjectBlock`）排除失效条目；
    `getFailureEntries` 排除失效条目；`nearFullAdvisory` 报失效条数；
    **新增 `setStatus(target, oldText, 'invalidate'|'restore', reason?)`**（走 `runTargetMutation`
    加锁 + 触发 SQLite 对账），状态变更**不跑内容扫描、不受 cap 限制**（满额时「忘掉」仍必须可行）。
15. **`src/store/sqlite-memory-store.ts`** —— `parseMetadataComment` / `parseMarkdownMemoryEntry`
    识别可选 `invalidated`；`reconcileMarkdownMemoryScope` **跳过失效条目**（于是 SQLite 镜面里不存在，
    `memory_search` 默认查不到）；恢复时随下一次对账重新插入（Markdown 仍是 source of truth）。
16. **`src/types.ts`** —— `MemoryUsage.invalidatedCount?`；`MemoryMutationOperation.action` 增
    `"invalidate"`（+ `reason`）。
17. **`src/store/memory-store.ts` 的 `applyMutationPlan`** —— 原子计划支持 `invalidate`（供复盘/
    巩固的直连 JSON 操作走原子路径）。
18. **`src/handlers/review-memory-ops.ts`** —— `ReviewMemoryOperation.action` 增 `"invalidate"`（+ `reason`）；
    解析与应用都支持 `setStatus(..., "invalidate", ...)`。
19. **`src/tools/memory-tool.ts`** —— 新工具 **`memory_status`**（`invalidate` / `restore` / `list`），
    复用项目 store 解析、错误目标提示与工具结果渲染。
20. **`src/constants.ts`** —— policy 提示词（full/compact）与 `MEMORY_TOOL_DESCRIPTION`、`<available-memory-tools>`
    增补 `memory_status` 与「忘掉 = 标失效（可恢复）；物理删除仅限明确要求或纯噪声」；
    复盘 / 复盘 system / 巩固 / 巩固 system 四段提示词的「删除被推翻的事实」升级为
    「先标失效（附 reason）；合并近重复照旧；物理删除仅限明确指示或纯噪声」；
    直连 operations schema 增 `action:"invalidate"` + `reason`。

本层（`extensions/elenva-memory/`）与 Web 侧另见其源码注释；本轮自测：
`selftest-r2b.mjs`（71 断言：格式兼容 / 隔离 roundtrip / SQLite 镜面 / 提示词 / tidy 分流 /
Web 消费方降级 / E2E「忘掉 X」全链）。

## R3 检索升级：三层渐进披露 + 索引可重建（ELENVA-FORK · 2026-10-17）

对应记忆 2.0 模块 2 补轮 R3。目标：让「按需取」真正分级（先看有哪些、再取正文），并把
`sessions.db` 从「坏了没法修」变成「一条命令可重建 + 对账」。**契约冻结项全部未动**
（工具名 / 文件格式 / config 既有键名 / 快照命名 / `sessions.db` 结构）。

本轮改动**全在层（`extensions/elenva-memory/`），vendor 源码未改**——`memory_find` 是层自己注册的
工具，`/memory-reindex` 只是调用 vendor 已有的 `indexAllSessions` / `syncMarkdownMemoriesToSqlite` /
`DatabaseManager`。逐条：

21. **`search.ts`** —— 三层输出：
    - **L2 清单层** `renderSearchList(hits, query, {budgetChars})`：每条一行
      `- [SCOPE #短id] 日期 · ≤90 字符摘要 · 标注（引用/失效/冲突）`；默认预算 2000 字符，
      超限截断并显式写「还有 N 条未展开：收窄查询，或用 ids 取详情」。
    - **L3 详情层** `findEntriesByIds` + `renderSearchDetails`：按 id（或 6 位短 id 前缀）精确取详情卡；
      **恒含失效条目并标注**（显式召回不被默认排除挡住）；未命中 id 有回执。
    - **兼容开关** `renderSearchResults` 原样保留（`full: true` 回旧行为）。
    - 新增 `summarizeForList`（确定性截断，与索引层同款）、`DEFAULT_LIST_BUDGET_CHARS` / `LIST_SUMMARY_MAX`。
22. **`index.ts`（`memory_find` 工具）** —— 参数增 `ids` / `full` / `budget_chars`；`query` 改为可选
    （ids 模式不需要）；默认输出改清单（`details.mode = "list" | "ids" | "full"`）；清单默认 limit 10、
    full 默认 5（ids 忽略 limit）。`include_invalidated` 只作用于 list/full，ids 模式恒含失效条目。
23. **`reindex.ts`（新）** —— `/memory-reindex`：先备份 `sessions.db`（含 `-wal` / `-shm`）到
    `<memoryDir>/backups/sessions.db.reindex-<时间戳>` → FTS5 `'rebuild'` 重建 `message_fts` / `memory_fts`
    → 强制对账 Markdown 记忆镜像 → 从会话 JSONL 全量补齐（遵守 retention）→ 对账。
    - **FTS 完整性口径**：用 `INSERT INTO <fts>(<fts>, rank) VALUES('integrity-check', 1)`，
      **不用「FTS 行数 vs 内容表行数」**——外部内容表的 `SELECT COUNT(*)` 读的是内容表，
      索引被清空时照样返回内容表行数（实测，测不出坏索引）。
    - 对账项：磁盘会话文件 vs `sessions` 行、Markdown 全局条目 vs 镜像行、两个 FTS 的 integrity-check。
    - 幂等：第二次跑增量为 0、计数不变；`renderReindexReport` 输出人读报告。

本层自测：`selftest-r3.mjs`（47 断言：三模式 / 预算截断 / 清单标注 / ids×失效 / token 对比 /
reindex 幂等 + 对账 + 损坏恢复）；隔离 E2E：`e2e-r3.mjs`（19 断言，装扩展后真跑注册面）。

## R4 面板治理与周期整理（ELENVA-FORK · 2026-10-17）

对应记忆 2.0 模块 2 补轮 R4（末轮）。**vendor 源码未改**——本轮改的是本层与 Web 侧：

24. **`tidy.ts` / `tidy-cli.mjs`（本层）** —— 新增 `renderWeeklyProposal()` 与 `--weekly`：
    四段式「周整理提案」（水位含上次整理对照 / 失效条目可清出与预计释放字符 / 近重复与冲突候选 /
    一句确定性建议）。只读：不写任何文件、不调模型；`--weekly` 与 `--apply` 互斥。
    `selftest.mjs` 补 3 条断言（共 47 通过）。
25. **Web 侧**（`lib/agent-memory.ts` / `app/api/memory/status` / `components/MemoryPage.tsx`）：
    条目级「标失效 / 恢复」——单条原子（按正文精确匹配、只翻转目标条目、复用备份/revision/原子写），
    并**豁免配额校验**（满额逃生口，与 vendor `setStatus` 同口径）。自测
    `tools/memory-status-selftest.mjs`（11 项）。修了一处序列化器活雷：`null` 曾被 `??` 当「未指定」
    而沿用了旧失效日期，导致恢复失效——现区分 `undefined`（沿用）/ `null`（显式清除）。
26. **节律**（`lib/schedules` 存储，非本层代码）：本机挂「记忆周整理（只读）」任务
    （weekly 周一 09:40，`safety=readonly`），run-now 真跑出四段提案。实测只读档会拦下
    `node <脚本>` 与 `memory_find`/`memory_status` —— 任务提示词改走 `node -e 'import("./…")'` + `cat`/`grep`。
