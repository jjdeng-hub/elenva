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
