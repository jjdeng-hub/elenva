# ELENVA 管理面：不造通道，接管 Hermes 自带的管理 API

日期：2026-11-13 ｜ 决策：Tom ｜ 实施：Elen ｜ 状态：待批

## 结论先行

上一版方案我写的是「做一个 ELENVA → Hermes 的管理命令通道（白名单 CLI）」。**查完之后推翻**：

Hermes 本身就有一套完整的管理 HTTP API——`hermes serve`（默认 `127.0.0.1:9119`），
源码里 `@app/@router` 注册了 **208 个 `/api/*` 端点**，覆盖：

| 组 | 端点数量 | 例子 |
| --- | --- | --- |
| `/api/cron/*` | 10 | `jobs`、`jobs/{id}/trigger`、`jobs/{id}/pause`、`runs`、`delivery-targets` |
| `/api/profiles/*` | 12 | 列表、创建、删除、导出、导入、active |
| `/api/skills/*` | 3 | 列表、安装/启停/更新 |
| `/api/memory/*` | 5 | 读写、图谱 |
| `/api/tools/*` | 12 | toolset 开关与可见性 |
| `/api/mcp/*` | 9 | 服务器增删改、健康、OAuth |
| `/api/providers/*`、`/api/model*` | 17 | 凭据、模型、fallback |
| `/api/ops/*` | 13 | 备份、日志、诊断、状态 |
| `/api/git/*` | 21 | 仓库状态、diff、提交 |
| `/api/fs/*`、`/api/files/*` | 14 | 文件读写（**不代理**，见安全边界） |
| `/api/messaging/*`、`/api/pairing/*` | 13 | 平台、配对 |
| `/api/webhooks/*` | 4 | 订阅管理 |
| `/api/audio/*` | 8 | TTS/STT |

所以正确做法不是「造一条新通道」，而是**把 Hermes 自己的后端跑起来，ELENVA 做一层受控代理**。
这样能力永远不会落后于 Hermes：它加了什么端点，我们只要放行 + 画界面。

## 架构

```
浏览器 ──▶ ELENVA (Next.js, 30200)
              │  /api/hermes/*        ← 受控代理（服务端）
              │    · 登录态校验（ELENVA 自己的 web-auth）
              │    · 白名单 + 逐路由策略（read / write / confirm）
              │    · 审计写盘 ~/.elenva/audit.jsonl
              │    · 超时 / 重试 / 并发锁 / 结构化错误
              ▼
        hermes serve (127.0.0.1:9119)   ← 只监听回环
              │  cookie 会话（服务端持有，不下发浏览器）
              ▼
        ~/.hermes/（profile 数据、cron、skills、memory…）
```

浏览器永远拿不到 `9119` 的地址，也拿不到 Hermes 的凭据。

## 认证：照抄 Desktop 的做法（已实测通过）

查清楚了：Hermes 的桌面端不是「登录换 cookie」，而是**自己拥有 serve 进程 + 一次性会话令牌**。

- Desktop 起后端时，用一个进程级令牌启动：`HERMES_DASHBOARD_SESSION_TOKEN=<token> hermes serve`
  （SSH 场景走 `--ssh-session-token-file`，同一个变量 `_apply_ssh_session_token` 生效）
- 这个令牌**随进程存活、随进程死亡**，不落任何数据库
- 每个 API 请求带 `X-Hermes-Session-Token: <token>`；缺了就是 401
- 令牌被注入到它自己的 SPA HTML 里，所以只有那个页面能用

**实测（2026-11-13）**：

```
$ HERMES_DASHBOARD_SESSION_TOKEN=probe-… hermes serve --port 9119 --host 127.0.0.1 &
$ curl -H "X-Hermes-Session-Token: probe-…" 'http://127.0.0.1:9119/api/cron/jobs?profile=default'
[{"id":"3944942da0e5","name":"每日AI日报", …}]            # 200，真实任务列表
$ curl 'http://127.0.0.1:9119/api/cron/jobs?profile=default'
{"detail":"Unauthorized"}                                  # 401
```

所以 ELENVA 照抄这一套，不需要密码登录、不需要 cookie jar：

1. ELENVA 拥有 serve 进程：`hermes-serve.service`（systemd user），`Environment=HERMES_DASHBOARD_SESSION_TOKEN=<token>`
2. 令牌存在 `/root/.hermes/.elenva-serve-token`（0600），由 ELENVA 服务端读取；**不下发浏览器**
3. 代理层每个请求带 `X-Hermes-Session-Token`
4. 轮换：重启 serve 时重新生成令牌（ELENVA 侧读文件，不需要重启自己）

