import { resolve } from "node:path";
import { normalizeSlashes } from "./allowed-roots";
import { isReadOnlyShellCommand } from "./readonly-command";
import { isEditToolName, isWriteToolName, parseMcpToolName } from "./tool-names";

// 计划模式 / 节律 readonly 档共用的只读 shell 判据已经搬到 `./readonly-command`
// （结构化白名单 + 保证范围说明）。这里 re-export，既有导入点（host-guardrails-
// extension）保持不变。
export { isReadOnlyShellCommand } from "./readonly-command";

/**
 * 工具调用的风险分级。
 *
 * 背景：项目信任（ProjectTrust）是二元的 —— 信任项目等于所有工具裸奔，
 * 不信任等于项目资源全部哑火。中间那层「删 30 个文件前先问一句」不存在。
 * 这里补上那层：把一次工具调用判成 safe / guarded / destructive，
 * 由 host-guardrails 扩展在 `tool_call` 钩子里决定要不要弹确认卡。
 *
 * 分级只做「需不需要人过目」的判断，不替代沙箱 —— 它防的是手滑和误伤，
 * 不是恶意代码。
 */

export type ToolRiskLevel = "safe" | "guarded" | "destructive";

export type ApprovalMode = "off" | "risky" | "writes";

export interface ToolRisk {
  level: ToolRiskLevel;
  /** 面向人的一句话：这条操作为什么值得确认 */
  reason: string;
  /** 免确认规则的稳定标识；"总是允许" 时按它落盘 */
  ruleKey: string;
  /** 免确认规则的展示文案 */
  ruleLabel: string;
  /**
   * 在「risky」档位下是否也确认。
   * destructive 一律确认；这里额外标出「可逆但值得看一眼」的一类 ——
   * 安装依赖、npx 拉远程包：它们会在本机执行第三方脚本，用户往往没意识到。
   */
  confirmInRisky?: boolean;
  /**
   * MCP 写操作标记：由 host-guardrails 结合 mcpWriteApproval 开关决定是否弹卡
   * （开关关闭 → 不打扰；开关打开 → 按 confirmInRisky 在 risky 档位弹卡）。
   */
  mcpWrite?: true;
}

export interface ToolRiskContext {
  /** 会话工作目录 */
  cwd: string;
  /** 允许写入的额外根目录（与文件 API 同一套白名单） */
  allowedRoots?: readonly string[];
  /**
   * MCP 工具定义上的 annotations（内核 `getAllTools()` 带回，见 M4R6 调研 §1.1④）。
   * 只对 `mcp__` 工具有意义；取不到时按「没有 annotations」处理。
   */
  mcpAnnotations?: McpToolAnnotations;
}

/**
 * MCP 服务器自报的工具 hints（结构对齐 pi 的 `ToolAnnotations`）。
 * 只利用 `readOnlyHint` / `destructiveHint`：前者明确放宽、后者明确收紧。
 */
export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

const SAFE: ToolRisk = { level: "safe", reason: "", ruleKey: "", ruleLabel: "" };

/** 只读工具：无论什么审批档位都不打扰用户 */
const READ_ONLY_TOOLS = new Set([
  "read", "grep", "find", "ls", "glob", "web_search", "web_fetch", "todo_write", "skill_draft",
]);

/**
 * 需要看参数才能定性的只读工具（扩展 / MCP 之外的记忆类工具）。
 *
 * 背景（模块 3 · 安全修复）：扩展工具原先一律落到 `classifyToolCall` 的默认分支
 * （guarded），于是 `memory_find` / `memory_search` / `memory_status(list)` 这些
 * **纯查询**在「写入」档被要求确认、在计划模式与 readonly 档被直接拦下 —— 勘察类
 * 任务反而没法查记忆。这里按参数明确放行读形式，写动作（invalidate / restore /
 * add / replace / remove）仍走默认的 guarded，不扩大任何写权限。
 */
function isReadOnlyMemoryToolCall(toolName: string, input?: Record<string, unknown>): boolean {
  if (toolName === "memory_find" || toolName === "memory_search" || toolName === "session_search") return true;
  if (toolName === "memory_status") return input?.action === "list";
  return false;
}

