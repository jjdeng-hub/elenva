/**
 * elenva-host-guard 的风险分类器（纯函数，不 import 仓库代码、不碰 SDK）。
 *
 * ## 它是什么
 *
 * 给**非 ELENVA 宿主**（CLI / 飞书守护进程拉起的 `pi` 进程）补的那一层硬护栏。
 * 仓库里 `lib/tool-risk.ts` 是 web 侧的同一件事，但扩展是**复制式安装**的
 * （`install.mjs` 把 `*.ts` 拷进 `<agentDir>/extensions/`），所以这里独立实现，
 * 不 import 仓库代码。
 *
 * ## 同步点（改 web 侧口径时必须回来对齐）
 *
 * 口径来源 = `lib/tool-risk.ts` 的 `classifyToolCall` + `needsApproval(risk, "risky")`：
 * 即 **destructive 全部** + **`confirmInRisky` 的那几条 guarded**（装依赖 / npx）。
 * web 的「risky 档位」= 无人值守会话的默认档，正好对应本扩展的处境（没有交互通道）。
 *
 * 五类家族（任务书 B）：删除类 / 强推 / 装依赖 / 改凭据 / 越界写入。
 * 另外把 web 里其余 destructive（提权 / 关机 / 格式化 / 管道执行…）归入 `system`，
 * 免得为了凑「五类」把已登记的雷丢掉。
 *
 * 有意不覆盖：MCP 写操作（web 侧另有 `mcpWriteApproval` 开关，且 CLI 用户自己配的
 * MCP 服务器语义未知，见 `lib/tool-risk.ts:classifyMcpWrite`）。
 */

import { resolve } from "node:path";

export type HostGuardFamily =
  /** 删除类：rm -rf / del / git clean / 删分支 / DROP TABLE … */
  | "delete"
  /** 强推：git push --force / -f / --force-with-lease */
  | "force-push"
  /** 装依赖：npm/pnpm/yarn/bun install、pip install、npx 拉远端包 */
  | "install"
  /** 改凭据：.env / auth.json / .npmrc / .ssh / 私钥 / 证书 */
  | "credential"
  /** 越界写入：写会话工作目录之外的文件 */
  | "outside-write"
  /** 其余不可逆：提权 / 关机 / 格式化 / curl|sh … */
  | "system";

export interface HostGuardRisk {
  level: "safe" | "block";
  /** 面向人的一句话：这条操作为什么值得确认 */
  reason: string;
  /** 免确认规则的稳定标识，与 web 侧 `ToolRisk.ruleKey` 同源 */
  ruleKey: string;
  family: HostGuardFamily | null;
}

export interface HostGuardContext {
  /** 会话工作目录（`ctx.cwd`） */
  cwd: string;
  /** 额外允许写入的根目录（CLI 侧暂无入口，留给以后） */
  allowedRoots?: readonly string[];
}

const SAFE: HostGuardRisk = { level: "safe", reason: "", ruleKey: "", family: null };

/* ── 工具名判定（口径同 lib/tool-names.ts，含 MCP 的装饰形态）────────────── */

export function isShellToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "bash" ||
    name === "shell" ||
    name === "powershell" ||
    name.startsWith("bash_") ||
    name.endsWith(".bash") ||
    name.endsWith("_bash") ||
    name.endsWith("_shell");
}

export function isWriteToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "write" ||
    name.startsWith("write_") ||
    name.endsWith(".write") ||
    name.endsWith("_write");
}

export function isEditToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "edit" ||
    name.startsWith("edit_") ||
    name.endsWith(".edit") ||
    name.endsWith("_edit") ||
    name.includes("str_replace") ||
    name.includes("replace_editor");
}

