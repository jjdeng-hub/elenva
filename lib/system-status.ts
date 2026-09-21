/**
 * 系统页数据源：把「发动机舱」信息聚合成一个只读快照。
 *
 * 全部来自本机服务端进程，任何一项读不到就置空，由界面显示「—」：
 *  - 服务：进程自身（uptime / Node 版本 / 构建时注入的版本号）
 *  - 版本对齐：网页内核（本仓库 node_modules 的 SDK）/ 全局 CLI（npm -g 安装处）
 *    / 升级手册记录（docs/pi-upgrade.md）
 *  - 门禁：~/.hermes/elenva-gates-state.json（Hermes cron 每天 09:15 有变更才跑；本页只读，不触发运行）
 *  - 备份：~/backups/pi-hermes-snapshot-*.tgz（Hermes cron 每周日 18:00 生成，轮转保留 4 份）
 *  - 部署：git 最近提交 + .next/BUILD_ID 修改时间（≈ 最近一次构建）
 *  - 资源：磁盘（statfs）/ 内存（os）/ 负载（loadavg）
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SystemStatus {
  service: { appVersion: string | null; uptimeSeconds: number; node: string };
  versions: {
    webKernel: string | null;
    globalCli: string | null;
    docWebKernel: string | null;
    docCli: string | null;
    /** 各处版本一致？（任一缺失 → null「信息不全」） */
    aligned: boolean | null;
  };
  gates: { lastChecked: string | null; lastResult: string | null; when: string | null } | null;
  backup: {
    latest: { name: string; mtime: string; size: number } | null;
    count: number;
    totalBytes: number;
    logLine: string | null;
  };
  deploy: {
    commit: string | null;
    commitTime: string | null;
    commitSubject: string | null;
    buildTime: string | null;
    repo: string;
  };
  resources: {
    disk: { total: number; used: number; avail: number };
    mem: { total: number; free: number };
    load: number[];
    cpuCount: number;
  };
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function packageVersion(file: string): Promise<string | null> {
  const pkg = await readJson<{ version?: string }>(file);
  return typeof pkg?.version === "string" ? pkg.version : null;
}

async function fileMtimeIso(file: string): Promise<string | null> {
  try {
    return (await fs.stat(file)).mtime.toISOString();
  } catch {
    return null;
  }
}

async function lastLine(file: string): Promise<string | null> {
  try {
    const text = (await fs.readFile(file, "utf8")).trim();
    if (!text) return null;
    const lines = text.split("\n");
    return lines[lines.length - 1]?.trim() ?? null;
  } catch {
    return null;
  }
}

/** 全局 npm 安装位置候选（不同安装方式位置不同） */
const GLOBAL_NODE_MODULES = ["/usr/lib/node_modules", "/usr/local/lib/node_modules"];

async function gitInfo(repo: string): Promise<{ commit: string; commitTime: string; commitSubject: string } | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repo, "log", "-1", "--format=%h%x1f%cI%x1f%s"], {
      timeout: 3000,
      maxBuffer: 1024 * 1024,
    });
    const [commit, commitTime, commitSubject] = stdout.trim().split("\x1f");
    if (!commit || !commitTime) return null;
    return { commit, commitTime, commitSubject: commitSubject ?? "" };
  } catch {
    return null;
  }
}

export async function getSystemStatus(): Promise<SystemStatus> {
  const home = os.homedir();
  const repo = process.cwd();

  const [webKernel, cliCandidates, doc, gatesRaw, backupNames, git, buildTime, statsfs] = await Promise.all([
    packageVersion(path.join(repo, "node_modules/@earendil-works/pi-coding-agent/package.json")),
    Promise.all(
      GLOBAL_NODE_MODULES.map((base) => packageVersion(path.join(base, "@earendil-works/pi-coding-agent/package.json"))),
    ),
    fs.readFile(path.join(repo, "docs/pi-upgrade.md"), "utf8").catch(() => ""),
    readJson<{ last_checked?: string; last_result?: string; when?: string }>(
      path.join(home, ".hermes/elenva-gates-state.json"),
    ),
    fs.readdir(path.join(home, "backups")).catch(() => [] as string[]),
    gitInfo(repo),
    fileMtimeIso(path.join(repo, ".next", "BUILD_ID")),
    fs.statfs("/"),
  ]);

  const globalCli = cliCandidates.find((v): v is string => v !== null) ?? null;
  const docWebKernel = /\u7f51\u9875\u5185\u6838 \*\*([0-9][0-9.]*)\*\*/.exec(doc)?.[1] ?? null;
  const docCli = /\u5168\u5c40 CLI \*\*([0-9][0-9.]*)\*\*/.exec(doc)?.[1] ?? null;
  const aligned =
    webKernel && globalCli && docWebKernel && docCli
      ? webKernel === globalCli && webKernel === docWebKernel && globalCli === docCli
      : null;

  const snapshots = (
    await Promise.all(
      backupNames
        .filter((name) => /^pi-hermes-snapshot-.*\.tgz$/.test(name))
        .map(async (name) => {
          try {
            const s = await fs.stat(path.join(home, "backups", name));
            return { name, mtime: s.mtime.toISOString(), size: s.size };
          } catch {
            return null;
          }
        }),
    )
  ).filter((x): x is { name: string; mtime: string; size: number } => x !== null);
  snapshots.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));

  const diskTotal = statsfs.blocks * statsfs.bsize;
  const diskAvail = statsfs.bavail * statsfs.bsize;

  return {
    service: {
      appVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? null,
      uptimeSeconds: Math.round(process.uptime()),
      node: process.version,
    },
    versions: { webKernel, globalCli, docWebKernel, docCli, aligned },
    gates: gatesRaw
      ? {
          lastChecked: gatesRaw.last_checked ?? null,
          lastResult: gatesRaw.last_result ?? null,
          when: gatesRaw.when ?? null,
        }
      : null,
    backup: {
      latest: snapshots[0] ?? null,
      count: snapshots.length,
      totalBytes: snapshots.reduce((sum, s) => sum + s.size, 0),
      logLine: await lastLine(path.join(home, "backups", "backup.log")),
    },
    deploy: {
      commit: git?.commit ?? null,
      commitTime: git?.commitTime ?? null,
      commitSubject: git?.commitSubject ?? null,
      buildTime,
      repo,
    },
    resources: {
      disk: { total: diskTotal, used: diskTotal - diskAvail, avail: diskAvail },
      mem: { total: os.totalmem(), free: os.freemem() },
      load: os.loadavg().map((n) => Math.round(n * 100) / 100),
      cpuCount: os.cpus().length,
    },
  };
}
