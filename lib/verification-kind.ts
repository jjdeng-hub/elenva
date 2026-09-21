/**
 * 验证命令的识别与分级 —— 纯函数，服务端与浏览器共用。
 *
 * 为什么要单独一个文件：判「这条命令算不算验证、覆盖的是单点还是全量」
 * 既要在服务端写账本，也要在界面层决定措辞（「整体通过」还是「仅单点通过」）。
 * 账本那半边依赖 node:fs，不能进客户端 bundle，所以这里只放无依赖的部分。
 *
 * 两层判定：
 *   1. **已知工具**（内建名单，能分清单点/全量）；
 *   2. **项目声明的命令**（`declaredPatterns`）—— 项目自定义的检查脚本认不出来，
 *      由用户在设置里声明（如 `style-converge`），命中即按「项目检查 / 全量」记。
 *
 * 原则：**认不出来就不算证据**。宁可不说话，也不能把 `npm install`
 * 或者 `git log` 说成「验证通过」。
 *
 * ## 一个已知缺口（2026-09-13 实测踩到）
 *
 * **用管道收尾会伪装退出码**。`tsc --noEmit | head -5` 的退出码是 `head` 的，
 * 不是 tsc 的 —— 真失败也会被记成 ok=true。跑验证别用 `| head` / `| tail` 收尾。
 */

export type VerificationKind = "test" | "lint" | "typecheck" | "build" | "format" | "custom";

/** targeted = 只覆盖显式给出的路径；suite = 覆盖整个项目 */
export type VerificationScope = "targeted" | "suite";

export interface CommandClassification {
  kind: VerificationKind;
  scope: VerificationScope;
  /** targeted 时显式覆盖的路径 */
  targets: string[];
}

/** 全量目标的写法：`.`、`./...`、`*` 之类，出现它们说明命令覆盖整个项目 */
function isWholeProjectTarget(token: string): boolean {
  return token === "." || token === "./" || token === "./..." || token === "..."
    || token === "*" || token === "./*" || token === "**/*";
}

/** 看起来像「具体路径」的参数（npm 脚本的额外参数用它判定 targeted） */
const FILE_LIKE = /(\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|cs|kt|swift|vue|svelte|php|scala|ex|exs)$)|(^\.{1,2}[\\/])|([\\/])/i;

/**
 * 会吃掉下一个 token 的选项 —— `tsc -p tsconfig.json` 里的 tsconfig.json
 * 是配置而不是被检查的目标，当成 target 会把「全量」误判成「单点」。
 */
const FLAGS_WITH_VALUE = new Set([
  "-p", "--project", "-c", "--config", "--tsconfig", "-t", "--target",
  "--reporter", "--max-warnings", "-o", "--outdir", "--output", "--ext",
  "--rulesdir", "--ignore-path", "-w", "--workers", "--root",
]);

/**
 * 位置参数里的子命令动词（`vitest run`、`ruff check src/`）。
 * 只排除**第一个**位置参数，且只排除这几个不太可能是目录名的词 ——
 * 目录叫 build / test / lint 很常见，把它们当动词会让窄检查被说成整体通过。
 */
const SUBCOMMAND_VERBS = new Set(["run", "check", "watch", "ci", "all", "now"]);

/** 解释器包装：`node ./node_modules/typescript/bin/tsc --noEmit` 里的真命令是那个脚本 */
const SCRIPT_HOSTS = new Set(["node", "bun", "deno", "tsx", "ts-node", "ts-node-esm"]);

/** 重定向 / 管道尾过滤之类的 shell 语法，不是路径 */
function isRedirectToken(token: string): boolean {
  return token.includes(">") || token.includes("<") || /^\d*&?$/.test(token) || token.startsWith("&") || token === "2>&1";
}

/** 从脚本路径取可比较的名字：`./node_modules/typescript/bin/tsc` → `tsc` */
function scriptBaseName(script: string): string {
  const file = script.replace(/\\/g, "/").split("/").pop() ?? "";
  return file.replace(/\.(c|m)?[jt]s$/, "").replace(/\.(cmd|bat|exe|sh|ps1)$/, "");
}