/** 工具参数里的目标路径（write/edit 的 file_path / path），与 web 侧一致 */
export function toolTargetPath(input: Record<string, unknown> | undefined): string | null {
  if (!input) return null;
  const value = input.file_path ?? input.path;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/* ── shell 规则 ─────────────────────────────────────────────────────────── */

interface ShellRule {
  /** 在「按 && ; | 拆分后的单个片段」上测试（引号内不参与拆分） */
  test: RegExp;
  reason: string;
  ruleKey: string;
  family: HostGuardFamily;
}

const shellRule = (
  test: RegExp,
  reason: string,
  ruleKey: string,
  family: HostGuardFamily,
): ShellRule => ({ test, reason, ruleKey, family });

/**
 * 逐条抄自 `lib/tool-risk.ts` 的 BASH_RULES：
 * 全部 destructive + 带 confirmInRisky 的 guarded（装依赖 / npx）。
 * 少抄的部分（git push 非强推、git commit --amend、git checkout -b）属于
 * web 的普通 guarded —— 在 risky 档也不拦，本扩展照旧放行。
 */
const SHELL_RULES: ShellRule[] = [
  shellRule(/^rm\b[^|;&]*\s-[a-z]*[rf]/i, "递归或强制删除文件", "bash:rm-force", "delete"),
  shellRule(/\b(del|erase)\s+(\/[a-z]\s+)*\/[fs]/i, "强制删除文件", "bash:rm-force", "delete"),
  shellRule(/\brmdir\s+(\/[a-z]\s+)*\/s/i, "递归删除目录", "bash:rm-force", "delete"),
  shellRule(/\bgit\s+reset\s+--hard\b/i, "丢弃工作区与暂存区的全部未提交改动", "bash:git-reset-hard", "delete"),
  shellRule(/\bgit\s+clean\b[^|;&]*\s-[a-z]*[fdx]/i, "删除未跟踪文件/目录", "bash:git-clean", "delete"),
  shellRule(/\bgit\s+(checkout|restore)\s+(--\s+)?\.[\s|;&]*$/i, "用 HEAD 覆盖工作区全部改动", "bash:git-restore-all", "delete"),
  shellRule(/\bgit\s+branch\s+-D\b/i, "强制删除分支", "bash:git-branch-D", "delete"),
  shellRule(/\bgit\s+push\b[^|;&]*(\s--force\b|\s--force-with-lease\b|\s-f\b)/i, "强制推送会覆盖远端历史", "bash:git-push-force", "force-push"),
  shellRule(/\b(npm|pnpm|yarn|bun)\s+publish\b/i, "发布包到公共 registry，撤回代价高", "bash:publish", "system"),
  shellRule(/\b(mkfs|format\s+[a-z]:|diskpart)\b/i, "格式化磁盘", "bash:format", "system"),
  shellRule(/\bdd\s+if=/i, "裸写块设备", "bash:dd", "system"),
  shellRule(/\b(shutdown|reboot|halt)\b/i, "关机/重启本机", "bash:power", "system"),
  shellRule(/\btaskkill\b[^|;&]*\/f/i, "强制结束进程", "bash:kill-force", "system"),
  shellRule(/\bkill\s+-9\b/i, "强制结束进程", "bash:kill-force", "system"),
  shellRule(/\bchmod\s+-R\s+777\b|\bchown\s+-R\b/i, "递归改动权限/属主", "bash:chmod-r", "system"),
  shellRule(/\b(drop\s+(table|database)|truncate\s+table)\b/i, "删除数据库对象", "bash:sql-drop", "delete"),
  // curl|sh 的规则在下方 RAW_COMMAND_RULES：拆段后 `|` 已被吃掉，见那里的说明
  shellRule(/\bsudo\b|\brunas\b/i, "提权执行", "bash:privilege", "system"),
  shellRule(/\b(npm|pnpm|yarn|bun)\s+(i|install|add)\s+(-\w+\s+)*-[gG]\b/i, "全局安装会改动本机环境，需要联网", "bash:install-global", "install"),
  shellRule(/\b(pip|pip3)\s+install\b/i, "安装 Python 包会执行构建脚本", "bash:pip-install", "install"),
  shellRule(/\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b/i, "改动依赖并执行安装脚本", "bash:install", "install"),
  shellRule(/\b(npx|pnpm dlx|bunx)\b/i, "联网下载并执行第三方包", "bash:npx", "install"),
];

function splitShellSegments(command: string): string[] {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/**
 * 整串命令上的补充规则（不拆段）。
 *
 * 为什么要有这一组：web 的 `bash:pipe-shell` 规则排在按 `|` 拆段之后，而 `|` 恰好是
 * 分隔符 —— 规则里的字面 `|` 永远见不到。实测（web 侧 classifyToolCall）：
 *   `curl -s URL | sh` → safe；`wget -qO- URL | sudo bash` 只因 `sudo` 命中 privilege 才拦。
 * 这是**有意偏离 web** 的一处（硬护栏把「下载即执行」放过去说不过去），其余规则逐条同源。
 */
const RAW_COMMAND_RULES: ShellRule[] = [
  shellRule(/\b(curl|wget|iwr|invoke-webrequest)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|)sh\b/i, "把网上下载的脚本直接喂给 shell 执行", "bash:pipe-shell", "system"),
];

/** 命中返回规则，否则 null。destructive 优先（与 web 的「命中即返回」一致）。 */
export function classifyShellCommand(command: string): HostGuardRisk | null {
  for (const rule of RAW_COMMAND_RULES) {
    if (!rule.test.test(command)) continue;
    return { level: "block", reason: rule.reason, ruleKey: rule.ruleKey, family: rule.family };
  }
  for (const segment of splitShellSegments(command)) {
    for (const rule of SHELL_RULES) {
      if (!rule.test.test(segment)) continue;
      return { level: "block", reason: rule.reason, ruleKey: rule.ruleKey, family: rule.family };
    }
  }
  return null;
}

/* ── 敏感文件 ───────────────────────────────────────────────────────────── */

interface SensitiveRule {
  test: RegExp;
  reason: string;
  ruleKey: string;
}

/** 与 `lib/tool-risk.ts:SENSITIVE_PATH_RULES` 同表 */
const SENSITIVE_PATH_RULES: SensitiveRule[] = [
  { test: /(^|\/)\.env(\.[^/]*)?$/i, reason: "环境变量文件通常含密钥", ruleKey: "path:dotenv" },
  { test: /(^|\/)auth\.json$/i, reason: "模型凭据文件", ruleKey: "path:auth" },
  { test: /(^|\/)\.npmrc$/i, reason: "含 registry token", ruleKey: "path:npmrc" },
  { test: /(^|\/)(\.ssh|\.aws|\.gnupg)(\/|$)/i, reason: "凭据目录", ruleKey: "path:secrets-dir" },
  { test: /(^|\/)(id_rsa|id_ed25519|id_ecdsa)(\.pub)?$/i, reason: "SSH 私钥", ruleKey: "path:ssh-key" },
  { test: /\.(pem|p12|pfx|keystore)$/i, reason: "证书/私钥文件", ruleKey: "path:cert" },
  { test: /(^|\/)\.git(\/|$)/i, reason: "直接改写仓库元数据可能损坏仓库", ruleKey: "path:git-dir" },
  { test: /(^|\/)(\.bashrc|\.zshrc|\.bash_profile|\.profile)$/i, reason: "改动用户 shell 启动脚本", ruleKey: "path:shellrc" },
];

/* ── 路径工具 ───────────────────────────────────────────────────────────── */

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function isWithin(candidate: string, root: string): boolean {
  const path = normalizeSlashes(candidate).replace(/\/+$/, "");
  const base = normalizeSlashes(root).replace(/\/+$/, "");
  if (!base) return false;
  return path === base || path.startsWith(`${base}/`);
}

/* ── 入口 ───────────────────────────────────────────────────────────────── */

/**
 * 单次工具调用的判定。`safe` = 放行（不打扰、不入队）。
 *
 * 保守取向与 web 相反但同理：判不准就放行 —— 这里只认「明确不可逆 / 明确越界 /
 * 明确装依赖 / 明确改凭据」四类，宁可漏一条也不要天天误拦。
 */
export function classifyHostToolCall(
  toolName: string,
  input: Record<string, unknown> | undefined,
  ctx: HostGuardContext,
): HostGuardRisk {
  if (isShellToolName(toolName)) {
    const command = typeof input?.command === "string" ? input.command : "";
    if (!command.trim()) return SAFE;
    return classifyShellCommand(command) ?? SAFE;
  }
  if (isWriteToolName(toolName) || isEditToolName(toolName)) {
    const rawPath = toolTargetPath(input);
    if (!rawPath) return SAFE;
    // 工具参数里的路径是相对会话 cwd 解析（与 web 侧同）
    const normalized = normalizeSlashes(resolve(ctx.cwd, rawPath));
    for (const rule of SENSITIVE_PATH_RULES) {
      if (!rule.test.test(normalized)) continue;
      return { level: "block", reason: rule.reason, ruleKey: rule.ruleKey, family: "credential" };
    }
    const roots = [ctx.cwd, ...(ctx.allowedRoots ?? [])]
      .filter(Boolean)
      .map((root) => normalizeSlashes(resolve(root)));
    if (roots.length > 0 && !roots.some((root) => isWithin(normalized, root))) {
      return {
        level: "block",
        reason: "写入会话工作目录之外的文件",
        ruleKey: `path:outside:${normalizeSlashes(resolve(ctx.cwd))}`,
        family: "outside-write",
      };
    }
  }
  return SAFE;
}
