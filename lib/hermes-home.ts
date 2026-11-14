/**
 * Hermes 家目录解析（服务端，只读纯函数）。
 *
 * 为什么不能直接拼 `~/.hermes`：Hermes 在 Windows 上把家目录放在
 * `%LOCALAPPDATA%\hermes` —— 实测 `hermes status` 打印的 auth 文件就是
 * `C:\Users\<user>\AppData\Local\hermes\auth.json`，state.db / config.yaml /
 * profiles/ 也都在那里；`~/.hermes` 只是 POSIX 的默认值。
 *
 * 之前 profile 发现、Agent 资源、管理面令牌、门禁状态四处都硬编码了 `~/.hermes`，
 * 在 Windows 上会全部读空 —— 界面表现就是「一个 Hermes Agent 都没有」。
 *
 * 解析顺序：`HERMES_HOME`（显式覆盖）→ 平台默认（存在则用）→ 其余候选（存在则用）
 * → 平台默认（都不存在时，让后续报错指向正确的位置）。
 * `lib/` 内不 spawn（硬约束），所以只做 `existsSync` 探测，不调 `hermes status`。
 */
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** 候选家目录，按优先级排列；第一项是平台默认值。 */
function hermesHomeCandidates(): string[] {
  const list: string[] = [];
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    if (localAppData) list.push(path.join(localAppData, "hermes"));
  }
  list.push(path.join(os.homedir(), ".hermes"));
  return list;
}

export function hermesHome(): string {
  const override = process.env.HERMES_HOME?.trim();
  if (override) return override;

  const candidates = hermesHomeCandidates();
  for (const dir of candidates) {
    try {
      if (existsSync(dir)) return dir;
    } catch {
      /* 目录不可读，看下一个候选 */
    }
  }
  return candidates[0];
}
