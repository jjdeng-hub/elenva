#!/usr/bin/env node
/**
 * 扩展完整性巡检 —— 对 agentDir 下的每个扩展做**静态依赖完整性检查**。
 *
 * ## 为什么要有它（2026-10-19 事故）
 *
 * `elenva-memory` 的入口 `index.ts` 直接 `import ... from "./vendor/pi-hermes-memory/src/index.js"`。
 * 10-17 晚起它的 `vendor/` 目录整个丢失，扩展加载失败（`Cannot find module`）→ 会话工具面
 * 从 17 个掉到 9 个（memory_* / session_search / skill_manage 全没了，web 与 CLI 双侧），
 * 而插件页仍显示「已安装」、系统页与健康巡检全都没发现。本工具把「被引用的文件是否还在」
 * 这件事从**运行期才知道**（加载失败 / 工具变少）提到**静态可巡检**。
 *
 * ## 检查口径
 *
 * · 扫 `<agentDir>/extensions/<name>/` 下所有 `.ts`（含 `vendor/`），抽出**相对 import**
 *   （`from "./x"` / `import("./x")` / `import "./x"` / `require("./x")`）。
 * · 解析 `.js → .ts` 映射（vendor 里源码是 `.ts`，引用写的是 `.js`），并兜底 `.mjs` / `.js` /
 *   `index.*` / `.d.ts`。
 * · 缺任何一项 → 报「扩展名 + 缺失文件 + 引用它的源码位置（file:line）」。
 * · 只认相对路径；`node:*` 与裸包（`typebox`、`@earendil-works/...`）按运行期解析，不在此判。
 * · 只巡 `<extensions>/`；settings.packages 里的 npm 扩展不在范围内（它们的完整性由包管理器保证）。
 *
 * ## 用法 / 接 cron
 *
 *   node tools/extension-integrity-check.mjs                 # agentDir 取 PI_CODING_AGENT_DIR 或 ~/.pi/agent
 *   node tools/extension-integrity-check.mjs /path/to/agent  # 显式指定
 *
 * 退出码：0 = 全 OK；1 = 有扩展缺文件（含 agentDir 不存在这种异常）。
 * 输出：逐扩展一行 `OK/MISS`；最后一行是摘要（便于 cron 抓取与告警）：
 *   `[extension-integrity] agentDir=<...> 扩展 N 个 / 缺失 M 个 / 缺失引用 K 处`
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------- 纯解析（可被自测直载）

/** 去掉块注释与行注释，避免把注释里的 `from "./x"` 当依赖。 */
export function stripComments(code) {
  const withoutBlock = code.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return withoutBlock
    .split("\n")
    .map((line) => {
      let quote = null;
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (quote) {
          if (ch === "\\") i += 1;
          else if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'" || ch === "`") {
          quote = ch;
        } else if (ch === "/" && line[i + 1] === "/") {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join("\n");
}

const SPEC_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g, // import/export ... from "x"
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // 动态 import("x")
  /\bimport\s+["']([^"']+)["']/g, // 副作用 import "x"
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, // require("x")
];

/** 抽出一个源码文件里的相对依赖：`{ spec, line }[]`（同一行多个都会列出）。 */
export function extractRelativeImports(code) {
  const stripped = stripComments(code);
  const lines = stripped.split("\n");
  const out = [];
  lines.forEach((line, idx) => {
    for (const re of SPEC_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        const spec = m[1];
        if (spec.startsWith(".")) out.push({ spec, line: idx + 1 });
      }
    }
  });
  return out;
}

const SOURCE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json"];

/**
 * 把一个相对 specifier 解析到磁盘上的真实文件；解析不到返回 null。
 * `.js` 结尾的引用优先按源码 `.ts` 找（vendor 的源码是 .ts、引用写 .js）。
 */
export function resolveRelativeSpecifier(fromFile, spec, fsImpl = fs) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [];
  const isFile = (p) => {
    try {
      return fsImpl.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  candidates.push(base);
  const extMatch = base.match(/\.(js|mjs|cjs)$/);
  if (extMatch) {
    const stem = base.slice(0, -extMatch[0].length);
    for (const ext of SOURCE_EXTS) candidates.push(stem + ext);
    candidates.push(stem + ".d.ts");
    for (const ext of SOURCE_EXTS) candidates.push(path.join(stem, "index" + ext));
  } else {
    for (const ext of SOURCE_EXTS) candidates.push(base + ext);
    candidates.push(base + ".d.ts");
    for (const ext of SOURCE_EXTS) candidates.push(path.join(base, "index" + ext));
  }
  for (const c of candidates) if (isFile(c)) return c;
  return null;
}

/** 递归收集 `.ts` 文件（跳过 node_modules），键为相对扩展根的路径。 */
export function collectSourceFiles(root, fsImpl = fs) {
  const out = [];
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = fsImpl.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules") continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile() && entry.name.endsWith(".ts")) out.push({ rel, full });
    }
  };
  walk(root, "");
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

/**
 * 巡检一个 agentDir，返回结构化结果（不打印、不退出，便于自测直调）。
 * `{ agentDir, extensions: [{ name, sourceFiles, missing: [{ file, line, spec, resolved }] }] }`
 */
export function checkAgentDir(agentDir, fsImpl = fs, pathImpl = path) {
  const extRoot = pathImpl.join(agentDir, "extensions");
  const result = { agentDir, extensions: [], error: null };
  let names = [];
  try {
    names = fsImpl
      .readdirSync(extRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    result.error = `找不到扩展目录：${extRoot}`;
    return result;
  }
  for (const name of names) {
    const dir = pathImpl.join(extRoot, name);
    const sourceFiles = collectSourceFiles(dir, fsImpl);
    const missing = [];
    for (const file of sourceFiles) {
      let code;
      try {
        code = fsImpl.readFileSync(file.full, "utf8");
      } catch {
        continue;
      }
      for (const { spec, line } of extractRelativeImports(code)) {
        if (!resolveRelativeSpecifier(file.full, spec, fsImpl)) {
          missing.push({ file: file.rel, line, spec });
        }
      }
    }
    result.extensions.push({ name, sourceFiles: sourceFiles.map((f) => f.rel), missing });
  }
  return result;
}

// ---------------------------------------------------------------- CLI

function main() {
  const argDir = process.argv.find((a) => !a.startsWith("-") && a !== process.argv[0] && a !== process.argv[1]);
  const agentDir =
    argDir || process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");

  console.log(`扩展完整性巡检（agentDir=${agentDir}）`);
  const result = checkAgentDir(agentDir);
  if (result.error) {
    console.log(`MISS  ${result.error}`);
    console.log(`[extension-integrity] agentDir=${agentDir} 扩展 0 个 / 缺失 1 个 / 缺失引用 0 处`);
    process.exit(1);
  }

  let missingExt = 0;
  let missingRefs = 0;
  for (const ext of result.extensions) {
    if (ext.missing.length === 0) {
      console.log(`OK    ${ext.name}`);
      continue;
    }
    missingExt += 1;
    missingRefs += ext.missing.length;
    console.log(`MISS  ${ext.name}`);
    for (const m of ext.missing) {
      console.log(`      ✗ ${m.spec}  ← ${m.file}:${m.line}`);
    }
  }
  console.log(
    `[extension-integrity] agentDir=${agentDir} 扩展 ${result.extensions.length} 个 / 缺失 ${missingExt} 个 / 缺失引用 ${missingRefs} 处`,
  );
  process.exit(missingExt > 0 ? 1 : 0);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) main();
