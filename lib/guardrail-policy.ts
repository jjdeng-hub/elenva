import type { ApprovalMode } from "./tool-risk";

/**
 * 项目级审批策略（模块 5 · 第 2 轮）：解析「项目 > 全局」。
 *
 * 为什么单独一个**纯**模块：审批判定是安全相关的，继承规则必须能被穷举验证 ——
 * 这个文件不读盘、不认识 fs、不认识平台，输入输出全在参数里。落盘与 cwd 的
 * key 规范化留在 `guardrail-settings.ts`（那里才有 fs）。它也因此在客户端可用
 * （设置页只取类型），不会把 `node:*` 带进浏览器包。
 *
 * 语义边界（与现状等价的那条）：**没有命中项目配置时，三个键必须逐字节等于
 * 全局值** —— 不是「等于默认值」，也不是「重新算一遍」。所以下面的回落是
 * `?? settings.xxx` 的直接取用，不做任何归一化。
 */

export type ApprovalFallback = "reject" | "queue";

export const APPROVAL_MODES: readonly ApprovalMode[] = ["off", "risky", "writes"];
export const APPROVAL_FALLBACKS: readonly ApprovalFallback[] = ["reject", "queue"];

/** 三个可被项目覆盖的键；`null` 在补丁里表示「回到继承」 */
export const POLICY_KEYS = ["approvalMode", "approvalFallback", "mcpWriteApproval"] as const;

/** 单个项目的策略覆盖：键缺省 = 继承全局（不是「关掉」） */
export interface ProjectPolicy {
  approvalMode?: ApprovalMode;
  approvalFallback?: ApprovalFallback;
  mcpWriteApproval?: boolean;
}

/** 来自界面 / API 的补丁：`null` 表示显式清除该键（回到继承） */
export interface ProjectPolicyPatch {
  approvalMode?: ApprovalMode | null;
  approvalFallback?: ApprovalFallback | null;
  mcpWriteApproval?: boolean | null;
}

/**
 * `resolvePolicy` 的输入：结构上只要含全局三键 + 项目表即可。
 * `GuardrailSettings` 天然满足（不用 import 它，避免把 fs 侧拖进来）。
 */
export interface PolicySource {
  approvalMode: ApprovalMode;
  approvalFallback: ApprovalFallback;
  mcpWriteApproval: boolean;
  policyByProject?: Record<string, ProjectPolicy> | undefined;
}

export interface ResolvedPolicy {
  approvalMode: ApprovalMode;
  approvalFallback: ApprovalFallback;
  mcpWriteApproval: boolean;
  /** 命中的项目 key；没命中为 null（此时三键严格等于全局值） */
  projectKey: string | null;
}

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === "string" && (APPROVAL_MODES as readonly string[]).includes(value);
}

export function isApprovalFallback(value: unknown): value is ApprovalFallback {
  return typeof value === "string" && (APPROVAL_FALLBACKS as readonly string[]).includes(value);
}

/**
 * 单条项目策略的解析：非法值**逐键丢弃**（读盘容错，手写的设置文件不该让会话起不来）；
 * 一个合法键都没有时返回 null（等同「没有这条配置」）。
 */
export function parseProjectPolicy(value: unknown): ProjectPolicy | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const policy: ProjectPolicy = {};
  if (isApprovalMode(raw.approvalMode)) policy.approvalMode = raw.approvalMode;
  if (isApprovalFallback(raw.approvalFallback)) policy.approvalFallback = raw.approvalFallback;
  if (typeof raw.mcpWriteApproval === "boolean") policy.mcpWriteApproval = raw.mcpWriteApproval;
  return POLICY_KEYS.some((key) => policy[key] !== undefined) ? policy : null;
}

/** 整表解析：坏值 / 空对象 / 空 key 一并忽略 */
export function parsePolicyByProject(value: unknown): Record<string, ProjectPolicy> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, ProjectPolicy> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!key) continue;
    const policy = parseProjectPolicy(raw);
    if (policy) out[key] = policy;
  }
  return out;
}

export type PolicyPatchResult =
  | { ok: true; patch: ProjectPolicyPatch | null }
  | { ok: false; error: string };

