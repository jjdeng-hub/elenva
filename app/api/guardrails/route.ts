import { NextResponse } from "next/server";
import {
  addAllowedRule,
  readGuardrailSettings,
  readPlanMode,
  readVerifyCommands,
  removeAllowedRule,
  removeVerifyCommand,
  addVerifyCommand,
  writeApprovalMode,
  writePlanMode,
  writePlanModeDefault,
  writeMcpWriteApproval,
  writeProjectPolicy,
  writeVerificationGuard,
} from "@/lib/guardrail-settings";
import { APPROVAL_MODES, parsePolicyPatch } from "@/lib/guardrail-policy";
import type { ApprovalMode } from "@/lib/tool-risk";

export const dynamic = "force-dynamic";

/**
 * GET /api/guardrails —— 审批档位与免确认规则。
 * `?session=<id>` 时附带该会话的计划模式状态。
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const sessionId = url.searchParams.get("session");
    const cwd = url.searchParams.get("cwd");
    const settings = readGuardrailSettings();
    return NextResponse.json(
      {
        approvalMode: settings.approvalMode,
        planModeDefault: settings.planModeDefault,
        verificationGuard: settings.verificationGuard,
        mcpWriteApproval: settings.mcpWriteApproval,
        /** 全局回落档：项目策略的「继承」要显示当前值，所以一并给出来 */
        approvalFallback: settings.approvalFallback,
        /** 项目级档位覆盖（值为规范化后的 cwd key） */
        policyByProject: settings.policyByProject,
        allowByProject: settings.allowByProject,
        verifyCommandsByProject: settings.verifyCommandsByProject,
        /** 带了 cwd 就直接给该项目的声明列表（服务端规范化 key，界面不用猜写法） */
        ...(cwd ? { verifyCommands: readVerifyCommands(cwd) } : {}),
        planMode: sessionId ? readPlanMode(sessionId) : false,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

/**
 * POST /api/guardrails —— 改动审批档位 / 计划模式 / 免确认规则。
 *
 * 计划模式由会话开启，状态写在设置文件里而不是内存：内核空闲 10 分钟会回收
 * 会话，内存态会丢，而「这个会话在计划模式」应该跟着会话走。
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      mode?: string;
      sessionId?: string;
      enabled?: boolean;
      cwd?: string;
      ruleKey?: string;
      pattern?: string;
      /** 项目策略补丁：键缺省 = 不改，null = 回到继承；整个 policy 为 null = 清除该项目设置 */
      policy?: unknown;
    };

    switch (body.action) {
      case "setApprovalMode": {
        if (!body.mode || !APPROVAL_MODES.includes(body.mode as ApprovalMode)) {
          return NextResponse.json({ error: "未知的审批档位" }, { status: 400 });
        }
        const settings = writeApprovalMode(body.mode as ApprovalMode);
        return NextResponse.json({ approvalMode: settings.approvalMode });
      }
      case "setPlanMode": {
        if (!body.sessionId) {
          return NextResponse.json({ error: "缺少 sessionId" }, { status: 400 });
        }
        const settings = writePlanMode(body.sessionId, body.enabled !== false);
        return NextResponse.json({ planMode: settings.planModeSessions[body.sessionId] === true });
      }
      case "setPlanModeDefault": {
        const settings = writePlanModeDefault(body.enabled === true);
        return NextResponse.json({ planModeDefault: settings.planModeDefault });
      }
      case "setVerificationGuard": {
        const settings = writeVerificationGuard(body.enabled !== false);
        return NextResponse.json({ verificationGuard: settings.verificationGuard });
      }
      case "setMcpWriteApproval": {
        const settings = writeMcpWriteApproval(body.enabled !== false);
        return NextResponse.json({ mcpWriteApproval: settings.mcpWriteApproval });
      }
      case "setProjectPolicy": {
        if (!body.cwd) {
          return NextResponse.json({ error: "缺少 cwd" }, { status: 400 });
        }
        // 写前校验放纯函数里（可被自测穷举）：非法档位直接 400，不静默落盘
        const parsed = parsePolicyPatch(body.policy);
        if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
        const settings = writeProjectPolicy(body.cwd, parsed.patch);
        return NextResponse.json({ policyByProject: settings.policyByProject });
      }
      case "addVerifyCommand": {
        if (!body.cwd || !body.pattern) {
          return NextResponse.json({ error: "缺少 cwd 或 pattern" }, { status: 400 });
        }
        const settings = addVerifyCommand(body.cwd, body.pattern);
        return NextResponse.json({ verifyCommandsByProject: settings.verifyCommandsByProject });
      }
      case "removeVerifyCommand": {
        if (!body.cwd || !body.pattern) {
          return NextResponse.json({ error: "缺少 cwd 或 pattern" }, { status: 400 });
        }
        const settings = removeVerifyCommand(body.cwd, body.pattern);
        return NextResponse.json({ verifyCommandsByProject: settings.verifyCommandsByProject });
      }
      case "removeRule": {
        if (!body.cwd || !body.ruleKey) {
          return NextResponse.json({ error: "缺少 cwd 或 ruleKey" }, { status: 400 });
        }
        const settings = removeAllowedRule(body.cwd, body.ruleKey);
        return NextResponse.json({ allowByProject: settings.allowByProject });
      }
      case "allowRule": {
        if (!body.cwd || !body.ruleKey) {
          return NextResponse.json({ error: "缺少 cwd 或 ruleKey" }, { status: 400 });
        }
        const settings = addAllowedRule(body.cwd, body.ruleKey);
        return NextResponse.json({ allowByProject: settings.allowByProject });
      }
      default:
        return NextResponse.json({ error: "未知操作" }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