/**
 * 这次工具调用是否只读（审批与计划模式/readonly 档共用的**唯一**口径）。
 * 只读 = 不打扰用户、也不被只读档 / 计划模式拦下。
 */
export function isReadOnlyToolCall(toolName: string, input?: Record<string, unknown>): boolean {
  return READ_ONLY_TOOLS.has(toolName) || isReadOnlyMemoryToolCall(toolName, input);
}

interface BashRule {
  /** 命中的命令片段（对拆分后的每个片段单独测试） */
  test: RegExp;
  level: ToolRiskLevel;
  reason: string;
  /** 免确认的粒度：同族命令共用一个 key */
  ruleKey: string;
  ruleLabel: string;
  confirmInRisky?: boolean;
}

function bashRule(
  test: RegExp,
  level: ToolRiskLevel,
  reason: string,
  ruleKey: string,
  ruleLabel: string,
  confirmInRisky = false,
): BashRule {
  return { test, level, reason, ruleKey, ruleLabel, ...(confirmInRisky ? { confirmInRisky } : {}) };
}

/**
 * 破坏性 / 不可逆命令。
 *
 * 判定在「按 && ; | 拆分后的单个片段」上做，避免 `cd x && rm -rf .` 因为
 * 以 cd 开头而漏判；也避免把 `echo "rm -rf"` 里的字面量当成真命令 —— 引号
 * 内的内容不参与拆分，只在片段整体上做正则。
 */
const BASH_RULES: BashRule[] = [
  bashRule(/^rm\b[^|;&]*\s-[a-z]*[rf]/i, "destructive", "递归或强制删除文件", "bash:rm-force", "rm 强制/递归删除"),
  bashRule(/\b(del|erase)\s+(\/[a-z]\s+)*\/[fs]/i, "destructive", "强制删除文件", "bash:rm-force", "rm 强制/递归删除"),
  bashRule(/\brmdir\s+(\/[a-z]\s+)*\/s/i, "destructive", "递归删除目录", "bash:rm-force", "rm 强制/递归删除"),
  bashRule(/\bgit\s+reset\s+--hard\b/i, "destructive", "丢弃工作区与暂存区的全部未提交改动", "bash:git-reset-hard", "git reset --hard"),
  bashRule(/\bgit\s+clean\b[^|;&]*\s-[a-z]*[fdx]/i, "destructive", "删除未跟踪文件/目录", "bash:git-clean", "git clean 清理未跟踪文件"),
  bashRule(/\bgit\s+(checkout|restore)\s+(--\s+)?\.[\s|;&]*$/i, "destructive", "用 HEAD 覆盖工作区全部改动", "bash:git-restore-all", "git checkout/restore 整目录"),
  bashRule(/\bgit\s+branch\s+-D\b/i, "destructive", "强制删除分支", "bash:git-branch-D", "git branch -D 强删分支"),
  bashRule(/\bgit\s+push\b[^|;&]*(\s--force\b|\s--force-with-lease\b|\s-f\b)/i, "destructive", "强制推送会覆盖远端历史", "bash:git-push-force", "git push --force"),
  bashRule(/\bgit\s+commit\b[^|;&]*\s--amend\b/i, "guarded", "改写最近一次提交", "bash:git-amend", "git commit --amend"),
  bashRule(/\b(npm|pnpm|yarn|bun)\s+publish\b/i, "destructive", "发布包到公共 registry，撤回代价高", "bash:publish", "npm publish 发布"),
  bashRule(/\b(mkfs|format\s+[a-z]:|diskpart)\b/i, "destructive", "格式化磁盘", "bash:format", "格式化磁盘"),
  bashRule(/\bdd\s+if=/i, "destructive", "裸写块设备", "bash:dd", "dd 写设备"),
  bashRule(/\b(shutdown|reboot|halt)\b/i, "destructive", "关机/重启本机", "bash:power", "关机/重启"),
  bashRule(/\btaskkill\b[^|;&]*\/f/i, "destructive", "强制结束进程", "bash:kill-force", "强制结束进程"),
  bashRule(/\bkill\s+-9\b/i, "destructive", "强制结束进程", "bash:kill-force", "强制结束进程"),
  bashRule(/\bchmod\s+-R\s+777\b|\bchown\s+-R\b/i, "destructive", "递归改动权限/属主", "bash:chmod-r", "递归改权限"),
  bashRule(/\b(drop\s+(table|database)|truncate\s+table)\b/i, "destructive", "删除数据库对象", "bash:sql-drop", "DROP/TRUNCATE 数据库对象"),
  // curl|sh 的规则在下方 RAW_COMMAND_RULES：拆段后 `|` 已被吃掉，见那里的说明
  bashRule(/\bsudo\b|\brunas\b/i, "destructive", "提权执行", "bash:privilege", "sudo 提权"),
  bashRule(/\b(npm|pnpm|yarn|bun)\s+(i|install|add)\s+(-\w+\s+)*-[gG]\b/i, "guarded", "全局安装会改动本机环境，需要联网", "bash:install-global", "全局安装", true),
  bashRule(/\b(pip|pip3)\s+install\b/i, "guarded", "安装 Python 包会执行构建脚本", "bash:pip-install", "pip install", true),
  bashRule(/\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b/i, "guarded", "改动依赖并执行安装脚本", "bash:install", "安装依赖", true),
  bashRule(/\bgit\s+push\b/i, "guarded", "推送到远端仓库", "bash:git-push", "git push"),
  bashRule(/\bgit\s+(checkout|switch)\s+-[bB]?\b|\bgit\s+branch\s+-m\b/i, "guarded", "切换/新建分支会改动工作区", "bash:git-branch", "切换分支"),
  bashRule(/\b(npx|pnpm dlx|bunx)\b/i, "guarded", "联网下载并执行第三方包", "bash:npx", "npx 执行远端包", true),
];