/**
 * 命令头的归一化。
 * 对 `bin/` / `.bin/` 里的入口取 basename（`./node_modules/.bin/vitest` → `vitest`）——
 * 这是包管理器装可执行文件的标准位置；其他路径不当工具名，
 * 否则 `./scripts/test-utils` 之类会变成假阳性。
 */
function normalizeHead(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/^\.\//, "").replace(/\.(cmd|bat|exe|sh|ps1)$/, "");
  if (!cleaned.includes("/")) return cleaned;
  return /(^|\/)\.?bin\//.test(cleaned) ? (cleaned.split("/").pop() ?? cleaned) : cleaned;
}

/** 从参数里挑出显式路径；出现全量写法则视为覆盖整个项目 */
function positionalTargets(tokens: string[], strict = false): string[] {
  const out: string[] = [];
  let sawPositional = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (FLAGS_WITH_VALUE.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    // 重定向 / 管道语法不是路径（`tsc --noEmit 2>&1` 里的 `2>&1` 曾被当成 target）
    if (isRedirectToken(token)) continue;
    if (isWholeProjectTarget(token)) return [];
    if (!sawPositional) {
      sawPositional = true;
      if (SUBCOMMAND_VERBS.has(token.toLowerCase())) continue;
    }
    if (strict && !FILE_LIKE.test(token)) continue;
    out.push(token);
  }
  return out;
}