安全性质：只监听 `127.0.0.1`；令牌只在本机文件里；拿到令牌仍受代理层白名单约束（浏览器拿不到它）。

## 代理层设计

`app/api/hermes/[...path]/route.ts`：

1. **白名单**：只放行明确列出的路由前缀，其余一律 403。默认拒绝，不默认放行。
2. **方法策略**：每条路由标 `read` / `write`；`write` 必须带 `confirm: true`（由 UI 的二次确认产生），否则 428。
3. **超时**：读 8s、写 30s；`/api/cron/jobs/*/trigger` 与 `/api/ops/*` 允许 120s，走异步 job（返回 jobId）。
4. **并发**：进程内一把写锁，串行化写操作（Hermes 自己也怕并发改 config）。
5. **审计**：每次写操作一行 `{ts, action, path, method, result, ms}`；读操作只记错误。
6. **错误**：统一 `{error: {code, message, detail}}`；透传 Hermes 的 4xx 但要脱敏（去掉绝对路径里的 home 前缀可保留）。
7. **不做透传聚合**：不缓存写结果，读可缓存 2s（UI 轮询时降噪）。

## 第一批放行清单（P0，只做这四个）

| 能力 | 路由 | 方法 | 策略 |
| --- | --- | --- | --- |
| 系统状态 | `/api/health/*`、`/api/ops/status` | GET | read |
| 定时任务列表 | `/api/cron/jobs` | GET | read |
| 定时任务运行记录 | `/api/cron/jobs/{id}/runs` | GET | read |
| 定时任务 建/改/删 | `/api/cron/jobs`、`/api/cron/jobs/{id}` | POST/PATCH/DELETE | write + confirm |
| 立即执行 | `/api/cron/jobs/{id}/trigger` | POST | write + confirm，异步 |
| 暂停/恢复 | `/api/cron/jobs/{id}/pause|resume` | POST | write |
| 技能列表 | `/api/skills` | GET | read |
| 记忆读写 | `/api/memory/*` | GET/POST/PUT | read / write + confirm |

**不放进第一批**：`/api/fs/*`、`/api/files/*`（任意路径读写）、`/api/env*`（含 `/reveal`）、`/api/gateway/*`（会停服务）、`/api/profiles` 的 POST/DELETE（已有自己的实现，避免两套）。

## 界面落点

- 「节律」页从只读变可写：新建（选 type/时间/投递目标/脚本或 prompt）、暂停、立即跑、看最近 5 次运行结果
- 「技能」页：安装（多源）、启用/停用、更新、curator 状态与手动运行
- 「记忆」页：条目的增/删/改、冲突提示（同名条目）
- 「系统」页：Hermes 后端在线状态、版本、profile 列表、serve 进程健康

## 验收

1. `hermes-serve` 起来后，ELENVA「系统」页显示在线 + 版本；停掉服务，页面显示「Hermes 后端未就绪」，不白屏、不 500
2. 节律页：新建一个 `every 1h` 的脚本型 cron → `/root/.hermes/cron/jobs.json` 里真的出现 → 手动 trigger → `runs` 里有记录 → 暂停 → 状态变 paused → 删除 → 文件里消失
3. 技能页：装一个技能 → `~/.hermes/skills/` 出现 → 停用 → 列表状态变 → 卸载
4. 记忆页：改一条 MEMORY 条目 → 文件落盘 → 刷新后仍在
5. 写操作全部有审计行；未确认的写请求返回 428
6. 非白名单路由（例如 `/api/hermes/env/reveal`）返回 403，并且在审计里留一条 denied
7. `npx tsc --noEmit` 通过；构建先 `systemctl --user stop elenva-web`

## 风险与对策

| 风险 | 对策 |
| --- | --- |
| Hermes 升级后端点变了 | 代理层集中一处，改一行；加一个 `/api/hermes/_selftest` 对上表逐条 ping，CI 里跑 |
| serve 常驻吃内存 | 单进程 + 实测 RSS；超 300MB 就改成按需拉起（systemd socket 激活） |
| cookie 过期导致随机失败 | 401 自动重登 + 一次重试；连续两次失败就标记后端不可用 |
| 写操作把用户配置改坏 | 所有写前自动备份目标文件（`.bak-<ts>`），并提供「最近 10 次写操作」可回滚列表 |
| 代理被当成万能后门 | 白名单 + 明确排除 fs/env/gateway；审计留痕；写操作必须 confirm |

## 非目标

- 不做「把 Hermes CLI 全部映射成按钮」
- 不代理任意文件系统读写（代码页以后单独设计）
- 不做多用户权限（ELENVA 仍是单用户 + 密码）