/** 敏感文件：写它们等于交出凭据或改写仓库元数据 */
const SENSITIVE_PATH_RULES: Array<{ test: RegExp; reason: string; ruleKey: string; ruleLabel: string }> = [
  { test: /(^|\/)\.env(\.[^/]*)?$/i, reason: "环境变量文件通常含密钥", ruleKey: "path:dotenv", ruleLabel: "写入 .env" },
  { test: /(^|\/)auth\.json$/i, reason: "模型凭据文件", ruleKey: "path:auth", ruleLabel: "写入 auth.json" },
  { test: /(^|\/)\.npmrc$/i, reason: "含 registry token", ruleKey: "path:npmrc", ruleLabel: "写入 .npmrc" },
  { test: /(^|\/)(\.ssh|\.aws|\.gnupg)(\/|$)/i, reason: "凭据目录", ruleKey: "path:secrets-dir", ruleLabel: "写入凭据目录" },
  { test: /(^|\/)(id_rsa|id_ed25519|id_ecdsa)(\.pub)?$/i, reason: "SSH 私钥", ruleKey: "path:ssh-key", ruleLabel: "写入 SSH 私钥" },
  { test: /\.(pem|p12|pfx|keystore)$/i, reason: "证书/私钥文件", ruleKey: "path:cert", ruleLabel: "写入证书文件" },
  { test: /(^|\/)\.git(\/|$)/i, reason: "直接改写仓库元数据可能损坏仓库", ruleKey: "path:git-dir", ruleLabel: "写入 .git 目录" },
  { test: /(^|\/)(\.bashrc|\.zshrc|\.bash_profile|\.profile)$/i, reason: "改动用户 shell 启动脚本", ruleKey: "path:shellrc", ruleLabel: "写入 shell 配置" },
];

function splitShellSegments(command: string): string[] {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/**
 * 整串命令上的补充规则（**不拆段**）。
 *
 * 为什么单列一组：`classifyBash` 先按 `&& ; | \n` 拆段、再对每段跑 `BASH_RULES`，
 * 而 `bash:pipe-shell` 的正则要求字面 `|` —— `|` 恰好是分隔符，拆完就再也见不到。
 * 实测（M5R5 报告）：`curl -s URL | sh` 曾判成 safe；`wget -qO- URL | sudo bash`
 * 只因 `sudo` 命中 privilege 才拦。现与 CLI 侧 `elenva-host-guard/classify.ts`
 * 的 `RAW_COMMAND_RULES` 同源：先在**整串原始命令**上判这一组。
 */
const RAW_COMMAND_RULES: BashRule[] = [
  bashRule(/\b(curl|wget|iwr|invoke-webrequest)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|)sh\b/i, "destructive", "把网上下载的脚本直接喂给 shell 执行", "bash:pipe-shell", "curl | sh 执行远端脚本"),
];

