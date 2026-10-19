# elenva-host-guard

给**非 ELENVA 宿主**（CLI 交互会话、飞书守护进程拉起的 `pi --mode rpc` 会话）补的硬护栏，
外加把 ELENVA 身份段同步进 `~/.pi/agent/APPEND_SYSTEM.md` 的受管段。

## 它在补什么

web 的审批闸门长在 ELENVA 进程内（`lib/host-guardrails-extension.ts`），覆盖不到独立 `pi`
进程 —— 那些会话既没有身份段、也没有护栏（pi 的 `docs/security.md` 明说它不会为每次工具
调用征求同意，`-a/--approve` 只管项目信任这一个二元开关）。

| | web（ELENVA 进程内） | CLI / 飞书（独立 pi 进程） |
|---|---|---|
| 身份段 | `lib/host-prompt.ts` → `appendSystemPrompt` | 本扩展的 `sync-identity.mjs` → `APPEND_SYSTEM.md` 受管段 |
| 危险操作 | `host-guardrails-extension` 弹确认卡 / 入队 | 本扩展：入队 + 会话内拒绝 |

## 行为

命中危险操作时（没有交互通道，**不挂起**）：

1. 把这次调用登记到 ELENVA 审批队列
   （`<agentDir>/elenva-pending-approvals.jsonl`，与 web 同一文件、同一字段口径，
   工作台「等你处理」直接看得到）；
2. 在会话内拒绝执行，并把「已登记、别原样重试」一句话回给模型。

判定面与 web `needsApproval(risk, "risky")` 同源：删除类 / 强推 / 装依赖 / 改凭据 /
越界写入，另加 web 里其余不可逆操作（提权 / 关机 / 格式化 / `curl | sh` 等）。
分类表逐条抄自 `lib/tool-risk.ts`，**改那边时回来对齐**（`classify.ts` 顶部有同步点注释）。
现在这条「对齐」有自动差分门兜底：`tools/host-guard-parity-selftest.mjs` 用同一组命令
（覆盖两份表的全部 `ruleKey`，各带命中样例 + 近似反例）在两侧各跑一遍，断言级别映射一致、
`ruleKey` 逐字相同；改坏任一单侧即变红。

> PowerShell 的删除等价物（`Remove-Item` / `ri`，带 `-Recurse` / `-Force`，含
> `powershell -Command '…'` 包装）两侧同源覆盖，`ruleKey` 与 POSIX 的 `bash:rm-force`
> 同族 —— 免确认规则与拒绝记忆跨宿主复用同一段历史。

## 宿主判别（防 web 双闸）

只在**非 ELENVA 宿主**生效。判据是进程级环境变量 `ELENVA_WEB_HOST=1`，由 elenva-web
启动路径写入（`instrumentation.ts` + `lib/agent-runtime.ts`）；独立 `pi` 进程不带它。
SDK 的 `ctx.mode`（web 与 `pi --mode rpc` 同为 `"rpc"`）判不出来，`ctx.hasUI` 也无效 ——
理由与侦察记录见 `host.ts`。

## 环境变量

| 变量 | 含义 |
|---|---|
| `ELENVA_WEB_HOST=1` | elenva-web 写入；本扩展检测到即整体静默 |
| `ELENVA_HOST_GUARD_DISABLE=1` | 人工全局关 |

## 安装

```bash
node extensions/elenva-host-guard/install.mjs              # 装扩展 + 同步身份段受管段
node extensions/elenva-host-guard/install.mjs --no-identity
node extensions/elenva-host-guard/install.mjs --uninstall
```

身份段用 `<!-- elenva-host:begin -->` / `<!-- elenva-host:end -->` 包裹，**只替换段内**：
文件不存在则整文件 = 受管段；无标记但有内容则追加到末尾。段外内容一个字不动。

## 自检

```bash
node extensions/elenva-host-guard/selftest.mjs
# 与 web 侧的双实现判级一致差分门（跨实现映射 + ruleKey 一致）
node tools/host-guard-parity-selftest.mjs
```
