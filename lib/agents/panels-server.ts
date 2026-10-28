/**
 * 面板数据读取（仅服务端）。
 *
 * 边界：面板的 `source` 只能指向**应用包目录内部**的 JSON 文件。
 * 路径先 resolve 再判相对路径，存在时再按 realpath 判一次 —— 防符号链接逃逸。
 * 读不到 / 结构不对都退化成空数据 + 一条 error，不让面板整块消失。
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { normalizePanelData, type AgentPanel, type PanelData } from "./panels";

const MAX_PANEL_BYTES = 256 * 1024;
const MAX_PANELS = 12;

export interface AgentPanelWithData {
  panel: AgentPanel;
  data: PanelData;
  error?: string;
}

/** candidate 是否落在 root 之内（root 自身算之内） */
export function isInsideDir(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function emptyFor(panel: AgentPanel, error?: string): AgentPanelWithData {
  return { panel, data: normalizePanelData(panel.type, null), ...(error ? { error } : {}) };
}

export function readPanelData(agentDir: string, panel: AgentPanel): AgentPanelWithData {
  if (!panel.source) return emptyFor(panel);

  const root = resolve(agentDir);
  const target = resolve(root, panel.source);
  if (!isInsideDir(root, target)) return emptyFor(panel, "source 越出应用包目录");

  try {
    if (!existsSync(target)) return emptyFor(panel, "数据文件不存在");
    const realRoot = realpathSync(root);
    const realTarget = realpathSync(target);
    if (!isInsideDir(realRoot, realTarget)) return emptyFor(panel, "source 越出应用包目录");
    if (statSync(realTarget).size > MAX_PANEL_BYTES) return emptyFor(panel, "数据文件超过 256KB");
    return { panel, data: normalizePanelData(panel.type, JSON.parse(readFileSync(realTarget, "utf8"))) };
  } catch (error) {
    return emptyFor(panel, String(error));
  }
}

export function readAgentPanels(agentDir: string, panels: AgentPanel[]): AgentPanelWithData[] {
  return panels.slice(0, MAX_PANELS).map((panel) => readPanelData(agentDir, panel));
}
