# Agent 名册：profile 发现 · 接入 · 创建 · 删除

日期：2026-11-12 ｜ 决策：Tom ｜ 实施：Elen ｜ 状态：待批

## 问题

规格里写的是「Agent = profile，侧栏来自 profile 列表，应用包只是可选装饰」，
实现却把**应用包当成了入场券**：只有手写过 `~/.elenva/agents/<id>/manifest.json` 的
profile 才出现在 ELENVA 里。

结果：本机五个 profile，只有三个有包（`default` / `content` / `house`），
`builder`(Rig) 与 `reflector`(Lens) 明明在本机活着（各有 5 / 4 个会话），ELENVA 里根本不存在；
还有一个 0 会话的死 profile `justin`，也没人知道它是死的。

而且用户要在 ELENVA 里**新建/删除 profile**，这是产品能力，不该靠人 SSH 上去敲 CLI。

## 一、发现（只读，不改任何东西）

数据源：

- `~/.hermes/`（default profile）
- `~/.hermes/profiles/*/`（命名 profile）

每个目录的判定：

| 事实 | 来源 |
| --- | --- |
| 是否可用 | 存在 `config.yaml` |
| 显示名 | 包里的 `manifest.name` > `SOUL.md` 首个标题（`# SOUL —— Tom` / `# SOUL —— Justin（编码 Agent）`）> profile id |
| 模型 | `config.yaml` 的 `model` |
| 会话数 / 最后活动 | `state.db` **只读** `select count(*), max(coalesce(last_activity_at, started_at)) from sessions` |
| 是否接入 ELENVA | `~/.elenva/agents/*/manifest.json` 里 `profile == <id>` |
| 是否有消息通道 | 该 profile 目录下存在 `platforms/` 或有 gateway 服务（只做提示，不参与判定） |

规则：

- 发现层**只读**，不碰 Hermes 的任何文件
- 结果缓存 5 秒，`count(*)` 单条查询，绝不 `select *`
- 发现不等于接入：未接入的 profile 在名册里显示「未接入」+ 会话数，不参与侧栏 Agent 切换

## 二、接入 / 断开

- **接入** = 生成 `~/.elenva/agents/<profileId>/manifest.json`，写
  `{ id, name, runtime: "hermes", profile, version: "0.1.0" }`，可选写 `views`（没有就用通用工作台）
- **断开** = 只删这个 manifest（连同该包目录下的 `data/`），**profile 与它的会话一条不动**
- 两个动作都要二次确认；断开的确认文案必须写明「只移出 ELENVA，Hermes 的数据不删」

## 三、创建 profile

表单字段：

- `id`：`^[a-z][a-z0-9-]{1,30}$`，实时查重（磁盘上已存在就红）
- 显示名（写进 SOUL 标题）
- SOUL 正文：空白模板 / 从现有 profile 复制（`--clone-from`）
- 模型：从 `/api/agents/chat/models` 的清单里选
- 「创建后立即接入 ELENVA」勾选框，默认勾上

后端执行顺序（**先建后写，失败回滚**）：

1. `hermes profile create <id> [--clone-from <src>] --no-alias`
2. 写 `SOUL.md`（标题 + 正文），写 `config.yaml` 的 `model`
3. 若勾选接入 → 写 manifest
4. **任一步失败 → 删除本次新建的目录**（仅当本次创建），不让半成品留在 `profiles/` 里

明确不做：

- **不自动创建飞书/QQ/微信通道**。那需要用户自己的 app 凭据，必须走 `hermes gateway setup`。
  创建完成后给一句提示：「本地可用；要接消息平台请在设置里配通道」
- 不创建 gateway 服务（`--no-alias`，也不 enable systemd unit）

耗时：`profile create` 要拷 skills，可能 5~20 秒 → 走异步任务 + 轮询进度，不要占着 HTTP 请求。

## 四、删除 profile（最危险的动作，四重保护）

1. **先归档**：`hermes profile export <id> -o ~/.hermes/backups/profiles/<id>-<ts>.tar.gz`
   归档失败 → 中止，不删
2. **输入法确认**：要求输入 profile id（不是点两下按钮）
3. **拒绝条件**：
   - `default`（Hermes 自己就拒绝）
   - 该 profile 有会话正在跑（`/api/agent/running` 或该 profile 的 ACP 会话活跃）
   - 该 profile 被 live gateway 服务中（提示先 `systemctl --user stop hermes-gateway-<x>`）
4. **删后收尾**：删 manifest（等于自动断开），从名册移除；归档文件留在
   `~/.hermes/backups/profiles/`，在「回收站」列表里可一键恢复（`hermes profile import`）

删除语义写死在 UI 文案里：**「归档并删除」**，不是「删除」。用户看到的永远是「可以恢复」。

## 五、API（全部要求登录态）

- `GET  /api/profiles` → 发现列表（含接入状态、会话数、最后活动、是否有通道）
- `POST /api/profiles` → 创建（body：`{id, displayName, soul, cloneFrom?, model?, connect?}`）
- `POST /api/profiles/:id/connect` / `disconnect`
- `DELETE /api/profiles/:id` → body `{confirm: "<id>", archiveOnly?: boolean}`
- `GET  /api/profiles/archives` → 归档列表
- `POST /api/profiles/import` → 从归档恢复

安全：

- `:id` 必须过 `^[a-z][a-z0-9-]{1,30}$`，拒绝任何含 `/`、`..` 的输入（路径穿越）
- 所有写操作串行化（一个全局锁），避免两个请求同时 create/delete 同名
- 审计：每次 create/delete 追加一行到 `~/.elenva/audit.jsonl`（时间、动作、id、结果）

## 六、界面

位置：设置 → 「Agent 与 Profile」（也接受从 Agent 名册右上角「管理」进入）

每一行：

- 左：显示名 + `profile id` + 状态点（已接入 / 未接入 / 未运行 / 有通道）
- 中：模型 · 会话数 · 最后活动
- 右：`接入` / `移出 ELENVA` / `删除…`

创建：右上角 `+ 新建 Agent` → 抽屉表单，创建完直接跳到新 Agent 的会话页。

删除：弹窗里必须出现归档路径与会话数，输入 id 才能点确认。

## 七、验收（要贴实测）

1. `builder` / `reflector` 出现在名册且标「未接入」→ 点接入 → 侧栏出现 Rig / Lens → 能开会话并拿到观测栏数据
2. 新建 `test-01`（空白模板）→ 名册出现 → 能开会话 → 删除 → `~/.hermes/profiles/test-01` 消失、`backups/profiles/test-01-*.tar.gz` 存在 → 从归档恢复到 `test-01-restored`
3. 反例：id 非法 / 重名 / 删 `default` / 删正在跑的 profile → 全部被拒且错误信息说得清
4. `hermes profile create` 失败时不留半成品目录（用 `--clone-from 不存在的名字` 制造失败）
5. 审计文件每次写操作都有一行
6. `npx tsc --noEmit` 通过；构建必须先 `stop elenva-web`（见 elenva-web-maintenance 技能）

## 非目标（v1 不做）

- 不做 profile 改名（Hermes 有 `rename`，但会牵动 gateway 身份与 session 迁移，单独一轮）
- 不做跨机器 profile 同步
- 不做 profile 权限/多用户
- 不代配消息平台凭据