function tokensOf(segment: string): string[] {
  return segment
    .split(/\s+/)
    .map((token) => token.replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

function stripLeadingNoise(tokens: string[]): string[] {
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index += 1;
  if (tokens[index] === "cd") index += 2;
  return tokens.slice(index);
}

const SCRIPT_KINDS: Array<{ test: RegExp; kind: VerificationKind }> = [
  { test: /(^|:)test($|:|-|s\b)/i, kind: "test" },
  { test: /(^|:)spec($|:)/i, kind: "test" },
  { test: /(^|:)e2e($|:)/i, kind: "test" },
  { test: /(^|:)lint($|:)/i, kind: "lint" },
  { test: /(^|:)(typecheck|type-check|types|tsc)($|:)/i, kind: "typecheck" },
  { test: /(^|:)build($|:)/i, kind: "build" },
  { test: /(^|:)format($|:)/i, kind: "format" },
  { test: /(^|:)check($|:)/i, kind: "typecheck" },
];

/** 直接调用的工具 → 种类 */
const TOOL_KINDS: Array<{ test: RegExp; kind: VerificationKind }> = [
  { test: /^(jest|vitest|mocha|ava|tap|pytest|py\.test|nose2|tox|rspec|phpunit|playwright|cypress)$/i, kind: "test" },
  { test: /^(tsc|vue-tsc|tsc-alias|mypy|pyright|ty|flow|svelte-check|astro)$/i, kind: "typecheck" },
  { test: /^(eslint|ruff|flake8|pylint|golangci-lint|clippy|stylelint|htmlhint|biome|oxlint)$/i, kind: "lint" },
  { test: /^(prettier|gofmt|gofumpt|black|isort|rustfmt|dprint|clang-format)$/i, kind: "format" },
  { test: /^(webpack|rollup|esbuild|vite|parcel|next|nuxt)$/i, kind: "build" },
];

/** make 的目标名 → 种类（`make test` 不该被当成 build） */
function makeKind(target: string): VerificationKind {
  if (/test|spec/i.test(target)) return "test";
  if (/lint/i.test(target)) return "lint";
  if (/typecheck|type-check|types\b/i.test(target)) return "typecheck";
  if (/format|fmt/i.test(target)) return "format";
  return "build";
}

/** 展示名：给界面用的一小组中文标签 */
export function verificationKindLabel(kind: VerificationKind): string {
  switch (kind) {
    case "test": return "测试";
    case "lint": return "lint";
    case "typecheck": return "类型检查";
    case "build": return "构建";
    case "format": return "格式";
    case "custom": return "项目检查";
  }
}

/**
 * 判定一条命令是不是验证类命令，以及它覆盖的是单点还是全量。
 * 返回 null 表示「不是验证」。
 */
/**
 * 判定一条命令是不是验证类命令，以及它覆盖的是单点还是全量。
 * 返回 null 表示「不是验证」。
 *
 * `declaredPatterns` 是**项目声明的验证命令片段**（子串匹配，大小写无关）：
 * 已知工具认不出来、但项目自己知道那是检查的脚本（`style-converge`）走这条路。
 * 放在已知工具之后判定 —— 能认出种类时保留更精确的信息（`npm test` 该显示「测试」
 * 而不是笼统的「项目检查」）。
 */
export function classifyVerificationCommand(
  command: string,
  declaredPatterns?: readonly string[],
): CommandClassification | null {
  const precise = classifyWithKnownTools(command);
  if (precise) return precise;
  return classifyByDeclaredPatterns(command, declaredPatterns);
}

function classifyByDeclaredPatterns(
  command: string,
  declaredPatterns?: readonly string[],
): CommandClassification | null {
  if (!declaredPatterns || declaredPatterns.length === 0) return null;
  const haystack = command.toLowerCase();
  for (const pattern of declaredPatterns) {
    const needle = pattern.trim().toLowerCase();
    if (needle && haystack.includes(needle)) {
      // 声明的是「项目的整体检查方式」，所以算全量；细分留给已知工具那条路
      return { kind: "custom", scope: "suite", targets: [] };
    }
  }
  return null;
}

/**
 * 去掉 heredoc 的**内容行**（`cat > x.ts <<'EOF' … EOF`、`python - <<'PY' … PY`）。
 *
 * 为什么必须去：分段解析是逐行的，而 heredoc 里装的是**被写入的源码 / 脚本**。
 * 只要里面出现一行 `node .../tsc --noEmit`，整条命令就会被判成「跑了类型检查」——
 * 而它只是被写进了文件。误判会同时污染界面「本轮」结论、收尾验证门禁与证据账本
 * （三处共用这个判定函数），所以在这里统一剥掉。
 *
 * 保留命令头（`cat > x.ts <<'EOF'` 仍参与解析），只丢弃标记之间的内容与标记行本身。
 */
function stripHeredocBodies(command: string): string {
  const kept: string[] = [];
  let pending: string[] = [];
  for (const line of command.split("\n")) {
    if (pending.length > 0) {
      // 结束标记单独成行；<<- 允许前导 tab
      const marker = line.replace(/^\t+/, "").trim();
      if (pending.includes(marker)) pending = pending.filter((m) => m !== marker);
      continue;
    }
    kept.push(line);
    // <<EOF / <<'EOF' / <<"EOF" / <<-EOF；排除 <<< herestring，且标记后必须是空白或行尾
    // （否则 echo "a << b" 这种字符串也会被当成 heredoc 开启，把后面真实命令吃掉）
    for (const match of line.matchAll(/(?<!<)<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2(?!\S)/g)) {
      pending.push(match[3]);
    }
  }
  return kept.join("\n");
}

function classifyWithKnownTools(command: string): CommandClassification | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  for (const segment of stripHeredocBodies(trimmed).split(/&&|\|\||[;|\n]/)) {
    const tokens = stripLeadingNoise(tokensOf(segment));
    if (tokens.length === 0) continue;
    // ./gradlew、bin/test.cmd 这类带路径的入口
    const head = normalizeHead(tokens[0]);
    const rest = tokens.slice(1);

    // ---- npm / pnpm / yarn / bun ----
    if (head === "npm" || head === "pnpm" || head === "yarn" || head === "bun") {
      let scriptTokens = rest;
      if (rest[0] === "run" || rest[0] === "run-script") scriptTokens = rest.slice(1);
      const script = scriptTokens[0] ?? "";
      const afterScript = scriptTokens.slice(1);

      // 转发型：`npm exec tsc`、`pnpm dlx vitest`、`yarn vitest run`
      // 脚本名可能是路径（`bun ./node_modules/.bin/vitest`）—— 用 basename 比工具名
      const scriptName = scriptBaseName(script);
      if (script === "exec" || script === "dlx" || script === "x") {
        // exec/dlx 自身不是命令，后面那个才是
        const forwarded = classifyVerificationCommand(afterScript.join(" "));
        if (forwarded) return forwarded;
      } else if (TOOL_KINDS.some((entry) => entry.test.test(scriptName))) {
        // 直接调用工具（`yarn vitest run` / `bun ./node_modules/.bin/vitest run`）
        const forwarded = classifyVerificationCommand([script, ...afterScript].join(" "));
        if (forwarded) return forwarded;
      }

      const match = SCRIPT_KINDS.find((entry) => entry.test.test(script));
      if (match) {
        // 脚本名只说明「项目预设了这类检查」；带路径参数才算单点
        const targets = positionalTargets(afterScript, true);
        return { kind: match.kind, scope: targets.length > 0 ? "targeted" : "suite", targets };
      }
      continue;
    }
    if (head === "npx") {
      const forwarded = classifyVerificationCommand(rest.join(" "));
      if (forwarded) return forwarded;
      continue;
    }

    // ---- 子命令型工具 ----
    if (head === "cargo") {
      const sub = rest[0] ?? "";
      if (sub === "test") return { kind: "test", scope: "suite", targets: [] };
      if (sub === "check" || sub === "clippy") return { kind: "lint", scope: "suite", targets: [] };
      if (sub === "build") return { kind: "build", scope: "suite", targets: [] };
      if (sub === "fmt") return { kind: "format", scope: "suite", targets: [] };
      continue;
    }
    if (head === "go") {
      const sub = rest[0] ?? "";
      const kind: VerificationKind | null = sub === "test" ? "test"
        : sub === "vet" ? "lint"
          : sub === "build" ? "build"
            : null;
      if (kind) {
        const targets = positionalTargets(rest.slice(1));
        return { kind, scope: targets.length > 0 ? "targeted" : "suite", targets };
      }
      continue;
    }
    if (head === "dotnet") {
      const sub = rest[0] ?? "";
      if (sub === "test") return { kind: "test", scope: "suite", targets: [] };
      if (sub === "build") return { kind: "build", scope: "suite", targets: [] };
      continue;
    }
    if (head === "gradle" || head === "gradlew" || head === "mvn" || head === "mvnw" || head === "msbuild") {
      const sub = rest.find((token) => !token.startsWith("-")) ?? "";
      if (/test/i.test(sub)) return { kind: "test", scope: "suite", targets: [] };
      if (/lint|check|pmd/i.test(sub)) return { kind: "lint", scope: "suite", targets: [] };
      return { kind: "build", scope: "suite", targets: [] };
    }
    if (head === "make" || head === "cmake") {
      const target = rest.find((token) => !token.startsWith("-")) ?? "";
      return { kind: makeKind(target), scope: "suite", targets: [] };
    }
    if (head === "python" || head === "python3" || head === "uv" || head === "poetry" || head === "pipenv" || head === "pdm") {
      const forwarded = classifyVerificationCommand(rest.join(" ").replace(/^(-m|run)\s+/, ""));
      if (forwarded) return forwarded;
      continue;
    }

    // ---- 解释器包装：`node ./node_modules/typescript/bin/tsc --noEmit` ----
    // 这是本仓库 AGENTS.md 推荐的写法，不认它等于对自家项目永远误报。
    if (SCRIPT_HOSTS.has(head)) {
      const script = rest.find((token) => !token.startsWith("-") && !isRedirectToken(token));
      if (script) {
        const tool = TOOL_KINDS.find((entry) => entry.test.test(scriptBaseName(script)));
        if (tool) {
          const targets = positionalTargets(rest.filter((token) => token !== script));
          return { kind: tool.kind, scope: targets.length > 0 ? "targeted" : "suite", targets };
        }
      }
      continue;
    }

    // ---- 直接工具（tsc / eslint / pytest…）----
    const tool = TOOL_KINDS.find((entry) => entry.test.test(head));
    if (tool) {
      // 直接工具的裸参数几乎都是路径（`eslint src` / `pytest tests/`）
      const targets = positionalTargets(rest);
      return { kind: tool.kind, scope: targets.length > 0 ? "targeted" : "suite", targets };
    }
  }
  return null;
}

/** 路径是否属于「改了也不用跑验证」的散文/数据类文件 */
const NON_CODE_EXTENSIONS = new Set([
  ".md", ".markdown", ".mdx", ".rst", ".txt", ".text", ".adoc", ".asciidoc", ".org", ".log", ".csv", ".tsv",
]);
const NON_CODE_FILENAMES = new Set([
  "license", "licence", "notice", "authors", "contributors", "changelog", "codeowners",
]);

export function isNonCodePath(filePath: string): boolean {
  const name = filePath.replace(/\\/g, "/").split("/").pop() ?? filePath;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : "";
  if (ext && NON_CODE_EXTENSIONS.has(ext)) return true;
  return !ext && NON_CODE_FILENAMES.has(name.toLowerCase());
}

/** 一眼就能认出的检查工具名（逐 token 精确比较，不做子串匹配） */
const COARSE_TOOL_NAMES = new Set([
  "tsc", "vue-tsc", "svelte-check", "jest", "vitest", "mocha", "ava", "tap", "pytest",
  "playwright", "cypress", "eslint", "ruff", "flake8", "pylint", "mypy", "pyright", "clippy",
  "golangci-lint", "stylelint", "oxlint", "biome", "prettier", "gofmt", "gofumpt", "black",
  "isort", "rustfmt", "dprint", "checkstyle", "pmd",
]);
/** 命令名里带这些词根的也算检查（`npm test`、`style-converge.py`、`make audit`） */
const COARSE_CHECK_WORDS = new Set([
  "test", "tests", "testing", "spec", "specs", "lint", "lints", "typecheck", "type-check",
  "types", "build", "check", "checks", "verify", "verification", "audit", "converge",
  "validate", "validation", "vet",
]);

/**
 * 粗判：这条命令看起来是不是一次检查。
 *
 * 它只用于**阻止收尾追问**，不进账本、不算证据（账本要的是能分清单点/全量的精确判定）。
 * 存在的理由是不对称的代价：
 *   · 误追一次 → 用户/agent 不再相信这个门禁，而且会逼着它们去跑「门禁认识的命令」；
 *   · 漏追一次 → 少要一份证据，代价小得多。
 * 所以宁可放宽：精确分类器认不出的项目自定义脚本（`python tools/style-converge.py`
 * 就是活例）也算「跑过检查」，不追。代价是 `cp test.ts b.ts` 这类也会被当成检查 —— 接受。
 *
 * 实现上逐 token 看（而不是整串正则）：`node ./node_modules/typescript/bin/tsc` 里的工具名
 * 在路径末尾，用正则很容易被 `\S+` 吃掉；取 basename 再拆词根就稳了。
 */
export function looksLikeCheck(command: string): boolean {
  for (const rawToken of command.split(/[\s;&|()<>]+/)) {
    const token = rawToken.replace(/^['"]+|['"]+$/g, "");
    if (!token) continue;
    const base = (token.replace(/\\/g, "/").split("/").pop() ?? "")
      .replace(/\.(c|m)?[jt]sx?$/, "")
      .replace(/\.(exe|cmd|bat|sh|ps1|py|rb|pl)$/, "")
      .toLowerCase();
    if (COARSE_TOOL_NAMES.has(base)) return true;
    for (const part of base.split(/[-_:.+]+/)) {
      if (COARSE_CHECK_WORDS.has(part)) return true;
    }
  }
  return false;
}
