/**
 * Agent 注册表 —— 读盘层（仅服务端）。
 *
 * 目录约定：`ELENVA_AGENTS_DIR`（缺省 `~/.elenva/agents`）下每个子目录是一个应用包，
 * 必含 `manifest.json`。应用包不进本仓库：平台开源，具体 Agent 私有。
 *
 * 读盘失败一律降级为「少一个 Agent + 一条 errors」，不抛给调用方 ——
 * 一个坏包不该让整个工作台打不开。
 */
import fs from "node:fs";
import path from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  mergeAgentRecords,
  parseAgentManifest,
  type AgentRecord,
} from "./manifest";

/**
 * Hermes 运行时可用性（P0 预检，读盘层）。
 *
 * Hermes 是 PATH 上的外部命令，不是 npm 依赖 —— 机器上没装时，Agent 包本身没坏，
 * 只是运行时不可用。这里用 PATH 目录扫描探测（lib/ 内零 spawn，硬约束），
 * 与 bin/acp-host.cjs 的 spawn 级预检各挡一道；两处不一致时，真正起进程的仍是宿主。
 */
export function isHermesInstalled(): boolean {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    try {
      const candidate = join(dir, "hermes");
      if (existsSync(candidate) && statSync(candidate).isFile()) return true;
    } catch {
      /* 目录不可读，跳过 */
    }
  }
  return false;
}

export interface AgentRegistrySnapshot {
  agents: AgentRecord[];
  /** 实际扫描的根目录（便于排错与界面展示） */
  dir: string;
  /** 逐包的失败原因 / id 冲突说明 */
  errors: string[];
}

export function agentsRoot(): string {
  const override = process.env.ELENVA_AGENTS_DIR?.trim();
  return override ? override : join(homedir(), ".elenva", "agents");
}

export function listAgents(): AgentRegistrySnapshot {
  const dir = agentsRoot();
  const packages: AgentRecord[] = [];
  const errors: string[] = [];

  let names: string[] = [];
  try {
    if (existsSync(dir)) {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name);
    }
  } catch (error) {
    errors.push(`读取 agents 目录失败：${String(error)}`);
  }

  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    const dirPath = join(dir, name);
    const manifestPath = join(dirPath, "manifest.json");
    if (!existsSync(manifestPath)) {
      errors.push(`${name}: 缺少 manifest.json`);
      continue;
    }
    try {
      const raw: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
      const parsed = parseAgentManifest(raw, name);
      if (!parsed.ok) {
        errors.push(`${name}: ${parsed.reason}`);
        continue;
      }
      packages.push({ ...parsed.manifest, source: "package", dir: dirPath });
    } catch (error) {
      errors.push(`${name}: ${String(error)}`);
    }
  }

  const { agents, conflicts } = mergeAgentRecords(packages);
  // P0 预检：hermes 不可用只影响对应 Agent 的可用性，不算坏包（不进 errors）
  const hermesReady = isHermesInstalled();
  for (const agent of agents) {
    if (agent.runtime === "hermes") agent.runtimeAvailable = hermesReady;
  }
  return { agents, dir, errors: [...errors, ...conflicts] };
}
