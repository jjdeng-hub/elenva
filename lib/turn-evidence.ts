import type { TurnCommand } from "@/hooks/useTurnCheckpoints";
import { classifyVerificationCommand, type VerificationKind, type VerificationScope } from "./verification-kind";

/**
 * 「验证过没有」的判定与措辞 —— 输入框上方那行与观测栏「本轮」区共用。
 *
 * 判定本身在 lib/verification-kind.ts（与服务端账本同一份实现），这里只做
 * 汇总结论。措辞上守一条线：**单点检查通过不能说成「验证通过」**。
 * agent 说「改完了」和「真的改完了」之间的差距，就体现在这句话上。
 */

export interface TurnCheck {
  command: string;
  kind: VerificationKind;
  scope: VerificationScope;
  failed: boolean | null;
}

export interface TurnEvidenceSummary {
  /** 本轮写入了几个文件（含新建） */
  files: number;
  created: number;
  /** 命令总数与失败数 */
  commands: number;
  failed: number;
  /** 其中属于验证类的 */
  checks: TurnCheck[];
  /** 结论层级：none = 没跑；targeted = 只跑了局部；suite = 跑过整体；failed = 跑了但有失败 */
  level: "none" | "targeted" | "suite" | "failed";
  suiteCommand: string | null;
  targetedCommands: string[];
  /** 一句话结论（已按层级区分措辞） */
  headline: string;
  /**
   * 输入框上方那行用的短句：**不带具体命令**。
   * 命令本身在观测栏「本轮」区逐条可见，塞进这一行只会让它长到读不完 ——
   * 实测 `整体验证通过（node ./node_modules/typescript/bin/tsc --noEmit）` 单句 40+ 字。
   */
  shortHeadline: string;
  tone: "ok" | "warn" | "danger" | "dim";
}

export function summarizeTurn(
  fileCount: number,
  createdCount: number,
  commands: readonly TurnCommand[],
): TurnEvidenceSummary {
  let failed = 0;
  const checks: TurnCheck[] = [];
  const targetedCommands: string[] = [];
  let suiteCommand: string | null = null;

  for (const command of commands) {
    if (command.failed === true) failed += 1;
    const classification = classifyVerificationCommand(command.command);
    if (!classification) continue;
    checks.push({
      command: command.command,
      kind: classification.kind,
      scope: classification.scope,
      failed: command.failed,
    });
    if (command.failed !== true) {
      if (classification.scope === "suite") suiteCommand = command.command;
      else if (!targetedCommands.includes(command.command)) targetedCommands.push(command.command);
    }
  }

  const failedChecks = checks.filter((check) => check.failed === true).length;
  let level: TurnEvidenceSummary["level"] = "none";
  if (failedChecks > 0) level = "failed";
  else if (suiteCommand) level = "suite";
  else if (targetedCommands.length > 0) level = "targeted";

  const headline = (() => {
    switch (level) {
      case "failed":
        return `验证未通过（${checks.length - failedChecks}/${checks.length}）`;
      case "suite":
        return `整体验证通过（${short(suiteCommand ?? "")}）`;
      case "targeted":
        return `仅单点验证（${short(targetedCommands[0] ?? "")}）· 未整体验证`;
      case "none":
        return fileCount > 0 ? "本轮未跑验证 · 结论未经核对" : "本轮没有跑验证";
    }
  })();

  const tone: TurnEvidenceSummary["tone"] = level === "failed"
    ? "danger"
    : level === "suite"
      ? "ok"
      : level === "targeted"
        ? "warn"
        : fileCount > 0
          ? "warn"
          : "dim";

  const shortHeadline = (() => {
    switch (level) {
      case "failed":
        return `验证未通过 ${checks.length - failedChecks}/${checks.length}`;
      case "suite":
        return "整体验证通过";
      case "targeted":
        return "仅单点验证";
      case "none":
        return "未跑验证";
    }
  })();

  return {
    files: fileCount,
    created: createdCount,
    commands: commands.length,
    failed,
    checks,
    level,
    suiteCommand,
    targetedCommands,
    headline,
    shortHeadline,
    tone,
  };
}

function short(command: string, limit = 42): string {
  const trimmed = command.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

export function toneClass(tone: TurnEvidenceSummary["tone"]): string {
  switch (tone) {
    case "ok": return "text-success";
    case "warn": return "text-warn";
    case "danger": return "text-danger";
    case "dim": return "text-dim";
  }
}