function toRisk(rule: BashRule): ToolRisk {
  return {
    level: rule.level,
    reason: rule.reason,
    ruleKey: rule.ruleKey,
    ruleLabel: rule.ruleLabel,
    ...(rule.confirmInRisky ? { confirmInRisky: true } : {}),
  };
}

function classifyBash(command: string): ToolRisk {
  // ① 整串补充规则：需要看穿管道的规则（curl … | sh）在这里判，与 CLI 侧一致
  for (const rule of RAW_COMMAND_RULES) {
    if (rule.test.test(command)) return toRisk(rule);
  }
  const segments = splitShellSegments(command);
  let best: ToolRisk = SAFE;
  for (const segment of segments) {
    for (const rule of BASH_RULES) {
      if (!rule.test.test(segment)) continue;
      const candidate = toRisk(rule);
      if (candidate.level === "destructive") return candidate;
      if (best.level === "safe") best = candidate;
      break;
    }
  }
  return best;
}

function isWithin(candidate: string, root: string): boolean {
  const path = normalizeSlashes(candidate).replace(/\/+$/, "");
  const base = normalizeSlashes(root).replace(/\/+$/, "");
  if (!base) return false;
  return path === base || path.startsWith(`${base}/`);
}

/** 工具参数里的目标路径（write/edit 的 file_path / path） */
export function toolTargetPath(input: Record<string, unknown> | undefined): string | null {
  if (!input) return null;
  const value = input.file_path ?? input.path;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function classifyWrite(toolName: string, input: Record<string, unknown>, ctx: ToolRiskContext): ToolRisk {
  const rawPath = toolTargetPath(input);
  if (!rawPath) return SAFE;
  // 工具参数里的路径可能是相对路径（相对会话 cwd，不是相对服务进程 cwd）
  const normalized = normalizeSlashes(resolve(ctx.cwd, rawPath));
  for (const rule of SENSITIVE_PATH_RULES) {
    if (!rule.test.test(normalized)) continue;
    return { level: "destructive", reason: rule.reason, ruleKey: rule.ruleKey, ruleLabel: rule.ruleLabel };
  }
  const roots = [ctx.cwd, ...(ctx.allowedRoots ?? [])].filter(Boolean).map((root) => normalizeSlashes(resolve(root)));
  if (roots.length > 0 && !roots.some((root) => isWithin(normalized, root))) {
    return {
      level: "guarded",
      reason: "写入会话工作目录之外的文件",
      ruleKey: `path:outside:${normalizeSlashes(resolve(ctx.cwd))}`,
      ruleLabel: "写入工作目录外的文件",
      confirmInRisky: true,
    };
  }
  return {
    level: "guarded",
    reason: toolName === "write" ? "整文件覆盖写入" : "修改已有文件",
    ruleKey: `tool:${toolName}`,
    ruleLabel: "所有文件写入",
  };
}

/**
 * 单次工具调用的风险判定。返回 safe 表示不打扰用户。
 *
 * 注意：`guarded` 在「写入」档位下也要确认；destructive 在任何非 off 档位下都确认。
 */
export function classifyToolCall(
  toolName: string,
  input: Record<string, unknown> | undefined,
  ctx: ToolRiskContext,
): ToolRisk {
  // 只读工具（含按参数放行的记忆查询）在任何档位都不打扰用户
  if (isReadOnlyToolCall(toolName, input)) return SAFE;
  if (toolName === "bash" || toolName === "powershell") {
    const command = typeof input?.command === "string" ? input.command : "";
    if (!command.trim()) return SAFE;
    return classifyBash(command);
  }
  if (isWriteToolName(toolName) || isEditToolName(toolName)) {
    return classifyWrite(toolName, input ?? {}, ctx);
  }
  if (toolName.startsWith("mcp__")) {
    const mcpWrite = classifyMcpWrite(toolName, ctx.mcpAnnotations);
    if (mcpWrite) return mcpWrite;
    // 读类 MCP 工具落到下面的默认分支（不打扰）
  }
  // 自定义/扩展工具默认归到 guarded：它们能干什么不由本模块判断。
  return { level: "guarded", reason: `扩展工具 ${toolName}`, ruleKey: `tool:${toolName}`, ruleLabel: `工具 ${toolName}` };
}

/**
 * MCP 写操作识别：词段启发式 + 服务器 annotations 的**并集兜底**。
 *
 * 判定顺序（annotations 只做「明确放宽 / 明确收紧」，不与词段表互相覆盖）：
 *   ① 词段表命中 → 写操作（词段启发式先行，annotations 不能把它放宽）；
 *   ② 词段未命中但 destructiveHint === true → 明确收紧，按写操作处理；
 *   ③ 词段未命中且 readOnlyHint === true → 明确放宽，返回 safe（任何档位都不弹卡）；
 *   ④ 其余照旧 → null（读类落到默认分支）。
 *
 * 命中写操作时给的是 mcpWrite + confirmInRisky；真正的弹卡还取决于
 * mcpWriteApproval 开关（见 host-guardrails-extension）。
 */
const MCP_WRITE_SEGMENTS = new Set([
  "delete", "clear", "remove", "update", "create", "write", "append", "add", "set",
  "edit", "move", "rename", "copy", "merge", "apply", "sync", "import", "send",
  "post", "publish", "replace", "batch", "upload", "insert", "modify", "put", "patch",
]);

function classifyMcpWrite(toolName: string, annotations?: McpToolAnnotations): ToolRisk | null {
  const parsed = parseMcpToolName(toolName);
  const server = parsed?.server ?? "mcp";
  const tool = parsed?.tool ?? toolName;
  const segments = tool.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const wordHit = segments.some((segment) => MCP_WRITE_SEGMENTS.has(segment));

  if (wordHit) {
    return {
      level: "guarded",
      reason: `MCP 写操作：${server} 的 ${tool}`,
      ruleKey: `mcp-server:${server}`,
      ruleLabel: `MCP ${server} 的写操作`,
      confirmInRisky: true,
      mcpWrite: true,
    };
  }
  // 词段表未命中：destructiveHint 明确收紧（矛盾的 annotations 也以收紧为准）
  if (annotations?.destructiveHint === true) {
    return {
      level: "guarded",
      reason: `MCP 破坏性操作（服务器标注 destructiveHint）：${server} 的 ${tool}`,
      ruleKey: `mcp-server:${server}`,
      ruleLabel: `MCP ${server} 的写操作`,
      confirmInRisky: true,
      mcpWrite: true,
    };
  }
  // readOnlyHint 明确放宽：任何审批档位都不弹卡
  if (annotations?.readOnlyHint === true) return SAFE;
  return null;
}

/** 当前审批档位下，这次调用是否需要人工确认 */
export function needsApproval(risk: ToolRisk, mode: ApprovalMode): boolean {
  if (mode === "off" || risk.level === "safe") return false;
  if (mode === "writes") return true;
  return risk.level === "destructive" || risk.confirmInRisky === true;
}

/** 命中的免确认规则（前缀匹配命令或精确匹配规则 key） */
export function isRuleAllowed(risk: ToolRisk, rules: readonly string[]): boolean {
  if (!risk.ruleKey && !risk.ruleLabel) return false;
  return rules.includes(risk.ruleKey);
}

/**
 * 计划模式下禁止的写入/执行类工具（只允许只读勘察）。
 *
 * 与审批判定共用 `isReadOnlyToolCall`：`memory_find` / `memory_search` /
 * `memory_status(action:"list")` 这类按参数可定的读操作，在计划模式与节律
 * readonly 档里同样放行（调用方要传 input 才能生效）。
 */
export function isPlanModeBlocked(toolName: string, input?: Record<string, unknown>): boolean {
  if (isReadOnlyToolCall(toolName, input)) return false;
  if (toolName === "present_plan" || toolName === "todo_write") return false;
  return true;
}
