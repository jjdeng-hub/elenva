/**
 * 整理（tidy）的命令行入口 —— 不依赖 pi 会话，可直接对真实记忆跑：
 *
 *   node extensions/elenva-memory/tidy-cli.mjs              # 只报告（默认）
 *   node extensions/elenva-memory/tidy-cli.mjs --apply      # 执行：重复/淘汰条目归档（不删除）
 *   node extensions/elenva-memory/tidy-cli.mjs --cwd <dir>  # 指定项目目录（决定项目记忆读哪一份）
 *
 * 会话里对应的命令是 `/memory-tidy`（同一个实现）。
 */
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, { moduleCache: false, interopDefault: true });

const storesMod = await jiti.import(path.join(HERE, "stores.ts"));
const tidyMod = await jiti.import(path.join(HERE, "tidy.ts"));
const stateMod = await jiti.import(path.join(HERE, "state.ts"));

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const cwdIndex = args.indexOf("--cwd");
const cwd = cwdIndex >= 0 ? args[cwdIndex + 1] : process.cwd();

const set = storesMod.readAllStores(cwd);
const state = stateMod.loadState();

console.log(`记忆根目录：${storesMod.agentRootDir()}`);
console.log(`项目：${set.projectName ?? "（无，当前目录不是项目）"}`);
for (const store of set.stores) {
  const pct = Math.round((store.rawChars / store.limit) * 100);
  console.log(`  ${store.scope.padEnd(8)} ${String(store.entries.length).padStart(3)} 条 / ${String(store.rawChars).padStart(5)} 字符（上限 ${store.limit}，${pct}%）`);
}

const result = tidyMod.runTidy(set, state, { apply });
console.log("");
console.log(tidyMod.renderTidyReport(result));

if (apply) {
  state.tidy = {
    lastRunAt: new Date().toISOString(),
    lastSummary: result.summary,
    report: tidyMod.renderTidyReport(result),
  };
  state.conflicts = result.conflicts;
  stateMod.saveState(state);
  console.log("\n状态已写回 state.json");
}