/**
 * 校验一份来自界面的补丁（写前校验）。与读盘相反，这里**非法值直接报错** ——
 * 界面传错是 bug，静默吞掉会让人以为「设置生效了」。
 *
 * 关键约定：`null` 必须**原样传下去**（`patch[键] = null`），它在下游的意思是
 * 「这个键回到继承」。早期实现把「键存在但值为 null」当成「没传」跳过，结果
 * `writeProjectPolicy` 收到空补丁 `{}` → 什么都不删 → 选择器看着变回「继承」了、
 * 落盘的值还在，刷新后原样回来。（整条 null 另当别论 = 清除该项目设置。）
 */
export function parsePolicyPatch(value: unknown): PolicyPatchResult {
  if (value === null) return { ok: true, patch: null };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "策略必须是对象或 null" };
  }
  const raw = value as Record<string, unknown>;
  const patch: ProjectPolicyPatch = {};
  if ("approvalMode" in raw) {
    const next = raw.approvalMode;
    if (next === null) patch.approvalMode = null;
    else if (isApprovalMode(next)) patch.approvalMode = next;
    else return { ok: false, error: "未知的审批档位" };
  }
  if ("approvalFallback" in raw) {
    const next = raw.approvalFallback;
    if (next === null) patch.approvalFallback = null;
    else if (isApprovalFallback(next)) patch.approvalFallback = next;
    else return { ok: false, error: "未知的无人值守策略" };
  }
  if ("mcpWriteApproval" in raw) {
    const next = raw.mcpWriteApproval;
    if (next === null) patch.mcpWriteApproval = null;
    else if (typeof next === "boolean") patch.mcpWriteApproval = next;
    else return { ok: false, error: "MCP 写确认必须是布尔值" };
  }
  return { ok: true, patch };
}

/**
 * 只用于比较的宽松 key：统一分隔符 + 去尾斜杠 + 去空白。
 * **不改大小写** —— 精确匹配优先，大小写无关只在后面当兜底（Linux 的路径大小写敏感，
 * 先小写化会把 `/root/A` 和 `/root/a` 认成同一个目录，那意味着策略串台）。
 */
export function policyPathKey(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

export interface KeyMatchOptions {
  /**
   * key 比较是否忽略大小写。**必须由调用方按平台显式决定**：
   * Windows 的 `cwdKey` 落盘时会把盘符与路径小写化，而运行时 cwd 带着原始大小写，
   * 所以那边必须开；Linux 上必须关 —— `/Home` 与 `/home` 是两个不同的目录，
   * 忽略大小写等于把一个项目的档位套到另一个项目头上。
   * 纯函数自己不读 `process.platform`（那会把平台差异藏进解析层）。
   */
  caseInsensitiveKeys?: boolean;
}

/**
 * 找到 cwd 对应的项目策略。
 * 先精确匹配，再（仅在调用方开了 `caseInsensitiveKeys` 时）大小写无关兜底。
 */
export function findProjectPolicy(
  policyByProject: Record<string, ProjectPolicy> | undefined,
  cwd: string,
  options: KeyMatchOptions = {},
): { key: string; policy: ProjectPolicy } | null {
  if (!policyByProject) return null;
  const wanted = policyPathKey(cwd);
  if (!wanted) return null;
  const exact = policyByProject[wanted];
  if (exact) return { key: wanted, policy: exact };
  if (!options.caseInsensitiveKeys) return null;
  const lower = wanted.toLowerCase();
  for (const [key, policy] of Object.entries(policyByProject)) {
    if (policyPathKey(key).toLowerCase() === lower) return { key, policy };
  }
  return null;
}

/**
 * 解析某个 cwd 生效的审批策略：项目值 > 全局值，三键各自独立继承。
 * 未命中 / 命中但值非法 → 三个键原样取全局（与不做项目策略时**逐字节一致**）。
 */
export function resolvePolicy(
  settings: PolicySource,
  cwd: string,
  options: KeyMatchOptions = {},
): ResolvedPolicy {
  const hit = findProjectPolicy(settings.policyByProject, cwd, options);
  const policy = hit ? parseProjectPolicy(hit.policy) : null;
  return {
    approvalMode: policy?.approvalMode ?? settings.approvalMode,
    approvalFallback: policy?.approvalFallback ?? settings.approvalFallback,
    mcpWriteApproval: policy?.mcpWriteApproval ?? settings.mcpWriteApproval,
    projectKey: policy ? hit!.key : null,
  };
}
