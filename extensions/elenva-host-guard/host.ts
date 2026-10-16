/**
 * 宿主判别：本扩展只服务**非 ELENVA 宿主**（CLI / 飞书守护进程），
 * 在 ELENVA Web 进程里必须整体静默 —— 否则同一条命令会被拦两次
 * （web 的 `createGuardrailsExtension` 已在同进程内跑审批闸门）。
 *
 * ## 判据为什么用环境变量
 *
 * 先侦察过 SDK 的内建信号（`dist/core/extensions/types.d.ts`）：
 * `ctx.mode` = `"tui" | "rpc" | "json" | "print"`，而 ELENVA Web 给扩展绑的正是
 * `mode: "rpc"`（见 `lib/agent-runtime.ts` 的 `bindExtensions` / `setUIContext`）
 * —— 与 `pi --mode rpc` 逐字相同，**判不出来**；`ctx.hasUI` 在 TUI 与 RPC 都为 true，
 * 同样无效。cwd / 会话名被明令禁止用来猜。
 *
 * 所以判据 = 一个**进程级环境变量** `ELENVA_WEB_HOST=1`，由 elenva-web 的启动路径写入：
 *   · `instrumentation.ts`（Next 服务进程启动，进程内所有会话可见）
 *   · `lib/agent-runtime.ts` 的 `startAgentSession`（web 会话创建入口，兜底）
 * 独立 `pi` 进程不会带上它，于是天然落进「需要护栏」的一侧。
 *
 * 优先级：先看 `ELENVA_HOST_GUARD_DISABLE=1`（全局关，人工兜底），再看 web 判别。
 */

/** 由 elenva-web 启动路径写入：`1` = 本进程是 ELENVA Web 宿主 */
export const WEB_HOST_ENV = "ELENVA_WEB_HOST";
/** 人工全局关：`1` = 本扩展整体静默（不注册任何行为） */
export const DISABLE_ENV = "ELENVA_HOST_GUARD_DISABLE";

export type HostGuardDecision = "guard" | "web-host" | "disabled";

export function decideHostGuard(env: NodeJS.ProcessEnv = process.env): HostGuardDecision {
  if (env[DISABLE_ENV] === "1") return "disabled";
  if (env[WEB_HOST_ENV] === "1") return "web-host";
  return "guard";
}

export function shouldHostGuard(env: NodeJS.ProcessEnv = process.env): boolean {
  return decideHostGuard(env) === "guard";
}
